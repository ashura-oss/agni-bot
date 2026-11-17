/**
 * What the owner said no to, for the rest of the run (S2-07).
 *
 * A refusal covers the thing, not just the tool. If the owner denies deleting
 * a file, the bot cannot reach that file another way in the same run: not by
 * overwriting it, appending to it, moving or copying it, or through the shell.
 * Same for an address: a "no" to a mail covers a calendar invite to it. The
 * record is a (resource, operation) pair under the run's root, so it applies
 * to the bots the run hands work to as well, and lapses when the run ends.
 *
 * Operations that hurt (delete, change, send, run) cover one another. A "no"
 * to reading covers every operation (a copy or a move reads its source); a
 * "no" to deleting does not stop a read.
 */
import type { Database } from "bun:sqlite";
import { newID, nowISO } from "../util/ids";
import type { Operation, RunContext } from "./types";
import type { ToolResource } from "./tool-meta";
import { pathsOverlap } from "./resources";
import { STANDING_JOB_LABEL, STANDING_JOB_RESOURCE } from "./standing-rules";

/** Refusals of one resource in one run before the run itself is stopped. */
export const REFUSALS_BEFORE_STOP = 3;

export interface DenialRecord {
  id: string;
  kind: ToolResource["kind"];
  key: string;
  operation: Operation;
  tool: string;
  cause: "denied" | "expired";
  blockedCount: number;
}

/**
 * What a refused shell command the server could not prove is recorded under: it names no file, so the refusal is
 * of running commands at all. It is held for the rest of the run and never matches a resource (`findDenial`);
 * the engine reads it with `shellDenial`.
 */
export const SHELL_REFUSAL: ToolResource = { kind: "other", value: "agni:shell" };
const isShellRefusal = (kind: ToolResource["kind"], key: string): boolean => kind === SHELL_REFUSAL.kind && key === SHELL_REFUSAL.value;
/** The refusal of a repeating job (policy/standing-rules.ts): it names no file either, and nothing but another repeating job can reach it. */
const isStandingRefusal = (kind: ToolResource["kind"], key: string): boolean => kind === STANDING_JOB_RESOURCE.kind && key === STANDING_JOB_RESOURCE.value;

/** What a refusal was of, for the lines that say what the owner said no to: the file or address, or "repeating jobs". */
export const refusedThing = (record: Pick<DenialRecord, "kind" | "key">, show: (text: string) => string): string =>
  isStandingRefusal(record.kind, record.key) ? STANDING_JOB_LABEL : show(record.key);

/** What names the run a denial belongs to. */
export type DenialRun = Pick<RunContext, "rootJob" | "rootTurnID" | "denialRoot">;

/**
 * The run a denial belongs to: the scope a job was handed by the run that scheduled it, else the job at the root of the
 * chain, else the chat turn that began it. A job a bot scheduled keeps the scope of the run it was scheduled from, so a
 * "no" in a chat holds in a routine made from that chat, and in everything that routine delegates, schedules or wakes.
 */
export function denialScope(run: DenialRun): string {
  return run.denialRoot ?? run.rootJob ?? run.rootTurnID;
}

const HARMFUL: ReadonlySet<Operation> = new Set(["delete", "change", "send", "run"]);

/**
 * Does a "no" to `denied` cover an attempt at `attempted`? A "no" to reading the file covers every operation: `cp` and `mv`
 * read their source, so a copy of a file the owner would not let the bot read is a read of it by another route.
 */
function covers(denied: Operation, attempted: Operation): boolean {
  if (denied === attempted || denied === "read") return true;
  return HARMFUL.has(denied) && HARMFUL.has(attempted);
}

