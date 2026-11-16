import type { Migration } from "../migrations";

/**
 * 59: pause-all and per-bot off (S2-13). One row of pause state, one flag per
 * bot. `changed_by` names the device (or "cli") that made the last change.
 */
export const migration: Migration | null = {
  id: 59,
  name: "pause_and_agent_disabled",
  sql: `
    ALTER TABLE agents ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE pause_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      paused INTEGER NOT NULL DEFAULT 0,
      changed_at TEXT,
      changed_by TEXT
    );
    INSERT INTO pause_state (id, paused) VALUES (1, 0);
  `,
};
