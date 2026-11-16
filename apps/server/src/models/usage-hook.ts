import { log } from "../log";

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
  agentID?: string;
  jobID?: string;
  rootJobID?: string;
  /** "turn": the bot's own reply; "side": any other model call made for it. */
  kind?: "turn" | "side";
}

export type UsageRecorder = (event: ModelUsageEvent) => void | Promise<void>;

let recorder: UsageRecorder = () => {};

export function setUsageRecorder(fn: UsageRecorder): void {
  recorder = fn;
}

/**
 * Hand the event to the recorder. A recorder that throws or rejects is logged and
 * swallowed: it must never fail a model call that already succeeded.
 */
export function recordModelUsage(event: ModelUsageEvent): void {
  const failed = (error: unknown): void => {
    log.warn(`usage recorder failed: ${error instanceof Error ? error.message : String(error)}`);
  };
  try {
    const pending = recorder(event);
    if (pending) pending.catch(failed);
  } catch (error) {
    failed(error);
  }
}
