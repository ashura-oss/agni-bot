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
 * Operations that hurt (delete, change, send, run) cover one another; a "no"
 * to reading covers reading only, and a "no" to deleting does not stop a read.
 */
import type { Database } from "bun:sqlite";
import { newID, nowISO } from "../util/ids";
import type { Operation, RunContext } from "./types";
import type { ToolResource } from "./tool-meta";
import { pathsOverlap } from "./resources";

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

/** The run a denial belongs to: the job at the root of the chain, or the chat turn that began it. */
export function denialScope(run: Pick<RunContext, "rootJob" | "rootTurnID">): string {
  return run.rootJob ?? run.rootTurnID;
}

const HARMFUL: ReadonlySet<Operation> = new Set(["delete", "change", "send", "run"]);

/** Does a "no" to `denied` cover an attempt at `attempted`? */
function covers(denied: Operation, attempted: Operation): boolean {
  if (denied === attempted) return true;
  return HARMFUL.has(denied) && HARMFUL.has(attempted);
}

export function recordDenial(
  db: Database,
  run: Pick<RunContext, "rootJob" | "rootTurnID" | "bot">,
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

/** The first refusal this run holds, whatever it was about, or null. One indexed read. */
export function anyDenial(db: Database, run: Pick<RunContext, "rootJob" | "rootTurnID">): DenialRecord | null {
  const row = db
    .query<DenialRow, [string]>("SELECT id, resource_kind, resource_key, operation, tool_name, cause, blocked_count FROM run_denials WHERE run_key = ? ORDER BY created_at LIMIT 1")
    .get(denialScope(run));
  return row ? toRecord(row) : null;
}

function toRecord(row: DenialRow): DenialRecord {
  return { id: row.id, kind: row.resource_kind, key: row.resource_key, operation: row.operation, tool: row.tool_name, cause: row.cause, blockedCount: row.blocked_count };
}

/** The first earlier "no" in this run that covers any of these resources for this operation. */
export function findDenial(
  db: Database,
  run: Pick<RunContext, "rootJob" | "rootTurnID">,
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
