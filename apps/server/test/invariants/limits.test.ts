/**
 * INV-14: depth, fan-out and self-scheduled-job limits hold across delegation
 * (S2-09, decision D2; track-c C5.4 item 14).
 *
 *   - A chain of delegations is at most three deep.
 *   - At most four delegations are in flight per root job.
 *   - A bot has at most ten active self-scheduled jobs.
 *
 *   - A root job (a chat turn, or a job, and everything it delegated) stops once
 *     30 minutes have passed since the root began. The tests move JavaScript's
 *     clock (`setSystemTime`) while a run is held between two steps.
 *   - The owner can change the fan-out and self-scheduled-job numbers
 *     (`setRunCaps`); the tools read them live.
 */
import { afterEach, describe, expect, setSystemTime } from "bun:test";
import { enqueueJob } from "../../src/stores/jobs";
import { setRunCaps } from "../../src/stores/policy-settings";
import { scenarioTest, useScenarios, calls, gate, loadTools, say, type ModelStep, type ToolCallSpec } from "../scenarios/harness";
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

const minutes = (count: number): number => count * 60_000;
/** Moves JavaScript's clock forward; `afterEach` puts it back. Timers keep real time. */
const later = (ms: number): void => { setSystemTime(new Date(Date.now() + ms)); };
afterEach(() => setSystemTime());

/** A model that takes one held step, then two more: the clock is moved while it is held. */
function heldRun(): { held: ReturnType<typeof gate>; steps: ModelStep[] } {
  const held = gate();
  return {
    held,
    steps: [
      { text: "Looking.", calls: [{ name: "memory_search", args: { query: "first" }, id: "call_first" }], hold: held },
      { calls: [{ name: "memory_search", args: { query: "second" }, id: "call_second" }] },
      say("Done."),
    ],
  };
}

const delegations = (count: number, targets: string[]): ToolCallSpec[] => Array.from({ length: count }, (_, index) => ({
  id: `call_cap_${index}`,
  name: "delegate_task",
  args: { toAgentID: targets[index % targets.length], goal: `Independent piece of work number ${index + 1}.` },
}));

describe("INV-14 delegation and scheduling read the owner's numbers", () => {
  scenarioTest("with the fan-out cap set to two, the third delegation in one go is refused", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    setRunCaps(s.db, { maxConcurrentDelegations: 2 });
    const specs = delegations(4, ["researcher", "analyst"]);
    s.model.queue(calls(...specs), say("Started."));
    const report = await playTurn(s, a, "split this into four pieces");
    const accepted = specs.filter((spec) => !Object.hasOwn(resultJson(report.calls.find((entry) => entry.callID === spec.id)), "error"));
    expect(accepted.length, "the owner's lower fan-out cap was not applied").toBe(2);
  });

  scenarioTest("with the fan-out cap raised to six, all six delegations are accepted", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    setRunCaps(s.db, { maxConcurrentDelegations: 6 });
    const specs = delegations(6, ["researcher", "analyst", "coder"]);
    s.model.queue(calls(...specs), say("Started."));
    const report = await playTurn(s, a, "split this into six pieces");
    const refused = specs.filter((spec) => Object.hasOwn(resultJson(report.calls.find((entry) => entry.callID === spec.id)), "error"));
    expect(refused.length, "the owner's higher fan-out cap was not applied").toBe(0);
  });

  scenarioTest("with the self-schedule cap set to three, a bot cannot keep a fourth job", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    setRunCaps(s.db, { maxSelfScheduledJobsPerBot: 3 });
    const specs: ToolCallSpec[] = Array.from({ length: 5 }, (_, index) => ({
      id: `call_sched_${index}`,
      name: "job_schedule",
      args: { text: `Check the warehouse report, round ${index + 1}.`, at: new Date(Date.now() + (index + 2) * 3_600_000).toISOString() },
    }));
    s.model.queue(loadTools("job_schedule"), calls(...specs), say("Scheduled."));
    await playTurn(s, a, "schedule five checks for me");
    const active = s.get<{ n: number }>("SELECT count(*) AS n FROM jobs WHERE kind = 'turn' AND state = 'queued' AND payload LIKE '%Check the warehouse report%'")!.n;
    expect(active, "the owner's lower self-schedule cap was not applied").toBe(3);
  });
});

