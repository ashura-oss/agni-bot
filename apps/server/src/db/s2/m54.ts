import type { Migration } from "../migrations";

/**
 * Ledger columns (S2-10). One row per model call, with what it cost and who
 * and what it was for. Rows written before this migration, and the per-turn
 * row `recordUsage` still writes, keep NULL in the new columns: `call_kind`
 * NULL marks them, and `cost_usd` NULL means "cost unknown", never zero.
 */
export const migration: Migration | null = {
  id: 54,
  name: "usage_ledger_cost",
  sql: `
    ALTER TABLE usage_ledger ADD COLUMN cost_usd REAL;
    ALTER TABLE usage_ledger ADD COLUMN cached_input_tokens INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE usage_ledger ADD COLUMN agent_id TEXT;
    ALTER TABLE usage_ledger ADD COLUMN job_id TEXT;
    ALTER TABLE usage_ledger ADD COLUMN root_job_id TEXT;
    ALTER TABLE usage_ledger ADD COLUMN call_kind TEXT;       -- turn | side
    ALTER TABLE usage_ledger ADD COLUMN purpose TEXT;
    CREATE INDEX idx_usage_created ON usage_ledger(created_at, cost_usd);
    CREATE INDEX idx_usage_agent_created ON usage_ledger(agent_id, created_at, cost_usd);
    CREATE INDEX idx_usage_root_job ON usage_ledger(root_job_id, cost_usd);
  `,
};
