/**
 * One event per successful model completion, reported by the router. The
 * default recorder drops it; Sprint 2 registers the real one at startup.
 * Frozen shared interface: change it only through the tech lead.
 */
export interface ModelUsageEvent {
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  latencyMs: number;
  purpose?: string;
}

import { log } from "../log";

let recorder: (event: ModelUsageEvent) => void = () => {};

export function setUsageRecorder(fn: (event: ModelUsageEvent) => void): void {
  recorder = fn;
}

export function recordModelUsage(event: ModelUsageEvent): void {
  // A broken recorder must never fail the model call that already succeeded.
  try {
    recorder(event);
  } catch (error) {
    log.warn(`usage recorder failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
