import type { Migration } from "../migrations";

/**
 * S3-09: routines no longer run model-written SQL as a pre-check.
 *
 * A routine stored with `{"kind":"sql", ...}` is paused (its job is disabled),
 * its query is dropped (it becomes `{"kind":"none"}`, so turning it back on
 * works and runs on every schedule), and one failed run is recorded whose error
 * says what happened and what to do; the routine's recent runs show it. Rows
 * whose pre-check is anything else, or is not valid JSON, are left alone.
 *
 * (Pairing attempts are limited in memory, not in a table: see
 * `auth/rate-limit.ts`. This id was reserved for `pairing_attempts`.)
 */
const SQL_KIND = "CASE WHEN json_valid(preflight) THEN json_extract(preflight, '$.kind') END = 'sql'";

export const migration: Migration | null = {
  id: 63,
  name: "retire_sql_preflight",
  sql: `
    UPDATE jobs SET enabled = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id IN (SELECT job_id FROM routines WHERE ${SQL_KIND});

    INSERT INTO routine_runs (id, routine_id, started_at, finished_at, outcome, tokens, summary, tool_trace, error)
      SELECT 'run_m63_' || id, id,
             strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             'failed', 0, NULL, NULL,
             'Paused: its SQL pre-check was removed for safety (model-written SQL no longer runs). The routine now has no pre-check. Turn it back on to run it on every schedule, or ask the bot to recreate it with a named check.'
      FROM routines WHERE ${SQL_KIND};

    UPDATE routines SET preflight = '{"kind":"none"}', last_state_hash = NULL,
                        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE ${SQL_KIND};
  `,
};
