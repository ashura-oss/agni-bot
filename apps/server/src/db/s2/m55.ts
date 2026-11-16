import type { Migration } from "../migrations";

/**
 * Policy settings (S2-11): a small key/value table for the owner's caps (spend
 * and run limits). Values are JSON text. The `agents.disabled` column that the
 * spec also lists under 55 belongs to S2-13 and is added to this same
 * migration by whoever merges it (one id, one file).
 */
export const migration: Migration | null = {
  id: 55,
  name: "policy_settings",
  sql: `
    CREATE TABLE policy_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,              -- JSON: a number, or null for "no cap"
      updated_at TEXT NOT NULL
    );
  `,
};
