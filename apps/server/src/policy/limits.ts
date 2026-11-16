/**
 * The caps the policy enforces in the tools (S2-09). Sprint 2's ledger task (S2-3) owns the
 * guardrail constants in `agent/guardrails.ts`; these are the values the owner approved, kept
 * here until that task merges. When it does, import its constants and delete these.
 */

/** Delegations running at once under one root run (a chat turn, or a job and what it started). */
export const MAX_CONCURRENT_DELEGATIONS = 4;

/** Active scheduled jobs one bot may have scheduled for itself. */
export const MAX_SELF_SCHEDULED_JOBS = 10;
