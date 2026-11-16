/**
 * Job store. One row per unit of background work the daemon runs while no
 * client is watching: scheduled turns (reminders, the 07:55 brief), retries,
 * and later the task/deep lanes. Claims are transactional so a second
 * process can never grab the same job.
 */
import type { Database } from "bun:sqlite";
import { newID, nowISO } from "../util/ids";

export const JOB_STATES = ["queued", "running", "done", "failed"] as const;
export type JobState = (typeof JOB_STATES)[number];

export interface JobRow {
  id: string;
  kind: string;
  payload: string | null;
  state: string;
  run_at: string;
  attempts: number;
  result: string | null;
  /** 0 pauses the job: it stays visible, but never claims. */
  enabled: number;
  created_at: string;
  updated_at: string;
}

const COLUMNS = "id, kind, payload, state, run_at, attempts, result, enabled, created_at, updated_at";

export function enqueueJob(
  db: Database,
  params: { kind: string; payload?: unknown; runAt?: string },
): JobRow {
  const row: JobRow = {
    id: newID("job"),
    kind: params.kind,
    payload: params.payload === undefined ? null : JSON.stringify(params.payload),
    state: "queued",
    run_at: params.runAt ?? nowISO(),
    attempts: 0,
    result: null,
    enabled: 1,
    created_at: nowISO(),
    updated_at: nowISO(),
  };
  db.run(
    `INSERT INTO jobs (id, kind, payload, state, run_at, attempts, result, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.kind,
      row.payload,
      row.state,
      row.run_at,
      row.attempts,
      row.result,
      row.enabled,
      row.created_at,
      row.updated_at,
    ],
  );
  return row;
}

/**
 * Atomically pick the oldest due job and mark it running. Paused jobs wait,
 * except for a Run now (`run_once`), which the same UPDATE that claims it
 * clears: one claim, whatever the handler then does.
 */
export function claimDueJob(db: Database, now = nowISO(), excludeKinds: readonly string[] = []): JobRow | null {
  return db.transaction((): JobRow | null => {
    const row = db
      .query<JobRow, [string, string]>(
        `SELECT ${COLUMNS} FROM jobs
         WHERE state = 'queued' AND (enabled = 1 OR run_once = 1) AND run_at <= ?
           AND kind NOT IN (SELECT value FROM json_each(?))
         ORDER BY run_at ASC, rowid ASC
         LIMIT 1`,
      )
      .get(now, JSON.stringify(excludeKinds));
    if (!row) return null;
    db.run("UPDATE jobs SET state = 'running', run_once = 0, attempts = attempts + 1, updated_at = ? WHERE id = ?", [
      nowISO(),
      row.id,
    ]);
    return { ...row, state: "running", attempts: row.attempts + 1 };
  })();
}

/** Complete a job. `result` is a short human-readable note (or the error). */
export function finishJob(db: Database, id: string, state: "done" | "failed", result?: string): void {
  db.run("UPDATE jobs SET state = ?, result = ?, updated_at = ? WHERE id = ?", [
    state,
    result ?? null,
    nowISO(),
    id,
  ]);
}

/** Put a claimed job back in the queue for a later attempt. */
export function requeueJob(db: Database, id: string, runAt: string): void {
  db.run("UPDATE jobs SET state = 'queued', run_at = ?, updated_at = ? WHERE id = ?", [runAt, nowISO(), id]);
}

/**
 * Job kinds the daemon runs for itself (tagging, embedding, backups, rollover
 * summaries, the harness review). They are not the owner's to pause, run or
 * read about. A kind not listed here (a new one, one the owner made) is the
 * owner's: hiding something they may have created is the worse mistake.
 */
const INTERNAL_JOB_KINDS: ReadonlySet<string> = new Set([
  "tagger",
  "memory.embed",
  "memory.consolidate",
  "summary.rollup",
  "rollover.summarize",
  "db.backup",
  "harness.review",
]);

export function isInternalJobKind(kind: string): boolean {
  return INTERNAL_JOB_KINDS.has(kind);
}

/** What `wakeJob` did: made the job due, left a running copy alone, or found no such job. */
export type WakeOutcome = "woken" | "running" | "not_found";

/**
 * Make a job (any state) due now — the manual "run it" escape hatch. Running
 * it once is all that is asked: a paused job is run one time and stays paused
 * (`enabled` is not changed; resuming is the owner's other button).
 *
 * A job that is already running is left alone. Queueing it again would let
 * the next tick claim a second copy beside the first (routines and turns run
 * in parallel), so the caller is told it is running instead.
 */
export function wakeJob(db: Database, id: string): WakeOutcome {
  const result = db.run(
    "UPDATE jobs SET state = 'queued', run_at = ?, attempts = 0, result = NULL, run_once = CASE WHEN enabled = 1 THEN 0 ELSE 1 END, updated_at = ? WHERE id = ? AND state != 'running'",
    [nowISO(), nowISO(), id],
  );
  if (result.changes > 0) return "woken";
  return getJob(db, id) ? "running" : "not_found";
}

/** What to tell the person who asked to run a job now: whether it worked, in words. */
export function describeWake(id: string, outcome: WakeOutcome): { ok: boolean; message: string } {
  switch (outcome) {
    case "woken":
      return { ok: true, message: `${id} is due now — the daemon picks it up on its next poll` };
    case "running":
      return { ok: false, message: `${id} is already running — it was not queued again; run it again after it finishes` };
    case "not_found":
      return { ok: false, message: `no job ${id}` };
  }
}

export function getJob(db: Database, id: string): JobRow | null {
  return db.query<JobRow, [string]>(`SELECT ${COLUMNS} FROM jobs WHERE id = ?`).get(id) ?? null;
}

/** Resolve a full id or unique prefix, like `revoke` does for devices. */
export function getJobByPrefix(db: Database, prefix: string): JobRow | null {
  if (prefix.length === 0) return null;
  // The prefix is text, not a pattern: `%` and `_` in it must match only themselves. Compared by length, not LIKE.
  const rows = db
    .query<JobRow, [number, string]>(`SELECT ${COLUMNS} FROM jobs WHERE lower(substr(id, 1, ?)) = lower(?) LIMIT 2`)
    .all(prefix.length, prefix);
  return rows.length === 1 ? rows[0] ?? null : null;
}

export function listJobs(db: Database, options: { limit?: number; includeFinished?: boolean } = {}): JobRow[] {
  const limit = options.limit ?? 25;
  const where = options.includeFinished ? "" : "WHERE state IN ('queued', 'running')";
  return db
    .query<JobRow, [number]>(
      `SELECT ${COLUMNS} FROM jobs ${where} ORDER BY run_at ASC, rowid ASC LIMIT ?`,
    )
    .all(limit);
}

/** Recently finished jobs, newest first — the "what did it last do" list. */
export function listFinishedJobs(db: Database, limit = 10): JobRow[] {
  return db
    .query<JobRow, [number]>(
      `SELECT ${COLUMNS} FROM jobs
       WHERE state IN ('done', 'failed')
       ORDER BY updated_at DESC, rowid DESC
       LIMIT ?`,
    )
    .all(limit);
}

/** Pause or resume a job. A running job finishes; paused work stays visible. */
export function setJobEnabled(db: Database, id: string, enabled: boolean): boolean {
  // Pausing or resuming also withdraws a Run now that has not been claimed yet.
  const result = db.run("UPDATE jobs SET enabled = ?, run_once = 0, updated_at = ? WHERE id = ?", [
    enabled ? 1 : 0,
    nowISO(),
    id,
  ]);
  return result.changes > 0;
}

/** Delete a job that is not currently being executed. */
export function deleteJob(db: Database, id: string): boolean {
  const result = db.run("DELETE FROM jobs WHERE id = ? AND state != 'running'", [id]);
  return result.changes > 0;
}

/**
 * Boot hygiene: a job left `running` belongs to a dead process. Queue it
 * again — attempts are preserved, so a crash loop still drains to `failed`.
 */
export function requeueStuckJobs(db: Database): number {
  const result = db.run("UPDATE jobs SET state = 'queued', run_at = ?, updated_at = ? WHERE state = 'running'", [
    nowISO(),
    nowISO(),
  ]);
  return result.changes;
}

export function parseJobPayload<T>(row: JobRow): T {
  if (!row.payload) return {} as T;
  try {
    return JSON.parse(row.payload) as T;
  } catch {
    throw new Error(`job ${row.id} has an unparseable payload`);
  }
}

/**
 * Find a queued job by a key inside its payload. Used to coalesce wake
 * jobs: several completions for the same parent thread become one wake.
 */
export function findQueuedJobByPayloadKey(db: Database, kind: string, key: string): JobRow | null {
  const rows = db
    .query<JobRow, [string, string]>(
      `SELECT ${COLUMNS} FROM jobs
       WHERE kind = ? AND state = 'queued' AND json_extract(payload, '$.wakeKey') = ?
       ORDER BY run_at ASC, rowid ASC LIMIT 1`,
    )
    .all(kind, key);
  return rows[0] ?? null;
}

/** Append an item to a job payload's `results` list, in place. */
export function appendJobResult(db: Database, id: string, item: Record<string, unknown>): void {
  const row = getJob(db, id);
  if (!row) return;
  const payload = parseJobPayload<Record<string, unknown>>(row);
  const results = Array.isArray(payload.results) ? [...payload.results] : [];
  results.push(item);
  payload.results = results;
  db.run("UPDATE jobs SET payload = ?, updated_at = ? WHERE id = ?", [JSON.stringify(payload), nowISO(), id]);
}
