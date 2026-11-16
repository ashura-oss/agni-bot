/**
 * INV-14 and INV-15: spend caps stop a run mid-task, and one switch pauses
 * everything (S2-11, S2-13; track-c C5.4 items 14 and 15, S16 tests).
 *
 *   - A looping bot stops at the cap with reason `budget`, and the owner is
 *     told. One bot's cap leaves the others working.
 *   - Pause-all halts a running turn and a running delegation within one step,
 *     and stops jobs being claimed. A bot switched off stops the same way.
 *
 * The frames and CLI names here come from the spec; their exact fields are
 * assumed in `support.ts` (setPaused, setBotEnabled, setSpendCaps) and are
 * the one place to change when S2-2 settles them.
 */
import { join } from "node:path";
import { describe, expect } from "bun:test";
import { enqueueJob } from "../../src/stores/jobs";
import { scenarioTest, useScenarios, gate, say, type Scenario } from "../scenarios/harness";
import {
  call,
  chatWith,
  expectFrame,
  playTurn,
  resultJson,
  setBotEnabled,
  setPaused,
  setSpendCaps,
  allCallsTo,
} from "./support";

const scenarios = useScenarios();

/** The scenario model reports a priced id so cost can be computed (see the report: S2-3 must price it). */
const PRICED_MODEL = "deepseek/deepseek-v4.1-flash-1017";
const BIG = { in: 2_000_000, out: 500_000 };

/** A looping model: a different cheap read every step, each step reporting a lot of usage. */
function loopingSteps(count: number): ReturnType<typeof say>[] {
  return Array.from({ length: count }, (_, index) => ({
    calls: [{ name: "memory_search", args: { query: `lookup ${index}` }, id: `call_loop_${index}` }],
    usage: BIG,
  }));
}

const turnJob = (s: Scenario, agentID: string, text: string): string =>
  enqueueJob(s.db, { kind: "turn", payload: { text, agentID, notify: false } }).id;

const jobState = (s: Scenario, id: string): string => s.get<{ state: string }>("SELECT state FROM jobs WHERE id = ?", id)?.state ?? "(gone)";
const jobResult = (s: Scenario, id: string): string => s.get<{ result: string | null }>("SELECT result FROM jobs WHERE id = ?", id)?.result ?? "";