describe("INV-14 root-job wall time", () => {
  scenarioTest("a chat turn stops before its next step once 30 minutes have passed, and says why", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    const run = heldRun();
    s.model.queue(...run.steps);
    const { turnID, since } = await a.startTurn("look into two things");
    await s.model.requested(1);
    later(minutes(31));
    run.held.open();
    const end = await a.waitFor("turn.end", { since, match: (frame) => frame.turnID === turnID, why: "the turn to end" });
    expect(s.model.requests.length, "the turn took another step after its 30 minutes were up").toBe(1);
    expect(end.stopReason, "the stop reason does not say the run ran out of time").toBe("timeout");
    const said = a.framesOf("msg.new", since).map((frame) => frame.text).join("\n");
    expect(said, "the owner was not told the time limit stopped the run").toMatch(/30 minutes/);
  });

  scenarioTest("29 minutes in, the run goes on", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    const run = heldRun();
    s.model.queue(...run.steps);
    const { turnID, since } = await a.startTurn("look into two things");
    await s.model.requested(1);
    later(minutes(29));
    run.held.open();
    const end = await a.waitFor("turn.end", { since, match: (frame) => frame.turnID === turnID, why: "the turn to end" });
    expect(end.stopReason, "a run was stopped before its time was up").toBe("end");
    expect(s.model.requests.length).toBe(3);
  });

  scenarioTest("the owner's own number is used: with the cap at ten minutes, eleven is too long", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    setRunCaps(s.db, { rootJobWallMs: minutes(10) });
    const run = heldRun();
    s.model.queue(...run.steps);
    const { turnID, since } = await a.startTurn("look into two things");
    await s.model.requested(1);
    later(minutes(11));
    run.held.open();
    const end = await a.waitFor("turn.end", { since, match: (frame) => frame.turnID === turnID, why: "the turn to end" });
    expect(end.stopReason).toBe("timeout");
    expect(s.model.requests.length).toBe(1);
  });

  scenarioTest("a background job is stopped the same way, is not retried, and is not marked done", async () => {
    const s = await scenarios.start();
    const run = heldRun();
    s.model.queue(...run.steps);
    const id = enqueueJob(s.db, { kind: "turn", payload: { text: "look into two things", agentID: "ea", notify: false } }).id;
    const ticking = s.runner().tick();
    await s.model.requested(1);
    later(minutes(31));
    run.held.open();
    await ticking;
    expect(s.model.requests.length, "the job took another step after its 30 minutes were up").toBe(1);
    expect(s.get<{ state: string }>("SELECT state FROM jobs WHERE id = ?", id)?.state, "a retry would give the job a fresh 30 minutes").toBe("failed");
  });

  scenarioTest("work delegated by a turn is measured from the turn's start, not its own", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    s.model.queue(call("delegate_task", { toAgentID: "researcher", goal: "Count the pallets in the east warehouse." }, "call_delegate"), say("On it."));
    await playTurn(s, a, "have the researcher count the pallets");
    const before = s.model.requests.length;
    later(minutes(31));
    s.model.queue(say("There are 42 pallets."));
    await s.runner().tick();
    expect(s.model.requests.length - before, "the delegated child ran a step after the root's 30 minutes were up").toBe(0);
    expect(s.get<{ delegate_state: string }>("SELECT delegate_state FROM tasks WHERE owner_agent_id = 'researcher'")?.delegate_state, "the task was not marked failed").toBe("failed");
  });

  /** What a job that was stopped for time leaves behind: the stop is the run's time limit, whatever the protocol calls it. */
  function expectStoppedForTime(s: Awaited<ReturnType<typeof scenarios.start>>, id: string): void {
    expect(s.model.requests.length, "a run whose clock could not be read called the model").toBe(0);
    const job = s.get<{ state: string; result: string | null }>("SELECT state, result FROM jobs WHERE id = ?", id);
    expect(job?.state, "the job was not failed").toBe("failed");
    expect(job?.result ?? "", "the job does not say the time limit stopped it").toMatch(/time limit/);
    const turn = s.get<{ stop_reason: string; ended_by: string | null }>("SELECT stop_reason, ended_by FROM turns ORDER BY started_at DESC, rowid DESC LIMIT 1");
    expect(turn, "the stopped run left no turn").not.toBeNull();
    expect(turn?.ended_by, "the turn does not record that the time limit ended it").toBe("wall_time");
    expect(turn?.stop_reason).toBe("timeout");
  }

  scenarioTest("a delegated run whose parent's clock cannot be found is stopped, not let through", async () => {
    const s = await scenarios.start();
    s.model.queue(say("Done."));
    const id = enqueueJob(s.db, {
      kind: "turn",
      payload: { text: "Do the thing.", agentID: "researcher", notify: false, rootTurnID: "trn_never_existed", rootJob: null, clockKey: "trn_never_existed" },
    }).id;
    await s.runner().tick();
    expectStoppedForTime(s, id);
    expect(s.get("SELECT clock_key FROM run_clocks WHERE clock_key = 'trn_never_existed'"), "a child made up a clock for its parent").toBeNull();
  });

  scenarioTest("a clock whose record of the owner's waits cannot be read stops the run, not lets it through", async () => {
    const s = await scenarios.start();
    s.db.run("DROP TABLE run_clock_waits");
    s.model.queue(say("Done."));
    const id = enqueueJob(s.db, { kind: "turn", payload: { text: "Do the thing.", agentID: "researcher", notify: false } }).id;
    await s.runner().tick();
    expectStoppedForTime(s, id);
  });
});
