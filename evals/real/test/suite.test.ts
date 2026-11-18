import { describe, expect, test } from "bun:test";
import { renderReport } from "../report";
import { parseArgs } from "../run";
import { nightlyEval, nightlyGate, stubSelfCheck } from "../self-check";
import { summarize } from "../stats";
import type { EpisodeResult } from "../types";

function episode(over: Partial<EpisodeResult> = {}): EpisodeResult {
  return {
    ep: "r5-j1-x-r1", task: "r5-j1", model: "deepseek/x", rep: 1, mode: "live", startedAt: "2026-11-18T00:00:00.000Z", wallMs: 30_000, home: "",
    grade: { pass: true, partial: 1, sub: { a: true }, forbidden: [], notes: {} },
    ledger: { calls: 3, costUsd: 0.003, unknownCostCalls: 0, inputTokens: 900, outputTokens: 90, repairCalls: null, escalatedCalls: null },
    calls: [], turnMs: [20_000], ...over,
  };
}

describe("run report", () => {
  test("live: costs shown; repair, escalation and cache-hit are n/a until measured", () => {
    const results = [episode(), episode({ rep: 2 }), episode({ rep: 3 })];
    const text = renderReport({ mode: "live", startedAt: "2026-11-18T00:00:00.000Z", k: 3, capUsd: 0.1, spentUsd: 0.009, blockedCalls: 0 }, summarize(results, 3), results);
    const row = text.split("\n").find((l) => l.startsWith("| deepseek/x"))!;
    expect(row).toContain("100.0% (1)");
    expect(row).toContain("$0.0090");
    expect(row).toContain("$0.0030");
    expect(row.split("|").map((c) => c.trim()).slice(-4, -1)).toEqual(["n/a", "n/a", "n/a"]);
    expect(text).toContain("| r5-j1 | deepseek/x | 3 / 3 | 1 | none |");
  });

  test("stub: no cost figures", () => {
    const results = [episode({ model: "stub/model", mode: "stub-good" })];
    const text = renderReport({ mode: "stub", startedAt: "x", k: 1, capUsd: 1000, spentUsd: 0, blockedCalls: 0 }, summarize(results, 1), results);
    expect(text).toContain("n/a (stub)");
    expect(text).not.toContain("$0.0030");
  });

  test("errors and skips are listed", () => {
    const results = [episode({ error: "task wall limit 60000 ms" }), episode({ ep: "s", skipped: "the spend cap has no room left", grade: null })];
    const text = renderReport({ mode: "live", startedAt: "x", k: 3, capUsd: 0.1, spentUsd: 0.1, blockedCalls: 2 }, summarize(results, 3), results);
    expect(text).toContain("task wall limit 60000 ms");
    expect(text).toContain("skipped (the spend cap has no room left)");
  });
});

describe("command line", () => {
  test("stub is the default and needs no cap", () => {
    const o = parseArgs([], Date.parse("2026-11-18T00:00:00.000Z"));
    expect(o).toMatchObject({ mode: "stub", tasks: "all", k: 3, capUsd: 1000, keep: false, bad: false });
  });
  test("live needs --cap and --models", () => {
    expect(() => parseArgs(["--mode", "live", "--models", "deepseek/x"])).toThrow("--cap");
    expect(() => parseArgs(["--mode", "live", "--cap", "0.05"])).toThrow("--models");
    expect(() => parseArgs(["--mode", "live", "--cap", "0", "--models", "a"])).toThrow("above 0");
    expect(parseArgs(["--mode", "live", "--cap", "0.05", "--models", "a,b", "--tasks", "r5-j6", "--k", "1"])).toMatchObject({ capUsd: 0.05, models: ["a", "b"], tasks: ["r5-j6"], k: 1 });
  });
  test("a flag without a value is an error", () => {
    expect(() => parseArgs(["--k"])).toThrow("--k needs a value");
  });
});

describe("nightly gate", () => {
  test("off by default, naming what is missing, without reading the key's value into the reason", () => {
    const off = nightlyGate({});
    expect(off.ok).toBe(false);
    if (!off.ok) {
      expect(off.reason).toContain("OPENROUTER_API_KEY");
      expect(off.reason).toContain("AGNI_EVAL_NIGHTLY_CAP_USD");
      expect(off.reason).toContain("AGNI_EVAL_NIGHTLY_MODELS");
    }
    const keyOnly = nightlyGate({ OPENROUTER_API_KEY: "sk-secret-value" });
    expect(keyOnly.ok).toBe(false);
    if (!keyOnly.ok) expect(keyOnly.reason).not.toContain("sk-secret-value");
  });
  test("on with a key, a cap above 0 and models", () => {
    const on = nightlyGate({ OPENROUTER_API_KEY: "k", AGNI_EVAL_NIGHTLY_CAP_USD: "0.5", AGNI_EVAL_NIGHTLY_MODELS: "deepseek/x, qwen/y" });
    expect(on.ok).toBe(true);
    if (on.ok) expect(on.config).toMatchObject({ capUsd: 0.5, models: ["deepseek/x", "qwen/y"], k: 3 });
    expect(nightlyGate({ OPENROUTER_API_KEY: "k", AGNI_EVAL_NIGHTLY_CAP_USD: "-1", AGNI_EVAL_NIGHTLY_MODELS: "a" }).ok).toBe(false);
  });
  test("the nightly check fails, and spends nothing, when it is off", async () => {
    const r = await nightlyEval({});
    expect(r.passed).toBe(false);
    expect(r.note).toContain("nightly real-model evals are off");
  });
});

describe("EVAL-007 stub self-check (real servers, no spend)", () => {
  test("every stub task's grader passes its good run and fails its bad run", async () => {
    const r = await stubSelfCheck();
    expect(r.note).not.toContain("not separated");
    expect(r.value).toBe(2);
    expect(r.passed).toBe(true);
  }, 300_000);
});
