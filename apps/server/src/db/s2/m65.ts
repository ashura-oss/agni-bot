import type { Migration } from "../migrations";

/**
 * 65: the run clock (S2-09, fix round C).
 *
 * The root-job time limit counts from the start of a run, not from the start of a turn row: a run
 * is a chat turn or a job, with what it delegated, and a wake, a task resumed after the owner's answer
 * and a job's next scheduled run each start their own. Two things have to outlive a single turn of one
 * run, so they are kept here:
 *
 *  - `run_clocks`: when each clock started. A job's retry finds its first start here instead of starting
 *    again, so a retry does not get a fresh 30 minutes.
 *  - `run_clock_waits`: the times the run waited on the owner (an approval card, a question, a password
 *    prompt). The owner's time is not the run's, so it is taken off. An open wait (`ended_at` NULL) is one
 *    that has not ended: it counts for at most the longest wait the app allows. A restart closes the ones a
 *    dead process left open (`closeOpenWaits`), so a crash does not give a retried job that time for free.
 *
 * A column on `jobs` belongs to the same fix round:
 *  - `wake_scope`: set when a wake is counted against its request (`takeWakePlace`), so the wake count is one indexed read
 *    and not a JSON read of every turn job.
 *
 * `turns.ended_by` marks a turn the run's time limit ended. Its `stop_reason` stays `timeout` (that is the
 * protocol's word for it), but the nightly harness review must not read it as a model that is too slow.
 */
export const migration: Migration | null = {
  id: 65,
  name: "run_clock",
  sql: `
    CREATE TABLE run_clocks (
      clock_key TEXT PRIMARY KEY,       -- a chat turn's id, or a job's id
      started_at TEXT NOT NULL
    );
    CREATE TABLE run_clock_waits (
      id TEXT PRIMARY KEY,
      clock_key TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT
    );
    CREATE INDEX idx_run_clock_waits_key ON run_clock_waits(clock_key);
    CREATE INDEX idx_run_clocks_started ON run_clocks(started_at);   -- every clock start drops the ones older than a week
    ALTER TABLE turns ADD COLUMN ended_by TEXT;   -- NULL, or wall_time
    ALTER TABLE jobs ADD COLUMN wake_scope TEXT;      -- the request a counted wake belongs to (jobs/wake-limit.ts)
    CREATE INDEX idx_jobs_wake_scope ON jobs(wake_scope) WHERE wake_scope IS NOT NULL;
  `,
};
