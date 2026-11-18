/**
 * EVAL-007 (replaces the provider-backed check that was always skipped).
 *
 * Default (`bun run eval`): the real-model harness end to end at no cost.
 * Every task with a stub script runs twice on a real throwaway server: its
 * good script must pass the grader and its bad script must fail it.
 *
 * Nightly (`bun run eval:nightly`): the live suite on OpenRouter. It is off
 * until the owner gives a key, a cap and the models; without them the check
 * fails and says what is missing, and nothing is spent.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atLeast, type EvalResult } from "../lib/harness";
import { passed } from "./stats";
import { runSuite } from "./suite";
import { TASKS } from "./tasks";

export interface NightlyConfig {
  capUsd: number;
  models: string[];
  k: number;
  outDir: string;
}

/** Whether the nightly live run may spend, and with what. Never reads or returns the key's value. */
export function nightlyGate(env: Record<string, string | undefined>): { ok: true; config: NightlyConfig } | { ok: false; reason: string } {
  const missing: string[] = [];
  if (!env.OPENROUTER_API_KEY?.trim()) missing.push("OPENROUTER_API_KEY (the owner's key)");
  const cap = Number(env.AGNI_EVAL_NIGHTLY_CAP_USD);
  if (!env.AGNI_EVAL_NIGHTLY_CAP_USD?.trim() || !Number.isFinite(cap) || cap <= 0) missing.push("AGNI_EVAL_NIGHTLY_CAP_USD (a dollar cap above 0)");
  const models = (env.AGNI_EVAL_NIGHTLY_MODELS ?? "").split(",").map((m) => m.trim()).filter(Boolean);
  if (models.length === 0) missing.push("AGNI_EVAL_NIGHTLY_MODELS (comma-separated OpenRouter model ids)");
  if (missing.length > 0) return { ok: false, reason: `nightly real-model evals are off: set ${missing.join(", ")}` };
  const k = Number(env.AGNI_EVAL_NIGHTLY_K ?? "3");
  return {
    ok: true,
    config: { capUsd: cap, models, k: Number.isInteger(k) && k > 0 ? k : 3, outDir: env.AGNI_EVAL_NIGHTLY_OUT?.trim() || join("artifacts", "evals", `nightly-${Date.now()}`) },
  };
}

export async function stubSelfCheck(): Promise<EvalResult> {
  const stubbed = TASKS.filter((t) => t.stub);
  const outDir = mkdtempSync(join(tmpdir(), "agni-eval-selfcheck-"));
  const { results } = await runSuite({ mode: "stub", tasks: stubbed, models: [], k: 1, capUsd: 1000, outDir, withBad: true, log: () => {} });
  const separated = stubbed.filter((task) => {
    const good = results.find((r) => r.task === task.id && r.mode === "stub-good");
    const bad = results.find((r) => r.task === task.id && r.mode === "stub-bad");
    // The good run must pass cleanly; the bad run must finish without an error and be failed by its grader.
    return good !== undefined && passed(good) && bad !== undefined && bad.error === undefined && bad.grade !== null && bad.grade.pass === false;
  });
  const failed = stubbed.filter((t) => !separated.includes(t)).map((t) => t.id);
  // Keep the episodes only when something failed, for reading; a clean run leaves nothing behind in the temp folder.
  if (failed.length === 0) rmSync(outDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  return atLeast(
    "EVAL-007",
    "real-model harness, stub model end to end",
    "stub tasks whose grader passed the good run and failed the bad run",
    separated.length,
    stubbed.length,
    failed.length > 0
      ? `not separated: ${failed.join(", ")} (episodes in ${outDir})`
      : `${stubbed.length} of ${TASKS.length} tasks run end to end on stub models (${stubbed.map((t) => t.id).join(", ")}); the other ${TASKS.length - stubbed.length} are checked by grader mutation tests only; live runs: bun run eval:real -- --mode live`,
  );
}

export async function nightlyEval(env: Record<string, string | undefined> = process.env): Promise<EvalResult> {
  const gate = nightlyGate(env);
  if (!gate.ok) {
    return { id: "EVAL-007", name: "real-model harness, nightly live run", metric: "the nightly run was configured", value: 0, target: 1, direction: "at least", passed: false, note: gate.reason };
  }
  const { config } = gate;
  const run = await runSuite({ mode: "live", tasks: TASKS, models: config.models, k: config.k, capUsd: config.capUsd, outDir: config.outDir, apiKey: env.OPENROUTER_API_KEY!.trim() });
  const planned = TASKS.length * config.models.length * config.k;
  const accounted = run.results.filter((r) => r.grade !== null || r.skipped !== undefined).length;
  return atLeast(
    "EVAL-007",
    "real-model harness, nightly live run",
    "planned episodes graded or skipped by the cap",
    accounted,
    planned,
    `report ${run.reportPath}; charged $${run.spentUsd.toFixed(4)} of $${config.capUsd.toFixed(2)}; ${run.summaries.map((s) => `${s.model} pass^${config.k} ${s.passK === null ? "n/a" : `${(s.passK * 100).toFixed(1)}%`}`).join("; ")}`,
  );
}
