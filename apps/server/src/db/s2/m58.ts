import type { Migration } from "../migrations";

/**
 * Sprint 2, migration 58 (S2-07, S2-06).
 *
 *  - `run_denials`: what the owner said no to during a run (a refusal or an
 *    expired card), by resource and operation, so the refusal covers every
 *    tool and every route to the same thing for the rest of that run.
 *  - `tasks.taint`: the outside-text sources a delegated task's run ended
 *    with, so the bot that reads the result carries them.
 *  - `channel_messages.tainted`: a bot's group post came from a run that had
 *    read outside text, so another bot reading the room carries that taint.
 *  - `agent_sessions.taint`: what a running session has read, saved as it is read, so a session that
 *    resumes after a restart comes back as tainted as it was (and tainted if the record is missing).
 *  - `owner_words`: what the owner typed in a thread, kept apart from the rows of the thread itself,
 *    so "the owner named this address" cannot be satisfied by text a routine, a peer or a log left behind.
 *
 * `approvals.card_meta` (what the card said besides its text) is added by migration 57; this one
 * does not add it again.
 */
export const migration: Migration | null = {
  id: 58,
  name: "run_denials_and_taint",
  sql: `
    CREATE TABLE run_denials (
      id TEXT PRIMARY KEY,
      run_key TEXT NOT NULL,            -- the root job, or the root turn of a chat run
      agent_id TEXT NOT NULL,
      resource_kind TEXT NOT NULL,      -- path | recipient | host | url | channel | amount | other
      resource_key TEXT NOT NULL,       -- the resource as a comparison key
      operation TEXT NOT NULL,          -- read | change | delete | send | run
      tool_name TEXT NOT NULL,
      cause TEXT NOT NULL,              -- denied | expired
      blocked_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_run_denials_run ON run_denials(run_key, resource_kind);
    ALTER TABLE tasks ADD COLUMN taint TEXT;
    ALTER TABLE channel_messages ADD COLUMN tainted INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE agent_sessions ADD COLUMN taint TEXT;
    CREATE TABLE owner_words (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_owner_words_thread ON owner_words(thread_id, id);
  `,
};
