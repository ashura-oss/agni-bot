/**
 * Spend caps: "is there budget left?" The engine asks this before every model
 * call (S2-11). This first version fixes the contract; the ledger-backed check
 * replaces the body without changing any signature here.
 */
import type { Database } from "bun:sqlite";

/** Who is about to spend. Calls with no job (a chat reply) pass only `agentID`. */
export interface BudgetInput {
  agentID?: string;
  jobID?: string;
  /** The root of the delegation tree the job belongs to; a job with no parent is its own root. */
  rootJobID?: string;
}

/** Which cap stopped the run: today's total, one bot's day, or one job (root job) in all. */
export type BudgetScope = "day" | "bot" | "job";

export type BudgetDecision =
  | { ok: true }
  | { ok: false; scope: BudgetScope; spentUsd: number; capUsd: number };

/**
 * Check the caps before a model call. Pass `db` in tests; the server uses the
 * database registered by `configureBudget` at startup.
 */
export function checkBudget(_input: BudgetInput, _db?: Database): BudgetDecision {
  return { ok: true };
}

/**
 * "Continue once": let a run that hit a cap spend as much again as the per-job
 * cap, for that root job only. Returns the extra amount granted in USD.
 */
export function grantContinueOnce(_rootJobID: string, _db?: Database): number {
  return 0;
}
