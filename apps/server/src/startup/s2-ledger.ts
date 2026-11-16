import { computeCostUsd } from "../models/prices";
import { setUsageRecorder, type ModelUsageEvent } from "../models/usage-hook";
import { configureBudget } from "../policy/budget";
import { recordLedgerCall } from "../stores/usage";
import type { StartupContext } from "./context";

/**
 * Sprint 2 ledger startup (S2-10, S2-11): every completed model call, from the
 * router's usage hook, becomes one `usage_ledger` row with its cost, and the
 * spend-cap check is pointed at the same database.
 *
 * A call that does not say what it is for is recorded as a side call: the
 * task loop is the only caller that is a turn, and it names itself (`kind`).
 */
export async function startupS2Ledger(ctx: StartupContext): Promise<void> {
  const { db } = ctx;
  setUsageRecorder((event: ModelUsageEvent) => {
    recordLedgerCall(db, {
      provider: event.provider,
      model: event.model,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cachedInputTokens: event.cachedInputTokens,
      latencyMs: event.latencyMs,
      costUsd: computeCostUsd({
        provider: event.provider,
        model: event.model,
        inputTokens: event.inputTokens,
        cachedInputTokens: event.cachedInputTokens,
        outputTokens: event.outputTokens,
      }),
      agentID: event.agentID,
      jobID: event.jobID,
      rootJobID: event.rootJobID,
      kind: event.kind ?? "side",
      purpose: event.purpose,
    });
  });
  configureBudget(db);
}
