/**
 * S2-12: a hash-chained audit log. Every row carries the hash of the row
 * before it, so changing, removing or inserting a row is found by
 * `agni audit verify`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db";
import { audit, setAuditSink } from "../src/policy/audit-sink";
import { SqliteAuditSink, auditHeadAnchor, computeAuditHash, installAuditSink, listAuditEvents, verifyAuditChain } from "../src/stores/audit";
import { startupS2Audit } from "../src/startup/s2-audit";
import { stopPauseWatcher } from "../src/startup/s2-audit";
import { isRunPaused, setAllPaused, unbindPauseStore } from "../src/policy/pause";

let db: Database;
let sink: SqliteAuditSink;

beforeEach(() => {
  db = openDatabase(":memory:");
  sink = new SqliteAuditSink(db);
});

afterEach(() => {
  setAuditSink({ record() {} });
  stopPauseWatcher();
  unbindPauseStore();
  db.close();
});

function seed(count: number): void {
  for (let i = 0; i < count; i += 1) {
    sink.record({ kind: i % 2 === 0 ? "approval.decided" : "config.changed", actor: "device_1", turnID: `trn_${i}`, detail: { n: i, note: "x".repeat(i) } });
  }
}

describe("the chain", () => {
  test("an empty log verifies", () => {
    expect(verifyAuditChain(db)).toMatchObject({ ok: true, events: 0 });
  });

  test("a log of events verifies and reports how many", () => {
    seed(5);
    expect(verifyAuditChain(db)).toMatchObject({ ok: true, events: 5 });
  });

  test("each row carries the hash of the one before; the first carries the all-zero genesis", () => {
    seed(3);
    const rows = db.query<{ prev_hash: string; hash: string }, []>("SELECT prev_hash, hash FROM audit_events ORDER BY seq").all();
    expect(rows[0]!.prev_hash).toBe("0".repeat(64));
    expect(rows[1]!.prev_hash).toBe(rows[0]!.hash);
    expect(rows[2]!.prev_hash).toBe(rows[1]!.hash);
    expect(new Set(rows.map((row) => row.hash)).size).toBe(3);
  });

  test("flipping one byte of a stored detail fails verification and names the row", () => {
    seed(6);
    const target = db.query<{ seq: number; detail: string }, []>("SELECT seq, detail FROM audit_events WHERE seq = 3").get()!;
    const flipped = `${target.detail.slice(0, -2)}${target.detail.slice(-2, -1) === "}" ? "{" : "}"}${target.detail.slice(-1)}`;
    db.run("UPDATE audit_events SET detail = ? WHERE seq = 3", [flipped]);
    const result = verifyAuditChain(db);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.brokenAt).toBe(3);
      expect(result.reason).toContain("hash");
    }
  });

  test("changing a kind, an actor or a time fails verification", () => {
    for (const [column, value] of [["kind", "approval.denied"], ["actor", "someone_else"], ["at", "2020-01-01T00:00:00.000Z"]] as const) {
      const fresh = openDatabase(":memory:");
      const local = new SqliteAuditSink(fresh);
      for (let i = 0; i < 4; i += 1) local.record({ kind: "k", actor: "a", detail: { i } });
      fresh.run(`UPDATE audit_events SET ${column} = ? WHERE seq = 2`, [value]);
      expect(verifyAuditChain(fresh).ok).toBe(false);
      fresh.close();
    }
  });

  test("removing a row from the middle fails verification", () => {
    seed(5);
    db.run("DELETE FROM audit_events WHERE seq = 3");
    const result = verifyAuditChain(db);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.brokenAt).toBe(4);
  });

  test("cutting rows off the end fails verification", () => {
    seed(5);
    db.run("DELETE FROM audit_events WHERE seq > 3");
    const result = verifyAuditChain(db);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("end");
  });

  test("a row rewritten with its hash recomputed still breaks the next link", () => {
    seed(4);
    const row = db.query<{ id: string; at: string; actor: string | null; turn_id: string | null; job_id: string | null; detail: string; prev_hash: string }, []>("SELECT id, at, actor, turn_id, job_id, detail, prev_hash FROM audit_events WHERE seq = 2").get()!;
    const hash = computeAuditHash(row.prev_hash, { id: row.id, at: row.at, kind: "approval.denied", actor: row.actor, turnID: row.turn_id, jobID: row.job_id, detail: row.detail });
    db.run("UPDATE audit_events SET kind = ?, hash = ? WHERE seq = 2", ["approval.denied", hash]);
    const result = verifyAuditChain(db);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.brokenAt).toBe(3);
  });

  test("two connections appending to one file keep one valid chain", () => {
    const dir = mkdtempSync(join(tmpdir(), "agni-s2-audit-"));
    try {
      const path = join(dir, "agni.db");
      const first = openDatabase(path);
      const second = openDatabase(path);
      const a = new SqliteAuditSink(first);
      const b = new SqliteAuditSink(second);
      for (let i = 0; i < 10; i += 1) (i % 2 === 0 ? a : b).record({ kind: "k", detail: { i } });
      expect(verifyAuditChain(first)).toMatchObject({ ok: true, events: 10 });
      first.close();
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the anchor names the newest row", () => {
    seed(3);
    const head = db.query<{ seq: number; hash: string }, []>("SELECT seq, hash FROM audit_events ORDER BY seq DESC LIMIT 1").get()!;
    expect(auditHeadAnchor(db)).toBe(`${head.seq}:${head.hash}`);
  });
});

describe("what is stored", () => {
  test("the event's own fields are kept, details as canonical JSON", () => {
    sink.record({ kind: "approval.decided", actor: "device_9", turnID: "trn_1", jobID: "job_2", detail: { b: 1, a: { d: 2, c: 3 } } });
    const [event] = listAuditEvents(db, { limit: 5 });
    expect(event).toMatchObject({ kind: "approval.decided", actor: "device_9", turnID: "trn_1", jobID: "job_2", detail: { a: { c: 3, d: 2 }, b: 1 } });
    const raw = db.query<{ detail: string }, []>("SELECT detail FROM audit_events").get()!;
    expect(raw.detail).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  test("an oversized detail is cut and says so, and the log still verifies", () => {
    sink.record({ kind: "tool.call", detail: { text: "y".repeat(100_000) } });
    const [event] = listAuditEvents(db, { limit: 1 });
    expect(event!.detail).toMatchObject({ truncated: true });
    expect(JSON.stringify(event!.detail).length).toBeLessThan(20_000);
    expect(verifyAuditChain(db).ok).toBe(true);
  });

  test("a detail that cannot be serialised is recorded as a note, never dropped", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    sink.record({ kind: "tool.call", detail: cyclic });
    expect(listAuditEvents(db, { limit: 1 })[0]!.detail).toMatchObject({ unserialisable: true });
  });

  test("events list newest first and can be filtered by kind", () => {
    seed(4);
    expect(listAuditEvents(db, { limit: 10 }).map((event) => event.seq)).toEqual([4, 3, 2, 1]);
    expect(listAuditEvents(db, { limit: 10, kind: "config.changed" }).map((event) => event.seq)).toEqual([4, 2]);
  });
});

describe("the sink in place", () => {
  test("installAuditSink makes audit() write to the database", () => {
    installAuditSink(db);
    audit({ kind: "pause.set", actor: "owner", detail: { paused: true } });
    expect(listAuditEvents(db, { limit: 1 })[0]).toMatchObject({ kind: "pause.set", actor: "owner" });
  });

  test("a failing write throws, so a caller that must not lose its row stops", () => {
    installAuditSink(db);
    db.run("DROP TABLE audit_events");
    expect(() => audit({ kind: "x", detail: {} })).toThrow();
  });

  test("startup installs the sink and binds the pause state, and is safe to run twice", async () => {
    const ctx = { db, config: {} as never };
    await startupS2Audit(ctx);
    await startupS2Audit(ctx);
    audit({ kind: "boot", detail: { ok: true } });
    expect(listAuditEvents(db, { limit: 5 }).filter((event) => event.kind === "boot")).toHaveLength(1);
    expect(isRunPaused({ agentID: "ea" }).paused).toBe(false);
    setAllPaused(db, true, { actor: "owner" });
    expect(isRunPaused({ agentID: "ea" }).paused).toBe(true);
    expect(listAuditEvents(db, { kind: "pause.set", limit: 5 })).toHaveLength(1);
    expect(verifyAuditChain(db).ok).toBe(true);
  });
});
