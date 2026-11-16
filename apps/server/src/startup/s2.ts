import { setRouteGate } from "../models/router";
import { setUsageRecorder } from "../models/usage-hook";
import { noopAuditSink, setAuditSink } from "../policy/audit-sink";
import { configureBudget } from "../policy/budget";
import { resetPolicyHooks } from "../policy/hooks";
import { unbindPauseStore } from "../policy/pause";
import { setSpendProvider } from "../ws/policy-frames";
import type { StartupContext } from "./context";
import { startupS2Audit, stopPauseWatcher } from "./s2-audit";
import { setPauseCheck, startupS2Ledger } from "./s2-ledger";

/** Sprint 2 startup work (audit sink, pause switch, spend frames, usage recorder, router gate). Called once from `serve()`; each task owns its own file. */
export async function startupS2(ctx: StartupContext): Promise<void> {
  await startupS2Audit(ctx);
  await startupS2Ledger(ctx);
}

/**
 * Undo everything `startupS2` installed: the watcher, the pause binding, the audit sink, the usage recorder, the
 * router gate and its pause check, the budget database, the spend provider and the engine's checks. For tests
 * and for a server shutting down, so one run's wiring never leaks into the next.
 */
export function resetS2Startup(): void {
  stopPauseWatcher();
  unbindPauseStore();
  setAuditSink(noopAuditSink);
  setUsageRecorder(() => {});
  setRouteGate(null);
  setPauseCheck(null);
  configureBudget(null);
  setSpendProvider(null);
  resetPolicyHooks();
}
