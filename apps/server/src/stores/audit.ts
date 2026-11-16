/**
 * The audit log (S2-12): a hash-chained table of what was decided and changed.
 *
 * Each row stores the hash of the row before it (`prev_hash`) and its own hash
 * over its fields, so editing, removing or inserting a row breaks the chain
 * and `agni audit verify` says where. A separate anchor (`meta.audit.head`,
 * written in the same transaction as the newest row) also catches rows cut off
 * the end. This makes tampering evident to anyone who runs the check; it does
 * not stop someone who can write the database from rebuilding the whole chain.
 *
 * Implements the frozen `AuditSink` from `policy/audit-sink.ts`. A write that
 * fails throws, so a caller that must not lose its row stops (fail closed).
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { setAuditSink, type AuditEvent, type AuditSink } from "../policy/audit-sink";
import { redact } from "../util/redact";
import { newID, nowISO } from "../util/ids";

export const GENESIS_HASH = "0".repeat(64);
const ANCHOR_KEY = "audit.head";
/** A detail longer than this (as JSON) is replaced by a short note, so one event cannot bloat the log. */
const MAX_DETAIL_CHARS = 16_000;

export interface AuditHashFields {
  id: string;
  at: string;
  kind: string;
  actor: string | null;
  turnID: string | null;
  jobID: string | null;
  /** The stored canonical JSON text. */
  detail: string;
}

/** The hash of a row: the previous hash and every field, in a fixed order, as JSON. */
export function computeAuditHash(prevHash: string, fields: AuditHashFields): string {
  const body = JSON.stringify([fields.id, fields.at, fields.kind, fields.actor, fields.turnID, fields.jobID, fields.detail]);
  return createHash("sha256").update(prevHash).update("\n").update(body).digest("hex");
}

/** JSON with object keys sorted at every level, so equal details give equal text. */
function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? "null";
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]));
  }
  return value;
}

/** The detail as stored: canonical, redacted, and bounded. Never throws. */
function detailText(detail: Record<string, unknown>): string {
  let text: string;
  try {
    text = redact(canonical(detail));
  } catch {
    return canonical({ unserialisable: true });
  }
  if (text.length <= MAX_DETAIL_CHARS) return text;
  return canonical({ truncated: true, chars: text.length, preview: text.slice(0, 2_000) });
}

export class SqliteAuditSink implements AuditSink {
  constructor(private readonly db: Database) {}

  record(event: AuditEvent): void {
    const { db } = this;
    const id = newID("aud");
    const at = nowISO();
    const detail = detailText(event.detail);
    // IMMEDIATE: the tail is read and the next row written under one write lock, so the daemon and a
    // CLI appending at the same moment cannot both extend the same row.
    db.transaction(() => {
      const tail = db.query<{ hash: string }, []>("SELECT hash FROM audit_events ORDER BY seq DESC LIMIT 1").get();
      const prevHash = tail?.hash ?? GENESIS_HASH;
      const fields: AuditHashFields = { id, at, kind: event.kind, actor: event.actor ?? null, turnID: event.turnID ?? null, jobID: event.jobID ?? null, detail };
      const hash = computeAuditHash(prevHash, fields);
      const inserted = db.run(
        "INSERT INTO audit_events (id, at, kind, actor, turn_id, job_id, detail, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [id, at, event.kind, fields.actor, fields.turnID, fields.jobID, detail, prevHash, hash],
      );
      db.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [ANCHOR_KEY, `${Number(inserted.lastInsertRowid)}:${hash}`]);
    }).immediate();
  }
}

/** Make `audit()` write to this database. Safe to call again with another database. */
export function installAuditSink(db: Database): void {
  setAuditSink(new SqliteAuditSink(db));
}

/** `seq:hash` of the newest row as the anchor last recorded it, or null before the first event. */
export function auditHeadAnchor(db: Database): string | null {
  return db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(ANCHOR_KEY)?.value ?? null;
}

export type AuditVerdict =
  | { ok: true; events: number; head: string | null }
  | { ok: false; events: number; brokenAt: number | null; reason: string };

interface ChainRow {
  seq: number;
  id: string;
  at: string;
  kind: string;
  actor: string | null;
  turn_id: string | null;
  job_id: string | null;
  detail: string;
  prev_hash: string;
  hash: string;
}

const COLUMNS = "seq, id, at, kind, actor, turn_id, job_id, detail, prev_hash, hash";

/** Walk the whole chain. The first row that does not fit is reported by its `seq`. */
export function verifyAuditChain(db: Database): AuditVerdict {
  let prev = GENESIS_HASH;
  let events = 0;
  let last: ChainRow | null = null;
  for (const row of db.query<ChainRow, []>(`SELECT ${COLUMNS} FROM audit_events ORDER BY seq`).iterate()) {
    events += 1;
    if (row.prev_hash !== prev) {
      return { ok: false, events, brokenAt: row.seq, reason: `row ${row.seq} does not follow the row before it (a row was removed, added or changed)` };
    }
    const expected = computeAuditHash(row.prev_hash, { id: row.id, at: row.at, kind: row.kind, actor: row.actor, turnID: row.turn_id, jobID: row.job_id, detail: row.detail });
    if (expected !== row.hash) {
      return { ok: false, events, brokenAt: row.seq, reason: `row ${row.seq} hash does not match its contents (the row was changed)` };
    }
    prev = row.hash;
    last = row;
  }
  const anchor = auditHeadAnchor(db);
  if (last === null) {
    if (anchor !== null) return { ok: false, events, brokenAt: null, reason: "the log is empty but rows were recorded (rows were cut off the end)" };
    return { ok: true, events: 0, head: null };
  }
  if (anchor !== `${last.seq}:${last.hash}`) {
    return { ok: false, events, brokenAt: last.seq, reason: "the newest row does not match the recorded end of the log (rows were cut off the end, or the anchor was changed)" };
  }
  return { ok: true, events, head: last.hash };
}

export interface AuditEventRow {
  seq: number;
  id: string;
  at: string;
  kind: string;
  actor: string | null;
  turnID: string | null;
  jobID: string | null;
  detail: Record<string, unknown>;
}

function parseDetail(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { unreadable: true };
  }
}

/** Newest first. */
export function listAuditEvents(db: Database, options: { limit?: number; kind?: string } = {}): AuditEventRow[] {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 1_000));
  const rows = options.kind === undefined
    ? db.query<ChainRow, [number]>(`SELECT ${COLUMNS} FROM audit_events ORDER BY seq DESC LIMIT ?`).all(limit)
    : db.query<ChainRow, [string, number]>(`SELECT ${COLUMNS} FROM audit_events WHERE kind = ? ORDER BY seq DESC LIMIT ?`).all(options.kind, limit);
  return rows.map((row) => ({
    seq: row.seq, id: row.id, at: row.at, kind: row.kind, actor: row.actor, turnID: row.turn_id, jobID: row.job_id, detail: parseDetail(row.detail),
  }));
}
