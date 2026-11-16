/**
 * Why a turn was aborted. Every abort that is not the turn's own timeout says
 * so, as the `reason` of the AbortController, so what the turn leaves behind
 * (the closure note, the stop reason) matches what happened.
 *
 *   owner_stop      the owner pressed Stop (or the task was cancelled)
 *   shutdown        the server is stopping
 *   device_revoked  the device that started the turn was revoked or logged out
 *   timeout         the turn ran out of time
 */
export const ABORT_REASONS = ["owner_stop", "shutdown", "device_revoked", "timeout"] as const;
export type AbortReason = (typeof ABORT_REASONS)[number];

/** The reason a signal was aborted with, when it is one of ours. */
export function abortReasonOf(signal: AbortSignal | undefined): AbortReason | undefined {
  const reason: unknown = signal?.reason;
  return ABORT_REASONS.find((known) => known === reason);
}
