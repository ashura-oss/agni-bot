/**
 * The run clock (S2-09): what the root job's time limit measures.
 *
 * A clock belongs to a *run*: a chat turn, or a job, and everything the run delegated (a delegated
 * child carries its parent's clock key). It is not the same thing as the root the owner's refusals
 * belong to: a wake, a task resumed after the owner answered, and a job's next scheduled run keep the
 * refusals of the request they came from but each start a clock of their own. Each scheduled run of a job has
 * its own clock (`startJobClock`); a retry of that run keeps the clock its first attempt started.
 *
 * The time the owner spends deciding (an approval card, a question, a password prompt) is not the run's
 * time, as it is not the turn timer's (`TurnTimer`): those waits are written down here, per clock, so the
 * limit still excludes them in a later turn of the same run (a retry, a delegated child).
 *
 * Every read fails closed: a clock that is missing or unreadable is `null`, and the caller stops the run.
 */
import type { Database } from "bun:sqlite";
import { log } from "../log";
import { newID } from "../util/ids";
import { BACKGROUND_OWNER_WAIT_MS } from "./pending-cards";

/** The longest one wait on the owner can last (a background card's); an open wait counts for no more, so a dead process cannot make a run free. */
export const OPEN_WAIT_CAP_MS = BACKGROUND_OWNER_WAIT_MS;
/** Clocks older than this are dropped when a new one starts: no run lives that long. */
const KEEP_CLOCKS_MS = 7 * 86_400_000;

/**
 * Start the clock named `key`. A key that is already started keeps its first start. Never throws: a clock that could
 * not be written is read as unknown, which stops the run.
 */
export function startClock(db: Database, key: string, nowMs: number = Date.now()): void {
  try {
    const at = new Date(nowMs).toISOString();
    db.transaction(() => {
      db.run("INSERT OR IGNORE INTO run_clocks (clock_key, started_at) VALUES (?, ?)", [key, at]);
      // The index on started_at keeps this cheap on every start.
      const cutoff = new Date(nowMs - KEEP_CLOCKS_MS).toISOString();
      db.run("DELETE FROM run_clock_waits WHERE clock_key IN (SELECT clock_key FROM run_clocks WHERE started_at < ?)", [cutoff]);
      db.run("DELETE FROM run_clocks WHERE started_at < ?", [cutoff]);
    })();
  } catch (error) {
    log.warn(`run clock ${key} could not be started: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Start the clock of one scheduled run of a job, and return its key. Every run has a clock of its own, named for the job
 * and the slot it was scheduled for (`slot`: the job's `run_at` when the run was first tried), so a delegated child that is
 * still running when the job's next slot starts stays on the clock of the run it belongs to. A retry of the same run
 * (`retry`) finds the clock its first try started and keeps it; if there is none to find (it was dropped as too old), it
 * starts one for this slot.
 */
export function startJobClock(db: Database, jobID: string, slot: string, retry: boolean, nowMs: number = Date.now()): string {
  const prefix = `${jobID}@`;
  if (retry) {
    try {
      const first = db
        .query<{ clock_key: string }, [number, string]>("SELECT clock_key FROM run_clocks WHERE substr(clock_key, 1, ?) = ? ORDER BY started_at DESC LIMIT 1")
        .get(prefix.length, prefix);
      if (first) return first.clock_key;
    } catch (error) {
      log.warn(`run clock of job ${jobID} could not be looked up: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const key = `${prefix}${slot}`;
  startClock(db, key, nowMs);
  return key;
}

/**
 * The run is now waiting on the owner. Returns the function that ends the wait. A wait that could not be
 * written is simply not taken off, so the run is stopped sooner, never later.
 */
export function beginOwnerWait(db: Database, key: string, nowMs: number = Date.now()): () => void {
  const id = newID("rcw");
  try {
    db.run("INSERT INTO run_clock_waits (id, clock_key, started_at) VALUES (?, ?, ?)", [id, key, new Date(nowMs).toISOString()]);
  } catch (error) {
    log.warn(`run clock ${key}: a wait on the owner could not be recorded: ${error instanceof Error ? error.message : String(error)}`);
    return () => undefined;
  }
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    try {
      db.run("UPDATE run_clock_waits SET ended_at = ? WHERE id = ?", [new Date().toISOString(), id]);
    } catch (error) {
      log.warn(`run clock ${key}: the end of a wait on the owner could not be recorded: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

/** Hold the turn's timer and take the wait off the run's clock until the returned function is called. */
export function holdForOwner(db: Database, key: string, timer: { hold(): () => void }): () => void {
  const release = timer.hold();
  const endWait = beginOwnerWait(db, key);
  return () => {
    endWait();
    release();
  };
}

export interface ClockReading {
  startedAtMs: number;
  /** Time spent waiting on the owner since the start, with overlapping waits counted once. */
  waitedMs: number;
}

/** When the clock started and how much of the time since was the owner's. Null when either cannot be read. */
export function readClock(db: Database, key: string, nowMs: number = Date.now()): ClockReading | null {
  try {
    const clock = db.query<{ started_at: string }, [string]>("SELECT started_at FROM run_clocks WHERE clock_key = ?").get(key);
    const startedAtMs = clock ? Date.parse(clock.started_at) : Number.NaN;
    if (!Number.isFinite(startedAtMs)) return null;
    const rows = db.query<{ started_at: string; ended_at: string | null }, [string]>("SELECT started_at, ended_at FROM run_clock_waits WHERE clock_key = ?").all(key);
    const spans: Array<[number, number]> = [];
    for (const row of rows) {
      const from = Date.parse(row.started_at);
      const to = row.ended_at === null ? from + OPEN_WAIT_CAP_MS : Date.parse(row.ended_at);
      if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
      const start = Math.max(from, startedAtMs);
      const end = Math.min(to, nowMs);
      if (end > start) spans.push([start, end]);
    }
    return { startedAtMs, waitedMs: unionLength(spans) };
  } catch {
    return null;
  }
}

/** The total length covered by the spans, an overlap counted once. */
function unionLength(spans: Array<[number, number]>): number {
  spans.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let from = Number.NEGATIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  for (const [start, end] of spans) {
    if (start > to) {
      if (to > from) total += to - from;
      from = start;
      to = end;
    } else if (end > to) {
      to = end;
    }
  }
  if (to > from) total += to - from;
  return total;
}
