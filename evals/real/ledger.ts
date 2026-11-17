/**
 * Reads an episode's Sprint 2 usage ledger (`usage_ledger`, one row per model
 * call since S2-10): cost, unknown-cost calls, tokens, and the optional
 * columns that later Sprint 5 items add.
 */
import type { Database } from "bun:sqlite";
import type { LedgerSummary } from "./types";

/**
 * Ledger columns other Sprint 5 items are expected to add: tool-call repair
 * (item 7) and model escalation (B1.8). Until a column exists in the episode
 * database its rate is reported as n/a, never as 0. If those items choose
 * other names, change them here.
 */
export const OPTIONAL_LEDGER_COLUMNS = { repair: "repair_attempts", escalation: "escalated" } as const;

export function ledgerColumns(db: Database): Set<string> {
  return new Set(db.query<{ name: string }, []>("PRAGMA table_info(usage_ledger)").all().map((row) => row.name));
}

export function readLedger(db: Database): LedgerSummary {
  const columns = ledgerColumns(db);
  const row = db
    .query<{ n: number; cost: number | null; unknown: number | null; input: number | null; output: number | null }, []>(
      `SELECT COUNT(*) n, SUM(cost_usd) cost, SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) unknown,
              SUM(input_tokens) input, SUM(output_tokens) output
       FROM usage_ledger WHERE call_kind IS NOT NULL`,
    )
    .get();
  const countWhere = (column: string): number | null => {
    if (!columns.has(column)) return null;
    return (
      db.query<{ n: number }, []>(`SELECT COUNT(*) n FROM usage_ledger WHERE call_kind IS NOT NULL AND COALESCE(${column}, 0) > 0`).get()?.n ?? 0
    );
  };
  return {
    calls: row?.n ?? 0,
    costUsd: row?.cost ?? 0,
    unknownCostCalls: row?.unknown ?? 0,
    inputTokens: row?.input ?? 0,
    outputTokens: row?.output ?? 0,
    repairCalls: countWhere(OPTIONAL_LEDGER_COLUMNS.repair),
    escalatedCalls: countWhere(OPTIONAL_LEDGER_COLUMNS.escalation),
  };
}
