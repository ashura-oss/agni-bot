import { describe, expect, test } from "bun:test";
import { cacheHitShare, dist, fmt, summarize } from "../stats";
import type { CallRecord, EpisodeResult, LedgerSummary } from "../types";

function call(over: Partial<CallRecord> = {}): CallRecord {
  return {
    startedAt: "2026-11-18T00:00:00.000Z", startMs: 0, endMs: 100, path: "/api/v1/chat/completions", model: "m", hadTools: true, nMessages: 2,
    reqChars: 100, status: 200, blocked: false, aborted: false, firstMs: 40, finish: "stop", contentLen: 10, reasoningLen: 0, toolNames: [],
    cachedReported: false, chargedUsd: 0.001, ...over,
  };
}
function ledger(over: Partial<LedgerSummary> = {}): LedgerSummary {
  return { calls: 2, costUsd: 0.002, unknownCostCalls: 0, inputTokens: 100, outputTokens: 10, repairCalls: null, escalatedCalls: null, ...over };
}
function episode(task: string, pass: boolean, over: Partial<EpisodeResult> = {}): EpisodeResult {
  return {
    ep: `${task}-x`, task, model: "deepseek/x", rep: 1, mode: "live", startedAt: "2026-11-18T00:00:00.000Z", wallMs: 1000, home: "h",
    grade: { pass, partial: pass ? 1 : 0.5, sub: { a: pass }, forbidden: [], notes: {} }, ledger: ledger(), calls: [call()], turnMs: [500], ...over,
  };
}

describe("summary figures", () => {
  test("pass^3 counts tasks that passed all three runs; pass@1 counts episodes", () => {
    const results = [
      episode("A", true), episode("A", true), episode("A", true),
      episode("B", true), episode("B", false), episode("B", true),
    ];
    const [s] = summarize(results, 3);
    expect(s!.passK).toBe(0.5);
    expect(s!.tasksWithK).toBe(2);
    expect(s!.passAt1).toBeCloseTo(5 / 6, 10);
  });

  test("a task with fewer than k graded runs is left out of pass^k", () => {
    const [s] = summarize([episode("A", true), episode("A", true), episode("B", true), episode("B", true), episode("B", true)], 3);
    expect(s!.tasksWithK).toBe(1);
    expect(s!.passK).toBe(1);
    const [none] = summarize([episode("A", true)], 3);
    expect(none!.passK).toBeNull();
  });

  test("cost per success is ledger cost over passes, and n/a with no pass", () => {
    const [s] = summarize([episode("A", true), episode("A", false)], 3);
    expect(s!.costUsd).toBeCloseTo(0.004, 10);
    expect(s!.costPerSuccessUsd).toBeCloseTo(0.004, 10);
    const [none] = summarize([episode("A", false)], 3);
    expect(none!.costPerSuccessUsd).toBeNull();
  });

  test("repair rate is n/a unless every ledger has the column", () => {
    const [missing] = summarize([episode("A", true, { ledger: ledger({ repairCalls: 1 }) }), episode("A", true)], 3);
    expect(missing!.repairRate).toBeNull();
    const [present] = summarize([episode("A", true, { ledger: ledger({ repairCalls: 1 }) }), episode("A", true, { ledger: ledger({ repairCalls: 0 }) })], 3);
    expect(present!.repairRate).toBe(0.25);
  });

  test("cache-hit share uses only calls that reported the field, and is n/a when none did", () => {
    expect(cacheHitShare([call({ promptTokens: 1000 })])).toBeNull();
    expect(cacheHitShare([call({ promptTokens: 1000, cachedReported: true, cachedTokens: 250 }), call({ promptTokens: 1000 })])).toBe(0.25);
  });

  test("empty outputs, blocked and failed calls are counted apart", () => {
    const calls = [
      call({ contentLen: 0, toolNames: [] }),
      call({ contentLen: 0, toolNames: ["read_file"] }),
      call({ hadTools: false, contentLen: 0 }),
      call({ status: 402, blocked: true, contentLen: 0 }),
      call({ status: 500, contentLen: 0 }),
    ];
    const [s] = summarize([episode("A", true, { calls })], 3);
    expect(s!.emptyOutputs).toBe(1);
    expect(s!.blockedCalls).toBe(1);
    expect(s!.failedCalls).toBe(1);
  });

  test("forbidden, error and skipped episodes are counted", () => {
    const results = [
      episode("A", false, { grade: { pass: false, partial: 1, sub: { a: true }, forbidden: ["deleted a file"], notes: {} } }),
      episode("A", false, { error: "server did not become healthy in time", grade: null }),
      episode("A", false, { skipped: "spend cap", grade: null, calls: [], ledger: null, turnMs: [] }),
    ];
    const [s] = summarize(results, 3);
    expect(s!.forbiddenEpisodes).toBe(1);
    expect(s!.errorEpisodes).toBe(1);
    expect(s!.skippedEpisodes).toBe(1);
    expect(s!.graded).toBe(1);
  });

  test("distributions report p50, p95, min and max", () => {
    expect(dist([5, 1, 3, 2, 4])).toEqual({ n: 5, p50: 3, p95: 5, min: 1, max: 5 });
    expect(dist([])).toBeNull();
  });

  test("n/a is printed for null, never 0", () => {
    expect(fmt(null, "pct")).toBe("n/a");
    expect(fmt(0, "pct")).toBe("0.0%");
    expect(fmt(0.01234567, "usd")).toBe("$0.0123");
    expect(fmt(1234.4, "ms")).toBe("1234 ms");
  });
});
