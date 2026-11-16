import { priceCall, type PricedUsageEvent } from "../models/prices";
import { setRouteGate, type RouteGateCall, type RouteGateDecision } from "../models/router";
import { setUsageRecorder } from "../models/usage-hook";
import { configureBudget, checkBudget, markLedgerWrite, resolveRootJobID } from "../policy/budget";
import { recordLedgerCall, type LedgerCall } from "../stores/usage";
import type { StartupContext } from "./context";

/**
 * Says why a run may not call a model right now (the owner paused everything,
 * or this bot), or null when it may. S2-2 supplies the real one from
 * `policy/pause.ts` once it is merged: `setPauseCheck((call) => isRunPaused(call) ? "..." : null)`.
 */
export type PauseCheck = (call: RouteGateCall) => string | null;

let pauseCheck: PauseCheck | null = null;

export function setPauseCheck(check: PauseCheck | null): void {
  pauseCheck = check;
}

function refuse(reason: string, message: string, detail?: Record<string, unknown>): RouteGateDecision {
  return { ok: false, reason, message, ...(detail ? { detail } : {}) };
}

/** The one check before every model call: attribution, then pause, then spend caps. */
function gate(call: RouteGateCall): RouteGateDecision {
  if (!call.agentID || !call.kind) {
    return refuse("unattributed", "A model call must say which bot it is for and whether it is a turn or a side call; refusing it.");
  }
  const paused = pauseCheck?.(call);
  if (paused) return refuse("paused", paused);
  const budget = checkBudget({
    agentID: call.agentID,
    ...(call.jobID ? { jobID: call.jobID } : {}),
    ...(call.rootJobID ? { rootJobID: call.rootJobID } : {}),
  });
  if (budget.ok) return { ok: true };
  const detail = { scope: budget.scope, spentUsd: budget.spentUsd, capUsd: budget.capUsd };
  if (budget.reason === "budget_unreadable") return refuse("budget_unreadable", "Spend could not be checked, so the call was stopped.", detail);
  if (budget.reason === "cost_unknown") {
    return refuse("cost_unknown", `Part of today's spend (${budget.scope}) could not be priced, so the call was stopped until you continue once.`, detail);
  }
  return refuse("over_cap", `Spend cap reached (${budget.scope}): $${budget.spentUsd.toFixed(4)} of $${budget.capUsd.toFixed(2)}.`, detail);
}

/**
 * Sprint 2 ledger startup (S2-10, S2-11): every completed model call, from the
 * router's usage hook, becomes one `usage_ledger` row with its cost; the
 * spend-cap check is pointed at the same database; and the router's gate is
 * installed so spend, pause and attribution are checked before every call.
 *
 * A call that does not say what it is for is recorded as a side call. A failed
 * ledger write is reported to the budget check, which denies calls until a
 * write works again, then rethrown for the hook to log.
 */
export async function startupS2Ledger(ctx: StartupContext): Promise<void> {
  const { db } = ctx;
  setUsageRecorder((event: PricedUsageEvent) => {
    // The provider's own figure is the bill, but only openrouter's is trusted; anything else is priced from the table.
    const reported = event.provider === "openrouter" && !event.estimated ? event.reportedCostUsd : undefined;
    let call: LedgerCall;
    try {
      const priced = reported !== undefined
        ? { costUsd: reported, source: "reported" as const }
        : priceCall({
          provider: event.provider,
          model: event.model,
          inputTokens: event.inputTokens,
          cachedInputTokens: event.cachedInputTokens,
          outputTokens: event.outputTokens,
        });
      const rootJobID = event.rootJobID ?? (event.jobID ? resolveRootJobID(db, event.jobID) : undefined);
      call = {
        provider: event.provider,
        model: event.model,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cachedInputTokens: event.cachedInputTokens,
        latencyMs: event.latencyMs,
        costUsd: priced.costUsd,
        costSource: event.estimated && priced.costUsd !== null ? "estimate" : priced.source,
        agentID: event.agentID,
        jobID: event.jobID,
        rootJobID,
        kind: event.kind ?? "side",
        purpose: event.purpose,
      };
      recordLedgerCall(db, call);
      markLedgerWrite(true);
    } catch (error) {
      markLedgerWrite(false);
      throw error;
    }
  });
  configureBudget(db);
  setRouteGate(gate);
}
