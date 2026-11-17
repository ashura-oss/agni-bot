/**
 * INV-14, the run clock: which time the 30-minute limit counts, and for whom.
 *
 * A chat turn or a job, and what it delegated, share one clock that starts with it. Three kinds of
 * run start a clock of their own while they keep the refusals of the request they belong to:
 * a wake (the parent bot told its delegated task finished), a task resumed after the owner answered
 * its question, and a job that is started again later. Time the owner spends deciding (an approval
 * card, a question) is not run time. A retry of the same job does not get a fresh 30 minutes.
 *
 * The tests move JavaScript's clock (`setSystemTime`) while a run is held; timers keep real time.
 */
import { afterEach, describe, expect, setSystemTime } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toolUsage } from "../../src/jobs/harness-review";
import { enqueueJob } from "../../src/stores/jobs";
import { scenarioTest, useScenarios, gate, say, type Scenario, type ModelStep } from "../scenarios/harness";
import { call, later, minutes, playTurn, scripted } from "./support";

const scenarios = useScenarios();
afterEach(() => setSystemTime());

interface WakeRow { id: string; state: string; payload: string }
const wakeJobs = (s: Scenario): WakeRow[] => s.all<WakeRow>("SELECT id, state, payload FROM jobs WHERE kind = 'turn' AND payload LIKE '%wakeKey%' ORDER BY rowid");

/** A model that takes one held step, then two more. */
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

describe("INV-14 a wake has a clock of its own", () => {
  scenarioTest("a wake that runs after the root's 30 minutes is not stopped by the root's clock", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    s.model.queue(call("delegate_task", { toAgentID: "researcher", goal: "Count the pallets in the east warehouse." }, "call_delegate"), say("On it."));
    await playTurn(s, a, "have the researcher count the pallets");

    // The child is still inside the root's time when it answers; the wake that reports it comes 31 minutes after the root began.
    const held = gate();
    s.model.queue({ text: "There are 42 pallets.", hold: held }, say("The researcher counted 42 pallets."));
    const ticking = s.runner().tick();
    await s.model.requested(3);
    later(minutes(31));
    held.open();
    await ticking;
    if (wakeJobs(s).every((job) => job.state !== "done")) await s.runner().tick();

    const wake = wakeJobs(s)[0];
    expect(wake, "no wake was queued; the script is out of step").toBeDefined();
    expect(s.model.requests.length, "the wake did not run (the root's clock stopped it)").toBe(4);
    expect(wake!.state, "the wake was not completed").toBe("done");
  });

  scenarioTest("results from two different requests are told in two wakes, not one", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    s.model.queue(call("delegate_task", { toAgentID: "researcher", goal: "Count the pallets in the east warehouse." }, "call_d1"), say("On it."));
    const first = await playTurn(s, a, "have the researcher count the pallets");
    s.model.queue(call("delegate_task", { toAgentID: "analyst", goal: "Price the pallets in the west warehouse." }, "call_d2"), say("On it too."));
    const second = await playTurn(s, a, "have the analyst price the pallets");

    s.model.queue(say("There are 42 pallets."), say("They are worth 900."), say("Noted."), say("Noted again."));
    for (let tick = 0; tick < 4 && wakeJobs(s).length < 2; tick += 1) await s.runner().tick();

    const wakes = wakeJobs(s).map((job) => JSON.parse(job.payload) as { rootTurnID?: string; results?: unknown[] });
    expect(wakes.length, "the two requests' results were merged into one wake").toBe(2);
    expect(wakes.map((wake) => wake.results?.length), "a wake carries results of more than one request").toEqual([1, 1]);
    expect(new Set(wakes.map((wake) => wake.rootTurnID)), "each wake names the request its results came from").toEqual(new Set([first.turnID, second.turnID]));
  });
});

