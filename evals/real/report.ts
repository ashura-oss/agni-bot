/**
 * The run report: one Markdown page per run. A figure that cannot be
 * measured yet shows as "n/a"; stub runs show no cost, since a scripted
 * model costs nothing and the ledger prices it at the fallback rate.
 */
import { fmt, type Dist, type ModelSummary } from "./stats";
import type { EpisodeMode, EpisodeResult } from "./types";

export interface RunMeta {
  mode: "live" | "stub";
  startedAt: string;
  k: number;
  capUsd: number;
  /** What the spend guard charged in this run. */
  spentUsd: number;
  blockedCalls: number;
}

const distText = (d: Dist | null): string => (d ? `${fmt(d.p50, "ms")} / ${fmt(d.p95, "ms")} (min ${fmt(d.min, "ms")}, max ${fmt(d.max, "ms")}, n ${d.n})` : "n/a");

export function renderReport(meta: RunMeta, summaries: ModelSummary[], results: EpisodeResult[]): string {
  const stub = meta.mode === "stub";
  const cost = (v: number | null): string => (stub ? "n/a (stub)" : fmt(v, "usd"));
  const out: string[] = [];
  out.push(`# Real-model eval run, ${meta.startedAt}`, "");
  out.push(`Mode: ${meta.mode}. k = ${meta.k}. Spend cap: ${fmt(meta.capUsd, "usd")}; charged by the spend guard: ${fmt(meta.spentUsd, "usd")}; calls refused by the cap: ${meta.blockedCalls}.`, "");
  out.push(`| Model | pass^${meta.k} (tasks with ${meta.k} runs) | pass@1 | Forbidden | Errors | Empty outputs | Cost (ledger) | Cost per success | Episode p50 / p95 | Turn p50 / p95 | First token p50 | Repair rate | Escalation rate | Cache-hit share |`);
  out.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const s of summaries) {
    out.push(
      `| ${s.model} | ${fmt(s.passK, "pct")} (${s.tasksWithK}) | ${fmt(s.passAt1, "pct")} (${s.passes}/${s.graded}) | ${s.forbiddenEpisodes} | ${s.errorEpisodes} | ${s.emptyOutputs} | ${cost(s.costUsd)}${!stub && s.unknownCostCalls > 0 ? ` + ${s.unknownCostCalls} unknown` : ""} | ${cost(s.costPerSuccessUsd)} | ${distText(s.episodeMs)} | ${distText(s.turnMs)} | ${s.ttftMs ? fmt(s.ttftMs.p50, "ms") : "n/a"} | ${fmt(s.repairRate, "pct")} | ${fmt(s.escalationRate, "pct")} | ${fmt(s.cacheHitShare, "pct")} |`,
    );
  }
  out.push("");
  out.push("Repair and escalation rates are n/a until the usage ledger has their columns; cache-hit share is n/a until a provider reports cached tokens.", "");
  out.push("## Per task", "", "| Task | Model | Passed / runs | Mean partial | Forbidden actions |", "| --- | --- | --- | --- | --- |");
  const keyOf = (r: EpisodeResult): string => `${r.task}\u0000${r.model}\u0000${r.mode}`;
  const groups = new Map<string, EpisodeResult[]>();
  for (const r of results) groups.set(keyOf(r), [...(groups.get(keyOf(r)) ?? []), r]);
  for (const rows of groups.values()) {
    const graded = rows.filter((r) => r.grade !== null);
    const passed = graded.filter((r) => r.grade!.pass).length;
    const partial = graded.length > 0 ? graded.reduce((sum, r) => sum + r.grade!.partial, 0) / graded.length : null;
    const forbidden = [...new Set(graded.flatMap((r) => r.grade!.forbidden))];
    const mode: EpisodeMode = rows[0]!.mode;
    const label = mode === "live" ? rows[0]!.model : `${rows[0]!.model} (${mode})`;
    out.push(`| ${rows[0]!.task} | ${label} | ${passed} / ${rows.length} | ${fmt(partial, "num")} | ${forbidden.length > 0 ? forbidden.join("; ") : "none"} |`);
  }
  const problems = results.filter((r) => r.error !== undefined || r.skipped !== undefined);
  if (problems.length > 0) {
    out.push("", "## Errors and skips", "");
    for (const r of problems) out.push(`- ${r.ep}: ${r.skipped !== undefined ? `skipped (${r.skipped})` : r.error}`);
  }
  return out.join("\n") + "\n";
}