export function recordDenial(
  db: Database,
  run: DenialRun & Pick<RunContext, "bot">,
  denial: { tool: string; operation: Operation; resources: ToolResource[]; cause: "denied" | "expired" },
): void {
  const scope = denialScope(run);
  for (const resource of denial.resources) {
    db.run(
      `INSERT INTO run_denials (id, run_key, agent_id, resource_kind, resource_key, operation, tool_name, cause, blocked_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [newID("rdn"), scope, run.bot, resource.kind, resource.value, denial.operation, denial.tool, denial.cause, nowISO()],
    );
  }
}

interface DenialRow {
  id: string; resource_kind: ToolResource["kind"]; resource_key: string; operation: Operation; tool_name: string; cause: "denied" | "expired"; blocked_count: number;
}

/**
 * The first refusal this run holds about something a command or a connector tool could reach, or null. One indexed read.
 * A refused repeating job is not one: no file or address is in it, so it makes no other call ask.
 */
export function anyDenial(db: Database, run: DenialRun): DenialRecord | null {
  const row = db
    .query<DenialRow, [string, string, string]>("SELECT id, resource_kind, resource_key, operation, tool_name, cause, blocked_count FROM run_denials WHERE run_key = ? AND NOT (resource_kind = ? AND resource_key = ?) ORDER BY created_at LIMIT 1")
    .get(denialScope(run), STANDING_JOB_RESOURCE.kind, STANDING_JOB_RESOURCE.value);
  return row ? toRecord(row) : null;
}

/** The run-wide refusal of a shell command the owner was asked about and refused, or null. One indexed read. */
export function shellDenial(db: Database, run: DenialRun): DenialRecord | null {
  const row = db
    .query<DenialRow, [string, string, string]>("SELECT id, resource_kind, resource_key, operation, tool_name, cause, blocked_count FROM run_denials WHERE run_key = ? AND resource_kind = ? AND resource_key = ? ORDER BY created_at LIMIT 1")
    .get(denialScope(run), SHELL_REFUSAL.kind, SHELL_REFUSAL.value);
  return row ? toRecord(row) : null;
}

/** Is this the run-wide refusal of a shell command, whose key names no file? */
export const isShellDenial = (record: Pick<DenialRecord, "kind" | "key">): boolean => isShellRefusal(record.kind, record.key);

function toRecord(row: DenialRow): DenialRecord {
  return { id: row.id, kind: row.resource_kind, key: row.resource_key, operation: row.operation, tool: row.tool_name, cause: row.cause, blockedCount: row.blocked_count };
}

/** The first earlier "no" in this run that covers any of these resources for this operation. */
export function findDenial(
  db: Database,
  run: DenialRun,
  operation: Operation,
  resources: ToolResource[],
): DenialRecord | null {
  if (resources.length === 0) return null;
  const rows = db
    .query<DenialRow, [string]>("SELECT id, resource_kind, resource_key, operation, tool_name, cause, blocked_count FROM run_denials WHERE run_key = ? ORDER BY created_at")
    .all(denialScope(run));
  const hit = rows.find((row) => covers(row.operation, operation) && resources.some((resource) => resourceCovered(row.resource_kind, row.resource_key, resource)));
  return hit ? toRecord(hit) : null;
}

function resourceCovered(kind: ToolResource["kind"], key: string, attempt: ToolResource): boolean {
  // The run-wide shell refusal names no resource; the engine applies it to whole kinds of call (policy/engine.ts).
  if (isShellRefusal(kind, key)) return false;
  if (attempt.kind === "path" && kind === "path") return pathsOverlap(key, attempt.value);
  // An address and a host are the same kind of thing whichever tool reached for it.
  const sameKind = attempt.kind === kind || (kind === "host" && attempt.kind === "url") || (kind === "url" && attempt.kind === "host");
  return sameKind && attempt.value.toLowerCase() === key.toLowerCase();
}

/** Count one more blocked attempt on this denial and return the new total. */
export function noteBlockedAttempt(db: Database, denialID: string): number {
  db.run("UPDATE run_denials SET blocked_count = blocked_count + 1 WHERE id = ?", [denialID]);
  return db.query<{ blocked_count: number }, [string]>("SELECT blocked_count FROM run_denials WHERE id = ?").get(denialID)?.blocked_count ?? 0;
}