describe("INV-14 the owner's time is not run time", () => {
  scenarioTest("an approval card the owner takes 31 minutes to answer does not use up the run's time", async () => {
    const s = await scenarios.start();
    mkdirSync(s.scratch, { recursive: true });
    const target = join(s.scratch, "old-ledger.txt");
    writeFileSync(target, "old");
    const a = await s.connect({ label: "A" });
    s.model.queue(...scripted(true, [call("bash", { command: `rm ${target.replaceAll("\\", "/")}` }, "call_rm"), say("Removed it.")]));
    const { turnID, since } = await a.startTurn("remove the old ledger");
    const card = await a.waitFor("approval.request", { since, why: "the approval card" });
    later(minutes(31));
    a.send({ type: "approve.reply", requestID: card.requestID, decision: "once" });
    const end = await a.waitFor("turn.end", { since, match: (frame) => frame.turnID === turnID, why: "the turn to end" });
    expect(end.stopReason, "the owner's wait was counted as run time").toBe("end");
  });

  scenarioTest("a question the owner takes 31 minutes to answer does not use up the run's time", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    s.model.queue(...scripted(true, [call("ask", { question: "Which warehouse first?", options: ["East", "West"] }, "call_ask"), say("East it is.")]));
    const { turnID, since } = await a.startTurn("count the pallets");
    const form = await a.waitFor("form.request", { since, why: "the question" });
    later(minutes(31));
    a.send({ type: "form.answer", requestID: form.requestID, answer: "East" });
    const end = await a.waitFor("turn.end", { since, match: (frame) => frame.turnID === turnID, why: "the turn to end" });
    expect(end.stopReason, "the owner's wait was counted as run time").toBe("end");
  });

  scenarioTest("time spent in the model, not waiting on the owner, still counts after a wait", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    const held = gate();
    s.model.queue(
      ...scripted(true, [call("ask", { question: "Which warehouse first?", options: ["East", "West"] }, "call_ask")]),
      { text: "Looking.", calls: [{ name: "memory_search", args: { query: "pallets" }, id: "call_after" }], hold: held },
      say("Done."),
    );
    const { turnID, since } = await a.startTurn("count the pallets");
    const form = await a.waitFor("form.request", { since, why: "the question" });
    later(minutes(5));
    a.send({ type: "form.answer", requestID: form.requestID, answer: "East" });
    await s.model.requested(2);
    later(minutes(31));
    held.open();
    const end = await a.waitFor("turn.end", { since, match: (frame) => frame.turnID === turnID, why: "the turn to end" });
    expect(end.stopReason, "a wait on the owner made the run's own time free").toBe("timeout");
  });
});

describe("INV-14 a retry keeps the job's first clock", () => {
  /** Attempt one is held until the turn times out (real time, 150 ms); the JS clock moves while it is held. */
  async function failedFirstAttempt(s: Scenario, runMinutes: number): Promise<string> {
    s.model.queue({ text: "Looking.", calls: [{ name: "memory_search", args: { query: "first" }, id: "call_first" }], hold: gate() });
    const id = enqueueJob(s.db, { kind: "turn", payload: { text: "look into two things", agentID: "ea", notify: false } }).id;
    const ticking = s.runner().tick();
    await s.model.requested(1);
    later(minutes(runMinutes));
    await ticking;
    expect(s.get<{ state: string }>("SELECT state FROM jobs WHERE id = ?", id)?.state, "the first attempt did not fail into a retry; the script is out of step").toBe("queued");
    return id;
  }

  scenarioTest("a retry that starts after the first attempt used 20 minutes has 10 left, not 30", async () => {
    const s = await scenarios.start({ turnTimeoutMs: 150 });
    const id = await failedFirstAttempt(s, 20);
    later(minutes(15));
    const before = s.model.requests.length;
    s.model.queue(say("Done."));
    await s.runner().tick();
    expect(s.model.requests.length - before, "the retry ran a step on a fresh clock").toBe(0);
    expect(s.get<{ state: string }>("SELECT state FROM jobs WHERE id = ?", id)?.state).toBe("failed");
  });

  scenarioTest("a retry inside the first attempt's 30 minutes goes on", async () => {
    const s = await scenarios.start({ turnTimeoutMs: 150 });
    const id = await failedFirstAttempt(s, 10);
    later(minutes(5));
    s.model.queue(say("Done."));
    await s.runner().tick();
    expect(s.get<{ state: string }>("SELECT state FROM jobs WHERE id = ?", id)?.state, "a retry was stopped before the first attempt's time was up").toBe("done");
  });

  scenarioTest("a recurring job's next run starts its own clock", async () => {
    const s = await scenarios.start();
    const id = enqueueJob(s.db, { kind: "turn", payload: { text: "check the warehouse", agentID: "ea", notify: false, everyMs: minutes(60) } }).id;
    s.model.queue(say("All quiet."));
    await s.runner().tick();
    expect(s.get<{ state: string }>("SELECT state FROM jobs WHERE id = ?", id)?.state, "the first run did not finish; the script is out of step").toBe("queued");
    later(minutes(61));
    s.model.queue(say("All quiet again."));
    const before = s.model.requests.length;
    await s.runner().tick();
    expect(s.model.requests.length - before, "the next run was stopped by the first run's clock").toBe(1);
  });
});

