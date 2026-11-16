import type { Migration } from "../migrations";

/**
 * 56: the audit log (S2-12). Append-only rows, each carrying the hash of the
 * one before it (stores/audit.ts). `detail` is canonical JSON, so the hash
 * input is exactly what is stored.
 */
export const migration: Migration | null = {
  id: 56,
  name: "audit_events",
  sql: `
    CREATE TABLE audit_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      at TEXT NOT NULL,
      kind TEXT NOT NULL,
      actor TEXT,
      turn_id TEXT,
      job_id TEXT,
      detail TEXT NOT NULL,
      prev_hash TEXT NOT NULL,
      hash TEXT NOT NULL
    );
    CREATE INDEX idx_audit_events_kind ON audit_events(kind, seq);
  `,
};
