/**
 * `bun run eval` — the acceptance suite.
 *
 * The deterministic evals run everywhere. EVAL-007 runs the real-model
 * harness against stub models. The nightly run (`bun run eval:nightly`)
 * runs the live suite instead (off until configured) and turns the latency
 * budget from a warning into a failure.
 */
import { runEvals } from "./lib/harness";
import {
  confidenceFloorIsPublished,
  evalContinuity,
  evalCost,
  evalDrift,
  evalGate,
  evalLeak,
  evalNeedle,
} from "./evals";
import { nightlyEval, stubSelfCheck } from "./real/self-check";

const nightly = process.env.AGNI_EVAL_NIGHTLY === "1";

const report = await runEvals([
  { id: "EVAL-001", name: "needle recall", run: evalNeedle },
  { id: "EVAL-002", name: "gate misses and the sweep", run: async () => [await evalGate(), confidenceFloorIsPublished()] },
  { id: "EVAL-003", name: "continuity", run: evalContinuity },
  { id: "EVAL-004", name: "leaks", run: evalLeak },
  { id: "EVAL-005", name: "cost and latency", run: evalCost },
  { id: "EVAL-006", name: "drift", run: evalDrift },
  // EVAL-007: the real-model harness. Default: stub models end to end, no spend. Nightly: the live suite,
  // off until the owner sets a key, a cap and the models (evals/real/self-check.ts).
  { id: "EVAL-007", name: "real-model harness", run: async () => (nightly ? nightlyEval() : stubSelfCheck()) },
]);

if (nightly) {
  console.log("\n(nightly: the latency budget is a failure, not a warning)");
}

if (report.failed > 0) process.exit(1);