describe("INV-14 a spend cap stops a looping run mid-task with reason `budget`", () => {
  scenarioTest("the daily cap ends a chat turn after a step or two, says why, and the loop does not run to its script", async () => {
    const s = await scenarios.start({ model: PRICED_MODEL });
    const a = await s.connect({ label: "A" });
    expectFrame(await setSpendCaps(a, { dayUsd: 0.01, perBotDayUsd: null }), "spend.status.ok", "setting the daily cap");
    s.model.queue(...loopingSteps(12), say("Finished all twelve lookups."));

    const since = a.mark();
    const report = await playTurn(s, a, "look up everything about the quarter, twelve ways");
    expect(report.stopReason, "the run did not stop for the cap").toBe("budget");
    expect(s.model.requests.length, "the model kept being called after the cap was passed").toBeLessThanOrEqual(3);

    const stopped = a.framesOf("spend.stopped", since);
    expect(stopped.length, "the owner got no spend.stopped frame").toBe(1);
    expect(stopped[0]).toMatchObject({ scope: "day", reason: "over_cap" });
    expect(stopped[0]!.message, "the notice does not say what happened").toMatch(/limit|cap|spent/i);
  });

  scenarioTest("a background job's own cap stops it mid-run", async () => {
    const s = await scenarios.start({ model: PRICED_MODEL });
    const a = await s.connect({ label: "A" });
    expectFrame(await setSpendCaps(a, { perJobUsd: 0.01 }), "spend.status.ok", "setting the per-job cap");
    s.model.queue(...loopingSteps(12), say("Finished all twelve lookups."));
    const id = turnJob(s, "ea", "look up everything about the quarter, twelve ways");
    const since = a.mark();
    await s.runner().tick();
    await a.sync();
    expect(s.model.requests.length, "the job kept calling the model after its cap").toBeLessThanOrEqual(3);
    expect(a.framesOf("spend.stopped", since)[0], "the owner was not told the job's cap stopped it").toMatchObject({ scope: "job", reason: "over_cap" });
    expect(jobState(s, id), "a job stopped by its cap was marked done").not.toBe("done");
  });

  scenarioTest("a side call (summarising a session the owner closes) is stopped by the same cap, not only the turn loop", async () => {
    const s = await scenarios.start({ model: PRICED_MODEL });
    const a = await s.connect({ label: "A" });
    // A real exchange to summarise, then the cap is passed by one big answer.
    s.model.queue({ text: "Here is a long answer.", usage: BIG });
    await playTurn(s, a, "write me something long");
    expectFrame(await setSpendCaps(a, { dayUsd: 0.01, perBotDayUsd: null }), "spend.status.ok", "setting the daily cap");
    a.send({ type: "conversation.open", conversationID: "", agentID: "ea" });
    const opened = await a.waitFor("conversation.ok", { why: "the conversation" });
    const helpersBefore = s.model.helperRequests.length;
    a.send({ type: "session.new", conversationID: opened.conversationID });
    await a.waitFor("session.start", { why: "the owner's new block to start" });
    await a.sync();
    expect(s.model.helperRequests.length - helpersBefore, "a summary was written with a model call after the daily cap was passed").toBe(0);
  });

  scenarioTest("one bot's cap stops that bot; another bot still answers", async () => {
    const s = await scenarios.start({ model: PRICED_MODEL });
    const a = await s.connect({ label: "A" });
    expectFrame(await setSpendCaps(a, { perBotDayUsd: 0.01 }), "spend.status.ok", "setting the per-bot cap");
    s.model.queue({ text: "Here is a long answer.", usage: BIG });
    await playTurn(s, a, "write me something long");

    s.model.queue(say("I am back."));
    const again = await playTurn(s, a, "and again");
    expect(again.stopReason, "the bot that spent its share kept running").toBe("budget");

    s.model.queue(say("Researcher here."));
    const other = await playTurn(s, a, "hello", chatWith("researcher"));
    expect(other.stopReason, "another bot was stopped by the first bot's cap").toBe("end");
  });
});

