/**
 * `bun run eval:real -- [options]`: the real-model eval suite.
 *
 *   --mode stub|live   stub (default): scripted models, no spend.
 *                      live: OpenRouter, needs OPENROUTER_API_KEY in the environment and --cap.
 *   --models a,b       OpenRouter model ids (live).
 *   --tasks a,b|all    task ids (default: all; stub runs only the tasks with a stub script).
 *   --k N              runs per task and model (default 3).
 *   --cap USD          hard spend cap for this run (live: required).
 *   --out DIR          where the report and episodes go (default artifacts/evals/<mode>-<time>).
 *   --keep             keep each episode's throwaway AGNI_HOME.
 *   --bad              stub: also run each task's bad script once.
 *
 * The key is read from the environment and handed to the proxy only; it is
 * never printed or written.
 */
import { join } from "node:path";
import { runSuite } from "./suite";
import { findTasks } from "./tasks";

export interface CliOptions {
  mode: "live" | "stub";
  models: string[];
  tasks: string[] | "all";
  k: number;
  capUsd: number;
  outDir: string;
  keep: boolean;
  bad: boolean;
}

export function parseArgs(argv: string[], now = Date.now()): CliOptions {
  const value = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${name} needs a value`);
    return v;
  };
  const mode = value("--mode") ?? "stub";
  if (mode !== "live" && mode !== "stub") throw new Error(`--mode must be stub or live (got ${mode})`);
  const list = (v: string | undefined): string[] => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const tasksArg = value("--tasks");
  const k = Number(value("--k") ?? "3");
  if (!Number.isInteger(k) || k < 1) throw new Error("--k must be a whole number, 1 or more");
  const capText = value("--cap");
  if (mode === "live" && capText === undefined) throw new Error("a live run needs --cap <dollars>: the run stops spending there");
  const capUsd = capText === undefined ? 1000 : Number(capText);
  if (!Number.isFinite(capUsd) || capUsd <= 0) throw new Error(`--cap must be a dollar amount above 0 (got ${capText})`);
  const models = list(value("--models"));
  if (mode === "live" && models.length === 0) throw new Error("a live run needs --models <id,id>");
  return {
    mode,
    models,
    tasks: tasksArg === undefined || tasksArg === "all" ? "all" : list(tasksArg),
    k,
    capUsd,
    outDir: value("--out") ?? join("artifacts", "evals", `${mode}-${new Date(now).toISOString().replace(/[:.]/g, "-")}`),
    keep: argv.includes("--keep"),
    bad: argv.includes("--bad"),
  };
}

if (import.meta.main) {
  let opts: CliOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (opts.mode === "live" && !apiKey) {
    console.error("a live run needs OPENROUTER_API_KEY in the environment");
    process.exit(2);
  }
  const run = await runSuite({
    mode: opts.mode,
    tasks: findTasks(opts.tasks),
    models: opts.models,
    k: opts.k,
    capUsd: opts.capUsd,
    outDir: opts.outDir,
    ...(opts.mode === "live" && apiKey ? { apiKey } : {}),
    keepHomes: opts.keep,
    withBad: opts.bad,
  });
  console.log(`\nreport: ${run.reportPath}\ncharged by the spend guard: $${run.spentUsd.toFixed(4)} of $${opts.capUsd.toFixed(2)}`);
}
