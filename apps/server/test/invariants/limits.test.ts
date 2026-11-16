/**
 * INV-14: depth, fan-out and self-scheduled-job limits hold across delegation
 * (S2-09, decision D2; track-c C5.4 item 14).
 *
 *   - A chain of delegations is at most three deep.
 *   - At most four delegations are in flight per root job.
 *   - A bot has at most ten active self-scheduled jobs.
 *
 * The root-job wall-time cap (30 minutes) needs a clock the tests can move;
 * there is no seam for one yet, so it is not covered here (listed in the report).
 */
import { describe, expect } from "bun:test";
import { scenarioTest, useScenarios, calls, loadTools, say, type ToolCallSpec } from "../scenarios/harness";
import { allCallsTo, call, playTurn, resultJson } from "./support";

const scenarios = useScenarios();

describe("INV-14 delegation depth", () => {
  scenarioTest("a third hop is refused, the work behind it never starts, and the refusal is something the bot can read", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    s.model.queue(
      call("handoff", { toAgentID: "researcher", task: "Step one." }, "call_hop_1"), // ea, depth 1
      call("handoff", { toAgentID: "analyst", task: "Step two." }, "call_hop_2"), // researcher, depth 2
      call("handoff", { toAgentID: "coder", task: "Step three." }, "call_hop_3"), // analyst, depth 3: no further
      say("I cannot hand this on."),
      say("The analyst could not go further."),
      say("Done."),
    );
    await playTurn(s, a, "chain three bots together");
    const hops = allCallsTo(s, "handoff");
    expect(hops.length, "the chain did not reach its third hop; the script is out of step").toBe(3);
    expect(Object.hasOwn(resultJson(hops[2]), "error"), "a hop past the depth limit was accepted").toBe(true);
    expect(s.get("SELECT id FROM turns WHERE agent_id = 'coder'"), "the coder started work past the depth limit").toBeNull();
  });
});

// waits for S2-1b / S2-3 (S2-09: at most 4 delegations in flight per root job)
describe("INV-14 fan-out", () => {
  scenarioTest("six delegations in one go: at most four are accepted, the rest are refused with an error", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    const targets = ["researcher", "analyst", "coder"];
    const specs: ToolCallSpec[] = Array.from({ length: 6 }, (_, index) => ({
      id: `call_fan_${index}`,
      name: "delegate_task",
      args: { toAgentID: targets[index % targets.length], goal: `Independent piece of work number ${index + 1}.` },
    }));
    s.model.queue(calls(...specs), say("All started."));
    const report = await playTurn(s, a, "split this into six pieces");
    const outcomes = specs.map((spec) => report.calls.find((entry) => entry.callID === spec.id)!);
    const accepted = outcomes.filter((record) => !Object.hasOwn(resultJson(record), "error"));
    expect(accepted.length, "more than four delegations were in flight for one root job").toBeLessThanOrEqual(4);
    expect(accepted.length, "the cap refused everything (it should stop the fifth, not the first)").toBeGreaterThanOrEqual(4);
    expect(outcomes.length - accepted.length, "no delegation was refused").toBeGreaterThanOrEqual(2);
  });
});

// waits for S2-1b (S2-09: at most 10 active self-scheduled jobs per bot)
describe("INV-14 self-scheduled jobs", () => {
  scenarioTest("a bot cannot hold more than ten active scheduled jobs of its own", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    const specs: ToolCallSpec[] = Array.from({ length: 12 }, (_, index) => ({
      id: `call_sched_${index}`,
      name: "job_schedule",
      args: { text: `Check the warehouse report, round ${index + 1}.`, at: new Date(Date.now() + (index + 2) * 3_600_000).toISOString() },
    }));
    s.model.queue(loadTools("job_schedule"), calls(...specs.slice(0, 6)), calls(...specs.slice(6)), say("Scheduled."));
    const report = await playTurn(s, a, "schedule twelve checks for me");
    const active = s.get<{ n: number }>("SELECT count(*) AS n FROM jobs WHERE kind = 'turn' AND state = 'queued' AND payload LIKE '%Check the warehouse report%'")!.n;
    expect(active, "a bot scheduled more than ten jobs for itself").toBeLessThanOrEqual(10);
    expect(active, "the cap refused jobs before the tenth").toBeGreaterThanOrEqual(10);
    const refused = specs.filter((spec) => Object.hasOwn(resultJson(report.calls.find((entry) => entry.callID === spec.id)), "error"));
    expect(refused.length, "no call was told it was over the limit").toBeGreaterThanOrEqual(2);
  });
});