describe("INV-15 pause-all halts turns, delegations and jobs; per-bot off does the same for one bot", () => {
  scenarioTest("a running turn makes no further model call once paused", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    const held = gate();
    s.model.queue(
      { text: "Looking.", calls: [{ name: "memory_search", args: { query: "first" }, id: "call_first" }], hold: held },
      { calls: [{ name: "memory_search", args: { query: "second" }, id: "call_second" }] },
      say("Done."),
    );
    const { turnID, since } = await a.startTurn("look into two things");
    await s.model.requested(1);
    expectFrame(await setPaused(a, true), "policy.pause.ok", "pausing everything");
    held.open();
    await a.waitFor("turn.end", { since, match: (frame) => frame.turnID === turnID, why: "the paused turn to end" });
    expect(s.model.requests.length, "the turn took another step after pause-all").toBe(1);
  });

  scenarioTest("a running delegation makes no further model call once paused", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    s.model.queue(call("delegate_task", { toAgentID: "researcher", goal: "Count the pallets in the east warehouse." }, "call_delegate"), say("On it."));
    await playTurn(s, a, "have the researcher count the pallets");
    const requestsBefore = s.model.requests.length;

    const held = gate();
    s.model.queue(
      { text: "Counting.", calls: [{ name: "memory_search", args: { query: "pallets" }, id: "call_child_one" }], hold: held },
      { calls: [{ name: "memory_search", args: { query: "pallets again" }, id: "call_child_two" }] },
      say("There are 42."),
    );
    const ticking = s.runner().tick();
    await s.model.requested(requestsBefore + 1);
    expectFrame(await setPaused(a, true), "policy.pause.ok", "pausing everything");
    held.open();
    await ticking;
    expect(s.model.requests.length - requestsBefore, "the delegated child took another step after pause-all").toBe(1);
  });

  scenarioTest("while paused, a due job is skipped with no model call, not run late; a job queued after resume runs", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    expectFrame(await setPaused(a, true), "policy.pause.ok", "pausing everything");
    s.model.queue(say("Job done."));
    const id = turnJob(s, "ea", "write the morning summary");
    await s.runner().tick();
    expect(s.model.requests.length, "a job called the model while everything was paused").toBe(0);
    // docs/protocol.md: a due job of a paused bot is recorded as skipped and does not run late on resume.
    expect(jobResult(s, id), "the paused job was not recorded as skipped").toBe("skipped (paused)");

    expectFrame(await setPaused(a, false), "policy.pause.ok", "resuming");
    await s.runner().tick();
    expect(s.model.requests.length, "a job skipped while paused ran late on resume").toBe(0);
    const later = turnJob(s, "ea", "write the evening summary");
    for (let tick = 0; tick < 3 && jobState(s, later) !== "done"; tick += 1) await s.runner().tick();
    expect(jobState(s, later), "a job queued after resume did not run").toBe("done");
    expect(s.model.requests.length, "the resumed job made no model call").toBe(1);
  });

  scenarioTest("`agni pause` and `agni resume` work with no server running and are honoured at job claim", async () => {
    const s = await scenarios.start();
    const run = async (command: string): Promise<{ code: number; text: string }> => {
      const child = Bun.spawn(["bun", join(import.meta.dir, "..", "..", "src", "index.ts"), command], {
        env: { ...process.env, AGNI_HOME: s.home },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code: await child.exited, text: `${out}${err}` };
    };
    const paused = await run("pause");
    expect(paused.code, `agni pause failed: ${paused.text.slice(-200)}`).toBe(0);
    s.model.queue(say("Job done."));
    const id = turnJob(s, "ea", "write the morning summary");
    await s.runner().tick();
    expect(jobResult(s, id), "a job was run after `agni pause`").toBe("skipped (paused)");
    expect(s.model.requests.length, "a job called the model after `agni pause`").toBe(0);
    const resumed = await run("resume");
    expect(resumed.code, `agni resume failed: ${resumed.text.slice(-200)}`).toBe(0);
    for (let tick = 0; tick < 3 && jobState(s, id) !== "done"; tick += 1) await s.runner().tick();
    const after = turnJob(s, "ea", "write the evening summary");
    for (let tick = 0; tick < 3 && jobState(s, after) !== "done"; tick += 1) await s.runner().tick();
    expect(jobResult(s, after), "a job did not run after `agni resume`").not.toMatch(/skipped/);
    expect(s.model.requests.length).toBe(1);
  });

  scenarioTest("a bot switched off: its queued job is not run, others are; work delegated to it never runs and the delegator is told", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    expectFrame(await setBotEnabled(a, "researcher", false), "policy.pause.ok", "switching the researcher off");
    s.model.queue(say("Assistant job done."));
    const offJob = turnJob(s, "researcher", "write the research summary");
    const onJob = turnJob(s, "ea", "write the morning summary");
    for (let tick = 0; tick < 3 && jobState(s, onJob) !== "done"; tick += 1) await s.runner().tick();
    expect(jobState(s, onJob), "another bot's job did not run").toBe("done");
    expect(jobResult(s, offJob), "the switched-off bot's job ran").toBe("skipped (bot off)");
    expect(s.model.requests.length, "the model was called for the switched-off bot").toBe(1);

    s.model.queue(call("delegate_task", { toAgentID: "researcher", goal: "Count the pallets." }, "call_to_off"), say("Done."));
    const requestsBefore = s.model.requests.length;
    await playTurn(s, a, "have the researcher count the pallets");
    // The tool call queues the work; the job claim refuses it (docs/protocol.md), and the delegation is closed as failed with the owner's reason.
    await s.runner().tick();
    const queued = allCallsTo(s, "delegate_task").find((entry) => entry.callID === "call_to_off")!;
    const task = s.get<{ delegate_state: string; result: string | null }>("SELECT delegate_state, result FROM tasks WHERE id = ?", String(resultJson(queued).taskID));
    expect(task?.delegate_state, "work delegated to a bot that is switched off was not closed as failed").toBe("failed");
    expect(task?.result ?? "", "the delegator is not told why").toMatch(/turned this bot off/);
    expect(s.model.requests.length - requestsBefore, "the switched-off bot called the model for the delegation (only the delegator's own two steps are expected)").toBe(2);
  });
});
