/**
 * Runs a set of episodes and writes the run's report, results and spend
 * record. Live runs go to OpenRouter under a hard spend cap; stub runs use
 * the tasks' scripted models and cost nothing.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEpisode } from "./episode";
import { renderReport } from "./report";
import { priceFor, SpendGuard } from "./spend";
import { passed, summarize, type ModelSummary } from "./stats";
import type { EpisodeMode, EpisodeResult, TaskDef } from "./types";
import { startWebFixtures } from "./web-fixtures";

export interface SuiteOptions {
  mode: "live" | "stub";
  tasks: TaskDef[];
  /** OpenRouter model ids (live). Stub runs ignore it. */
  models: string[];
  k: number;
  capUsd: number;
  outDir: string;
  /** Required for live runs. Never written anywhere. */
  apiKey?: string;
  keepHomes?: boolean;
  /** Stub runs: also run each task's bad script once, so the report shows the grader failing it. */
  withBad?: boolean;
  /** Live runs: allow a model with no entry in the price table (priced, and held, at the fallback price). */
  allowUnpriced?: boolean;
  log?: (line: string) => void;
}

export interface SuiteResult {
  results: EpisodeResult[];
  summaries: ModelSummary[];
  reportPath: string;
  spentUsd: number;
}

export async function runSuite(o: SuiteOptions): Promise<SuiteResult> {
  if (o.mode === "live" && !o.apiKey) throw new Error("a live run needs OPENROUTER_API_KEY in the environment");
  if (o.mode === "live" && o.models.length === 0) throw new Error("a live run needs at least one model (--models)");
  if (!Number.isInteger(o.k) || o.k < 1) throw new Error(`k must be a whole number of runs, 1 or more (got ${o.k})`);
  if (o.mode === "live") {
    const unpriced = o.models.filter((m) => !priceFor(m).known);
    if (unpriced.length > 0 && !o.allowUnpriced) {
      throw new Error(
        `no price is known for ${unpriced.join(", ")}, so the spend cap cannot be trusted. Add the model to apps/server/src/models/prices.ts, or pass --allow-unpriced to price it at the fallback ($1 in / $4 out per million) with OpenRouter held to that price.`,
      );
    }
  }
  const log = o.log ?? ((line: string) => console.log(line));
  const startedAt = new Date().toISOString();
  mkdirSync(o.outDir, { recursive: true });
  const guard = new SpendGuard(o.capUsd);
  const webRoot = mkdtempSync(join(tmpdir(), "agni-eval-web-"));
  const web = startWebFixtures(webRoot);
  const results: EpisodeResult[] = [];
  const plan: Array<{ task: TaskDef; model: string; rep: number; mode: EpisodeMode }> = [];
  if (o.mode === "live") {
    for (let rep = 1; rep <= o.k; rep++) for (const task of o.tasks) for (const model of o.models) plan.push({ task, model, rep, mode: "live" });
  } else {
    const stubbed = o.tasks.filter((t) => t.stub);
    for (let rep = 1; rep <= o.k; rep++) for (const task of stubbed) plan.push({ task, model: "stub", rep, mode: "stub-good" });
    if (o.withBad) for (const task of stubbed) plan.push({ task, model: "stub", rep: 1, mode: "stub-bad" });
  }
  try {
    for (const item of plan) {
      if (o.mode === "live" && guard.remainingUsd() <= 0) {
        results.push({
          ep: `${item.task.id}-skipped-r${item.rep}`, task: item.task.id, model: item.model, rep: item.rep, mode: item.mode, startedAt: new Date().toISOString(),
          wallMs: 0, home: "", grade: null, skipped: "the spend cap has no room left", ledger: null, calls: [], turnMs: [],
        });
        log(`skip ${item.task.id} ${item.model} r${item.rep}: the spend cap has no room left`);
        continue;
      }
      const r = await runEpisode({ task: item.task, model: item.model, rep: item.rep, mode: item.mode, guard, web, outDir: o.outDir, ...(o.apiKey ? { apiKey: o.apiKey } : {}), ...(o.keepHomes ? { keepHome: true } : {}) });
      results.push(r);
      log(`${r.ep} ${r.grade ? (passed(r) ? "PASS" : "fail") : "NOGRADE"} partial=${r.grade ? r.grade.partial.toFixed(2) : "-"} forbidden=${r.grade?.forbidden.length ?? "-"} wall=${Math.round(r.wallMs / 1000)}s charged=$${r.calls.reduce((s, c) => s + c.chargedUsd, 0).toFixed(4)}${r.error ? ` ERROR: ${r.error.slice(0, 120)}` : ""}`);
    }
  } finally {
    web.stop();
    rmSync(webRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  const summaries = summarize(results.filter((r) => r.mode !== "stub-bad"), o.k);
  const reportPath = join(o.outDir, "report.md");
  writeFileSync(reportPath, renderReport({ mode: o.mode, startedAt, k: o.k, capUsd: o.capUsd, spentUsd: guard.spentUsd, blockedCalls: guard.blockedCalls }, summaries, results));
  writeFileSync(join(o.outDir, "results.json"), JSON.stringify(results, null, 1));
  writeFileSync(
    join(o.outDir, "spend.json"),
    JSON.stringify(
      {
        mode: o.mode,
        capUsd: o.capUsd,
        chargedUsd: guard.spentUsd,
        blockedCalls: guard.blockedCalls,
        providerReportedUsd: results.flatMap((r) => r.calls).reduce((s, c) => s + (c.reportedCostUsd ?? 0), 0),
        ledgerUsd: results.reduce((s, r) => s + (r.ledger?.costUsd ?? 0), 0),
        ledgerUnknownCostCalls: results.reduce((s, r) => s + (r.ledger?.unknownCostCalls ?? 0), 0),
      },
      null,
      1,
    ),
  );
  return { results, summaries, reportPath, spentUsd: guard.spentUsd };
}
