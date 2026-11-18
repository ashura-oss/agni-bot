/**
 * The numbers a real-model run reports, per model: pass^k, pass@1, cost per
 * success, latency (p50, p95, min, max), repair and escalation rates, and
 * cache-hit share. A figure that cannot be measured yet is null and prints as
 * "n/a"; it is never shown as 0.
 */
import type { CallRecord, EpisodeResult, LedgerSummary } from "./types";

export interface Dist {
  n: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
}

/** Nearest-rank percentile of an ascending list. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) throw new Error("percentile of an empty list");
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
}

export function dist(values: number[]): Dist | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), min: sorted[0]!, max: sorted[sorted.length - 1]! };
}

export interface TaskTally {
  task: string;
  /** Graded runs. */
  runs: number;
  passes: number;
  /** At least k graded runs and every one passed. */
  allPassed: boolean;
}

export interface ModelSummary {
  model: string;
  k: number;
  episodes: number;
  graded: number;
  passes: number;
  tasks: TaskTally[];
  /** Share of tasks that passed all k runs. Tasks with fewer than k graded runs are left out; null when none has k. */
  passK: number | null;
  tasksWithK: number;
  /** Share of graded episodes that passed. */
  passAt1: number | null;
  forbiddenEpisodes: number;
  errorEpisodes: number;
  skippedEpisodes: number;
  /** Calls that came back with an error status (the spend cap's refusals are counted apart). */
  failedCalls: number;
  blockedCalls: number;
  /** Tool-carrying calls answered with no text and no tool call. */
  emptyOutputs: number;
  /** Cost from the episodes' usage ledgers (Sprint 2), summed. */
  costUsd: number;
  unknownCostCalls: number;
  /** Cost the provider reported to the proxy, summed. */
  reportedCostUsd: number;
  /** Ledger cost divided by passing episodes; null with no pass or no ledger. */
  costPerSuccessUsd: number | null;
  episodeMs: Dist | null;
  turnMs: Dist | null;
  /** First-token time of tool-carrying calls, from the proxy. */
  ttftMs: Dist | null;
  repairRate: number | null;
  escalationRate: number | null;
  cacheHitShare: number | null;
}

/** An episode passes only when its grade passes and it ended without an error (a timeout or a crash is not a pass). */
export function passed(r: EpisodeResult): boolean {
  return r.grade?.pass === true && r.error === undefined && r.skipped === undefined;
}

export function isEmptyOutput(call: CallRecord): boolean {
  return call.hadTools && call.status === 200 && !call.blocked && !call.aborted && call.contentLen === 0 && call.toolNames.length === 0;
}

/** Cached share of prompt tokens over the calls whose provider reported the cached field; null when none did. */
export function cacheHitShare(calls: CallRecord[]): number | null {
  const reported = calls.filter((c) => c.cachedReported && typeof c.promptTokens === "number" && c.promptTokens > 0);
  if (reported.length === 0) return null;
  const prompt = reported.reduce((sum, c) => sum + (c.promptTokens ?? 0), 0);
  const cached = reported.reduce((sum, c) => sum + (c.cachedTokens ?? 0), 0);
  return cached / prompt;
}

/** Share of ledger calls with the optional column set; null unless every episode's ledger has the column. */
function ledgerRate(ledgers: LedgerSummary[], pick: (l: LedgerSummary) => number | null): number | null {
  const calls = ledgers.reduce((sum, l) => sum + l.calls, 0);
  if (ledgers.length === 0 || calls === 0) return null;
  let hits = 0;
  for (const ledger of ledgers) {
    const value = pick(ledger);
    if (value === null) return null;
    hits += value;
  }
  return hits / calls;
}

export function summarize(results: EpisodeResult[], k: number): ModelSummary[] {
  const models = [...new Set(results.map((r) => r.model))];
  return models.map((model) => {
    const mine = results.filter((r) => r.model === model);
    const graded = mine.filter((r) => r.grade !== null && r.skipped === undefined);
    const passes = graded.filter(passed).length;
    const tasks: TaskTally[] = [...new Set(mine.map((r) => r.task))].map((task) => {
      const runs = graded.filter((r) => r.task === task);
      const ok = runs.filter(passed).length;
      return { task, runs: runs.length, passes: ok, allPassed: runs.length >= k && ok === runs.length };
    });
    const withK = tasks.filter((t) => t.runs >= k);
    const calls = mine.flatMap((r) => r.calls);
    const ledgers = mine.map((r) => r.ledger).filter((l): l is LedgerSummary => l !== null);
    const costUsd = ledgers.reduce((sum, l) => sum + l.costUsd, 0);
    return {
      model,
      k,
      episodes: mine.length,
      graded: graded.length,
      passes,
      tasks,
      passK: withK.length > 0 ? withK.filter((t) => t.allPassed).length / withK.length : null,
      tasksWithK: withK.length,
      passAt1: graded.length > 0 ? passes / graded.length : null,
      forbiddenEpisodes: graded.filter((r) => r.grade!.forbidden.length > 0).length,
      errorEpisodes: mine.filter((r) => r.error !== undefined).length,
      skippedEpisodes: mine.filter((r) => r.skipped !== undefined).length,
      failedCalls: calls.filter((c) => c.status !== 200 && !c.blocked).length,
      blockedCalls: calls.filter((c) => c.blocked).length,
      emptyOutputs: calls.filter(isEmptyOutput).length,
      costUsd,
      unknownCostCalls: ledgers.reduce((sum, l) => sum + l.unknownCostCalls, 0),
      reportedCostUsd: calls.reduce((sum, c) => sum + (c.reportedCostUsd ?? 0), 0),
      costPerSuccessUsd: passes > 0 && ledgers.length > 0 ? costUsd / passes : null,
      episodeMs: dist(mine.filter((r) => r.skipped === undefined).map((r) => r.wallMs)),
      turnMs: dist(mine.flatMap((r) => r.turnMs)),
      ttftMs: dist(calls.filter((c) => c.hadTools && c.firstMs >= 0).map((c) => c.firstMs)),
      repairRate: ledgerRate(ledgers, (l) => l.repairCalls),
      escalationRate: ledgerRate(ledgers, (l) => l.escalatedCalls),
      cacheHitShare: cacheHitShare(calls),
    };
  });
}

/** A figure for the report. Null is "n/a", never 0. */
export function fmt(value: number | null, kind: "pct" | "usd" | "ms" | "num"): string {
  if (value === null || !Number.isFinite(value)) return "n/a";
  switch (kind) {
    case "pct":
      return `${(value * 100).toFixed(1)}%`;
    case "usd":
      return `$${value.toFixed(4)}`;
    case "ms":
      return `${Math.round(value)} ms`;
    case "num":
      return String(Number(value.toFixed(4)));
  }
}
