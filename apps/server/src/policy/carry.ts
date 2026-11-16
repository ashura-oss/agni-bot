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
import { addTaint, unpackTaint } from "./context";
import type { RunContext, TaintSource } from "./types";

/**
 * The run that read a bot's result takes on what that bot's run had read. `from` is the bot's
 * name, for the card; `via` the tool that brought the result in. Returns true when the run was
 * marked by this.
 */
export function carryTaint(run: Pick<RunContext, "taint" | "bot" | "turnID" | "jobID"> | undefined, from: string, sources: readonly TaintSource[], via: string): boolean {
  if (!run || sources.length === 0) return false;
  const label = entry(from, 60).replace(/\s+/g, " ").trim() || "another bot";
  const marked = addTaint(run, { kind: "peer", label, tool: via, at: nowISO() });
  if (!marked) return false;
  try {
    audit({
      kind: "policy.taint", actor: run.bot, turnID: run.turnID, ...(run.jobID ? { jobID: run.jobID } : {}),
      detail: { kind: "peer", label, tool: via, carried: sources.slice(0, 5).map((source) => ({ kind: source.kind, label: source.label })) },
    });
  } catch (error) {
    log.warn(`turn ${run.turnID}: could not record the carried taint: ${error instanceof Error ? error.message : String(error)}`);
  }
  return true;
}

/** What a delegated task's run read, as stored when it ended. Empty for a task that read nothing outside, and for one that has not ended. */
export function taskTaint(db: Database, taskID: string | null | undefined): TaintSource[] {
  if (!taskID) return [];
  const row = db.query<{ taint: string | null }, [string]>("SELECT taint FROM tasks WHERE id = ?").get(taskID);
  if (!row?.taint) return [];
  try {
    return unpackTaint(JSON.parse(row.taint));
  } catch {
    return [];
  }
}

/** Write down what a task's run read, when it ends. Replaces what was there. */
export function saveTaskTaint(db: Database, taskID: string, sources: readonly TaintSource[]): void {
  db.run("UPDATE tasks SET taint = ? WHERE id = ?", [sources.length > 0 ? JSON.stringify(sources) : null, taskID]);
}
