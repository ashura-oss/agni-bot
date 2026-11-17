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
 * Two columns on `jobs` belong to the same fix round:
 *  - `wake_scope`: set when a wake is counted against its request (`takeWakePlace`), so the wake count is one indexed read
 *    and not a JSON read of every turn job.
 *  - `run_clock_key`: the clock the job's current scheduled run started. A retry reads it and keeps that clock; the runner
 *    clears it when it schedules the next run. A first try that failed before a clock started leaves it empty, so its retry
 *    starts one for its own slot instead of taking the previous run's.
 *
 * `turns.ended_by` marks a turn the run's time limit ended. Its `stop_reason` stays `timeout` (that is the
 * protocol's word for it), but the nightly harness review must not read it as a model that is too slow.
 *
 * Two more things belong to the same round, one to the data and one to an index (fix round L):
 *  - A job the owner made with `agni job add` before the owner bit existed (`ownerOnly`, `policy/carry.ts`) has no marker, and now reads as a
 *    bot's: its follow-ups ask. The queued turn jobs that are exactly what a
 *    run treats as the owner's (`principalOf` in `agent/task-loop.ts`: no `inputRole`, `peer`, `wakeKey` or `delegationTaskID`, and no
 *    `scheduledBy`) are stamped. A job that already says whether it is the owner's keeps what it says; nothing a bot made is touched.
 *  - The day cap counts the calls whose cost is unknown (`unknownCostCallsSince`). A covering index on (created_at, call_kind, cost_usd)
 *    lets that count read the index alone, not every row of the day.
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
    ALTER TABLE jobs ADD COLUMN run_clock_key TEXT;   -- the clock of the job's current scheduled run (agent/run-clock.ts)
    CREATE INDEX idx_jobs_wake_scope ON jobs(wake_scope) WHERE wake_scope IS NOT NULL;
    UPDATE jobs SET payload = json_set(payload, '$.ownerOnly', json('true'))
      WHERE kind = 'turn' AND state IN ('queued', 'running') AND json_valid(payload)
        AND json_type(payload) = 'object'
        AND json_type(payload, '$.ownerOnly') IS NULL
        AND json_type(payload, '$.inputRole') IS NULL AND json_type(payload, '$.peer') IS NULL
        AND json_type(payload, '$.wakeKey') IS NULL AND json_type(payload, '$.delegationTaskID') IS NULL
        AND json_type(payload, '$.scheduledBy') IS NULL;
    CREATE INDEX idx_usage_created_kind_cost ON usage_ledger(created_at, call_kind, cost_usd);   -- the day cap's count of calls with no known cost
  `,
};
