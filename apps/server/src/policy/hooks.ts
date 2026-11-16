/**
 * The seams where other Sprint 2 tasks plug into the engine.
 *
 *  - `checkBudget` is S2-3's (`policy/budget.ts`): is there money left?
 *  - `isRunPaused` is S2-2's (`policy/pause.ts`): has the owner pulled the switch?
 *
 * Both default to "carry on", so the engine is complete without them. When
 * the task that owns one merges, `startup/s2.ts` calls `setPolicyHooks` with
 * the real function; nothing in the engine changes.
 */
import type { CheckBudget, IsRunPaused } from "./types";

export interface PolicyHooks {
  checkBudget: CheckBudget;
  isRunPaused: IsRunPaused;
}

const DEFAULT_HOOKS: PolicyHooks = {
  checkBudget: () => ({ ok: true }),
  isRunPaused: () => null,
};

export const policyHooks: PolicyHooks = { ...DEFAULT_HOOKS };

export function setPolicyHooks(hooks: Partial<PolicyHooks>): void {
  Object.assign(policyHooks, hooks);
}

/** Back to the defaults. For tests. */
export function resetPolicyHooks(): void {
  Object.assign(policyHooks, DEFAULT_HOOKS);
}
