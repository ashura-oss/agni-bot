/**
 * Where the engine asks "is the owner's switch pulled?" and "is there money left?".
 *
 * The defaults are the real checks: `isRunPaused` from `policy/pause.ts` and `checkBudget` from
 * `policy/budget.ts`, turned into the engine's verdicts with the owner wording from `budget-messages.ts`.
 * Each real check answers only once the server has pointed it at the database (`startup/s2-audit.ts` binds
 * the pause state, `startup/s2-ledger.ts` configures the budget). Before that, in a tool or a test that
 * never started the server, nothing is paused and nothing is capped; a started server whose state cannot be
 * read fails closed inside the checks themselves.
 *
 * `setPolicyHooks` replaces either one (the engine's own tests do, to ask one question at a time).
 */
import { budgetRunKey, checkBudget, isBudgetConfigured } from "./budget";
import { budgetStopMessage, pauseStopMessage } from "./budget-messages";
import { isRunPaused } from "./pause";
import type { BudgetStopDetail, CheckBudget, IsRunPaused } from "./types";

export interface PolicyHooks {
  checkBudget: CheckBudget;
  isRunPaused: IsRunPaused;
}

const realPaused: IsRunPaused = (run) => {
  const verdict = isRunPaused({ agentID: run.bot });
  if (!verdict.paused) return null;
  const scope = verdict.scope ?? "all";
  return { scope, message: pauseStopMessage(run.services.botName, { scope, ...(verdict.unavailable ? { unavailable: true } : {}) }) };
};

const realBudget: CheckBudget = (run) => {
  if (!isBudgetConfigured()) return { ok: true };
  const input = {
    agentID: run.bot,
    ...(run.jobID ? { jobID: run.jobID } : {}),
    ...(run.rootJob ? { rootJobID: run.rootJob } : {}),
  };
  const verdict = checkBudget(input);
  if (verdict.ok) return { ok: true };
  const runKey = budgetRunKey(input);
  const detail: BudgetStopDetail = {
    scope: verdict.scope, reason: verdict.reason, spentUsd: verdict.spentUsd, capUsd: verdict.capUsd,
    ...(runKey !== undefined ? { runKey } : {}),
  };
  return {
    ok: false, scope: verdict.scope, spentUSD: verdict.spentUsd, capUSD: verdict.capUsd,
    message: budgetStopMessage(run.services.botName, detail), detail,
  };
};

const DEFAULT_HOOKS: PolicyHooks = { checkBudget: realBudget, isRunPaused: realPaused };

export const policyHooks: PolicyHooks = { ...DEFAULT_HOOKS };

export function setPolicyHooks(hooks: Partial<PolicyHooks>): void {
  Object.assign(policyHooks, hooks);
}

/** Back to the real checks. For tests. */
export function resetPolicyHooks(): void {
  Object.assign(policyHooks, DEFAULT_HOOKS);
}