describe("INV-14 a stop for time is its own thing", () => {
  scenarioTest("it is not counted as a turn timeout, and the job gives up without a second notice", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    const run = heldRun();
    s.model.queue(...run.steps);
    const id = enqueueJob(s.db, { kind: "turn", payload: { text: "look into two things", agentID: "ea", notify: false } }).id;
    const since = a.mark();
    const ticking = s.runner().tick();
    await s.model.requested(1);
    later(minutes(31));
    run.held.open();
    await ticking;
    await a.sync();

    const turn = s.get<{ stop_reason: string; ended_by: string | null }>("SELECT stop_reason, ended_by FROM turns ORDER BY started_at DESC, rowid DESC LIMIT 1");
    expect(turn?.stop_reason, "the protocol stop reason changed").toBe("timeout");
    expect(turn?.ended_by, "the turn does not record that the run's time limit ended it").toBe("wall_time");
    expect(toolUsage(s.db, "2000-01-01T00:00:00.000Z").timeouts, "a time-limit stop was counted as a turn timeout").toBe(0);
    expect(s.get<{ state: string }>("SELECT state FROM jobs WHERE id = ?", id)?.state).toBe("failed");
    const notices = a.framesOf("notify", since).map((frame) => frame.title);
    expect(notices, "the runner raised a second notice on top of the stop message").toEqual([]);
  });

  scenarioTest("an ordinary turn timeout is still counted as one", async () => {
    const s = await scenarios.start({ turnTimeoutMs: 150 });
    s.model.queue({ text: "Looking.", hold: gate() });
    enqueueJob(s.db, { kind: "turn", payload: { text: "look into two things", agentID: "ea", notify: false } });
    await s.runner().tick();
    expect(toolUsage(s.db, "2000-01-01T00:00:00.000Z").timeouts, "a plain timeout stopped being counted").toBe(1);
  });
});

describe("INV-14 each scheduled run of a job has its own clock", () => {
  /** The parent runs once (slot one), and a child that is part of that run is queued to start later, on the parent's clock. */
  async function parentRunWithLateChild(s: Scenario, childDueInMinutes: number): Promise<{ parentID: string; childID: string }> {
    const parentID = enqueueJob(s.db, { kind: "turn", payload: { text: "check the warehouse", agentID: "ea", notify: false, everyMs: minutes(5) } }).id;
    s.model.queue(say("All quiet."));
    await s.runner().tick();
    expect(s.get<{ state: string }>("SELECT state FROM jobs WHERE id = ?", parentID)?.state, "the parent's first run did not finish; the script is out of step").toBe("queued");
    const clocks = s.all<{ clock_key: string }>("SELECT clock_key FROM run_clocks");
    expect(clocks.length, "the parent's first run did not start exactly one clock").toBe(1);
    const childID = enqueueJob(s.db, {
      kind: "turn",
      payload: { text: "count the pallets", agentID: "ea", notify: false, clockKey: clocks[0]!.clock_key },
      runAt: new Date(Date.now() + minutes(childDueInMinutes)).toISOString(),
    }).id;
    return { parentID, childID };
  }

  scenarioTest("a child still running across the parent's next 5-minute slot is stopped 30 counted minutes after its own run began", async () => {
    const s = await scenarios.start();
    const { childID } = await parentRunWithLateChild(s, 20);
    later(minutes(5));
    s.model.queue(say("All quiet again."));
    await s.runner().tick(); // the parent's second slot: the child is not due yet
    later(minutes(26)); // 31 minutes after the first run began
    s.model.queue(say("All quiet a third time."), say("Counted 42."));
    await s.runner().tick();
    expect(s.get<{ state: string }>("SELECT state FROM jobs WHERE id = ?", childID)?.state, "the parent's next slot gave the child a fresh 30 minutes").toBe("failed");
  });

  scenarioTest("a child inside its own run's 30 minutes is not stopped by the parent's next slot", async () => {
    const s = await scenarios.start();
    const { childID } = await parentRunWithLateChild(s, 20);
    later(minutes(5));
    s.model.queue(say("All quiet again."));
    await s.runner().tick();
    later(minutes(15)); // 20 minutes after the first run began
    s.model.queue(say("All quiet a third time."), say("Counted 42."));
    await s.runner().tick();
    expect(s.get<{ state: string }>("SELECT state FROM jobs WHERE id = ?", childID)?.state, "a child inside its own 30 minutes was stopped").toBe("done");
  });

  scenarioTest("a retry of the same slot keeps that slot's clock, and the next slot starts another", async () => {
    const s = await scenarios.start({ turnTimeoutMs: 150 });
    s.model.queue({ text: "Looking.", calls: [{ name: "memory_search", args: { query: "first" }, id: "call_first" }], hold: gate() });
    const id = enqueueJob(s.db, { kind: "turn", payload: { text: "look into two things", agentID: "ea", notify: false, everyMs: minutes(60) } }).id;
    const ticking = s.runner().tick();
    await s.model.requested(1);
    later(minutes(20));
    await ticking;
    later(minutes(15)); // the retry: 35 minutes after the slot began
    s.model.queue(say("Done."));
    const before = s.model.requests.length;
    await s.runner().tick();
    expect(s.model.requests.length - before, "the retry ran a step on a fresh clock").toBe(0);
    const keys = s.all<{ clock_key: string }>("SELECT clock_key FROM run_clocks");
    expect(keys.length, "the retry started a second clock for the same slot").toBe(1);
    expect(s.get<{ state: string }>("SELECT state FROM jobs WHERE id = ?", id)?.state, "a stop for time is not a skip to the next slot").toBe("queued");

    later(minutes(61)); // the next slot
    s.model.queue(say("All quiet."));
    await s.runner().tick();
    expect(s.all("SELECT clock_key FROM run_clocks").length, "the next slot did not get a clock of its own").toBe(2);
  });
});
