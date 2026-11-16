/**
 * Carrying taint across the edges of a run (S2-06): from a bot to the bot it hands
 * work to, from that bot's result back to the one that reads it, through a task
 * row, an artifact, a wake, a group room.
 *
 * Taint is information flow: another bot's words are outside text exactly when
 * that bot had read outside text. A reply from a bot that read nothing outside
 * does not mark the run that reads it. A reply from one that did marks it, and
 * the card says "read a reply from Juno", not what Juno read.
 */
import type { Database } from "bun:sqlite";
import { entry } from "../agent/card-text";
import { log } from "../log";
import { nowISO } from "../util/ids";
import { audit } from "./audit-sink";
import { addTaint, readTaint } from "./context";
import type { RunContext, TaintSource } from "./types";

/**
 * The run that read a bot's result takes on what that bot's run had read. `from` is the bot's
 * name, for the card; `via` the tool that brought the result in. Returns true when the run was
 * marked by this.
 */
export function carryTaint(run: Pick<RunContext, "taint" | "bot" | "turnID" | "jobID"> | undefined, from: string, sources: readonly TaintSource[], via: string): boolean {
  if (!run || sources.length === 0) return false;
  const label = entry(from, 60).replace(/\s+/g, " ").trim() || "another bot";
  return markRun(run, { kind: "peer", label, tool: via, at: nowISO() }, { carried: sources.slice(0, 5).map((source) => ({ kind: source.kind, label: source.label })) });
}

/** A note the bot kept from outside text and has now read back: what is in it is outside text again. */
export function carryNoteTaint(run: Pick<RunContext, "taint" | "bot" | "turnID" | "jobID"> | undefined, items: ReadonlyArray<{ fromOutside?: boolean }>, via: string): boolean {
  if (!run || !items.some((item) => item.fromOutside)) return false;
  return markRun(run, { kind: "unknown", label: "a note kept from outside content", tool: via, at: nowISO() });
}

/** Mark the run and write the change down. A failed audit row never un-marks the run. */
export function markRun(run: Pick<RunContext, "taint" | "bot" | "turnID" | "jobID">, source: TaintSource, extra: Record<string, unknown> = {}): boolean {
  if (!addTaint(run, source)) return false;
  try {
    audit({
      kind: "policy.taint", actor: run.bot, turnID: run.turnID, ...(run.jobID ? { jobID: run.jobID } : {}),
      detail: { kind: source.kind, label: source.label, tool: source.tool, ...extra },
    });
  } catch (error) {
    log.warn(`turn ${run.turnID}: could not record that the run read outside content: ${error instanceof Error ? error.message : String(error)}`);
  }
  return true;
}

/**
 * What a delegated task's run has read so far. Fails closed: a task with no record, an unreadable record,
 * or no such task reads as having read outside text. Only a stored empty list means it read nothing.
 */
export function taskTaint(db: Database, taskID: string | null | undefined): TaintSource[] {
  if (!taskID) return readTaint(undefined, "a result with no task behind it");
  const row = db.query<{ taint: string | null }, [string]>("SELECT taint FROM tasks WHERE id = ?").get(taskID);
  if (!row?.taint) return readTaint(undefined, "a task with no record of what it read");
  try {
    return readTaint(JSON.parse(row.taint), "a task with no record of what it read");
  } catch {
    return readTaint(undefined, "a task with no record of what it read");
  }
}

/**
 * Write down what a task's run has read. Monotonic: what was already recorded stays, whatever is
 * passed, so a later or partial save can only add. A task with no record yet takes what is passed.
 */
export function saveTaskTaint(db: Database, taskID: string, sources: readonly TaintSource[]): void {
  const row = db.query<{ taint: string | null }, [string]>("SELECT taint FROM tasks WHERE id = ?").get(taskID);
  if (!row) return;
  let merged: TaintSource[] = [...sources];
  if (row.taint) {
    try {
      const before = readTaint(JSON.parse(row.taint));
      merged = [...before, ...sources.filter((source) => !before.some((known) => known.kind === source.kind && known.label === source.label))];
    } catch {
      merged = [...sources, ...readTaint(undefined, "a task with no record of what it read")];
    }
  }
  db.run("UPDATE tasks SET taint = ? WHERE id = ?", [JSON.stringify(merged), taskID]);
}
