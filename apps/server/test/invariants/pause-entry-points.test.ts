/**
 * INV-15b: every way model work can start stops in each of the three states the owner (or a fault) can put the
 * app in: everything paused, one bot turned off, and the pause state unreadable (which counts as paused).
 * (S2-13; track-c C5.4 item 15; docs/protocol.md "Pause, per-bot off and approval expiry".)
 *
 * `budget-pause.test.ts` proves a running turn and a running delegation stop within one step. This file walks the
 * doors: a message in the main chat, in a bot's own chat, by @mention, in a group room, a `remember:` capture,
 * `bind.direct` and `session.new` (which summarise with the model), and every kind of job. In each, nothing
 * reaches the model, nothing starts, and nothing is lost that should wait.
 *
 * The three states are set the way they really arrive: the owner's frames for "paused" and "off"; for
 * "unreadable", the one row the state lives in is gone (damage, not "not paused").
 */
import { describe, expect } from "bun:test";
import { bindPauseStore } from "../../src/policy/pause";
import { enqueueJob, getJob } from "../../src/stores/jobs";
import { insertRoutine } from "../../src/stores/routines";
import { createDelegationTask } from "../../src/stores/tasks";
import { nowISO } from "../../src/util/ids";
import { scenarioTest, useScenarios, gate, say, type Scenario, type ScenarioClient } from "../scenarios/harness";
import { allCallsTo, call, expectFrame, playTurn, scripted, setBotEnabled, setPaused } from "./support";

const scenarios = useScenarios();

type State = "paused" | "off" | "unreadable";

/** Put the app in `state` the way it arrives. For "off", `bot` is the bot that is turned off. */
async function enter(s: Scenario, a: ScenarioClient, state: State, bot: string): Promise<void> {
  if (state === "paused") expectFrame(await setPaused(a, true), "policy.pause.ok", "pausing everything");
  else if (state === "off") expectFrame(await setBotEnabled(a, bot, false), "policy.pause.ok", `turning ${bot} off`);
  else {
    // Read the state afresh every time, and lose the row it lives in.
    bindPauseStore(s.db, { cacheMs: 0 });
    s.db.run("DELETE FROM pause_state");
  }
}

/** Undo `enter`. */
async function leave(s: Scenario, a: ScenarioClient, state: State, bot: string): Promise<void> {
  if (state === "paused") expectFrame(await setPaused(a, false), "policy.pause.ok", "resuming");
  else if (state === "off") expectFrame(await setBotEnabled(a, bot, true), "policy.pause.ok", `turning ${bot} on`);
  else {
    s.db.run("INSERT INTO pause_state (id, paused) VALUES (1, 0)");
    // The owner pressing "resume" is what starts held messages again once the state can be read.
    expectFrame(await setPaused(a, false), "policy.pause.ok", "resuming");
  }
}

/** Every call to the model of any kind: a turn step, or a helper (summary, compaction, tagging). */
const modelCalls = (s: Scenario): number => s.model.requests.length + s.model.helperRequests.length;

// ---------------------------------------------------------------------------
// chat
// ---------------------------------------------------------------------------

interface ChatDoor {
  name: string;
  /** The bot this door reaches (the one that is turned off in the "off" state). */
  bot: string;
  /** Send it and wait until the server has answered it (a notice, or an error), so nothing is left to race. */
  act: (a: ScenarioClient) => Promise<void>;
}

const heldNotice = (a: ScenarioClient, since: number): Promise<unknown> =>
  a.until((frame) => frame.type === "status.update" && /paused/i.test(frame.text), { since, why: "the notice that the message waits until bots are resumed" });

const refusal = (a: ScenarioClient, since: number): Promise<unknown> =>
  a.until((frame) => frame.type === "error" && (frame.code === "paused" || frame.code === "agent_off"), { since, why: "an error saying the bot is paused or off" });

/** What the server says to a chat message that cannot start: held while paused, an error when the bot is off. */
const chatAnswer = (state: State) => (a: ScenarioClient, since: number): Promise<unknown> => (state === "off" ? refusal(a, since) : heldNotice(a, since));

function chatDoors(room: () => string): ChatDoor[] {
  return [
    { name: "a message in the main chat", bot: "ea", act: async (a) => a.send({ type: "msg.send", channelId: "main", text: "hello there" }) },
    { name: "a message in a specialist's own chat", bot: "researcher", act: async (a) => a.send({ type: "msg.send", channelId: "dm:researcher", toAgentId: "researcher", text: "hello there" }) },
    { name: "an @mention in the main chat", bot: "researcher", act: async (a) => a.send({ type: "msg.send", channelId: "main", text: "@researcher hello there" }) },
    { name: "an @mention in a group room", bot: "researcher", act: async (a) => a.send({ type: "msg.send", channelId: room(), text: "@researcher hello there" }) },
  ];
}

const STATES: State[] = ["paused", "off", "unreadable"];

describe("INV-15b a chat message is not started while paused, while its bot is off, or while the state cannot be read", () => {
  for (const state of STATES) {
    scenarioTest(`${state}: every chat door answers without starting a turn or calling the model`, async () => {
      const s = await scenarios.start();
      const a = await s.connect({ label: "A" });
      a.send({ type: "channel.create", name: "Vendors", agentIds: ["ea", "researcher"] });
      const room = (await a.waitFor("channel.created", { why: "the group room" })).channel.id;
      const doors = chatDoors(() => room);
      // "off" turns one bot off at a time: the doors to that bot are shut, the others stay open (checked in the next test).
      const off = "researcher";
      await enter(s, a, state, off);
      const problems: string[] = [];
      const since = a.mark();
      for (const door of doors.filter((entry) => state !== "off" || entry.bot === off)) {
        const before = a.mark();
        await door.act(a);
        try {
          await chatAnswer(state)(a, before);
        } catch (error) {
          problems.push(`${door.name}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
        }
      }
      await a.sync();
      expect(problems, "a door gave the owner no answer").toEqual([]);
      expect(a.framesOf("turn.start", since), "a turn started").toEqual([]);
      expect(modelCalls(s), "the model was called").toBe(0);
    });
  }

  scenarioTest("off: another bot's chat stays open, and the bot that is off answers again when turned on", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    await enter(s, a, "off", "researcher");
    s.model.queue(say("Assistant here."));
    const open = await playTurn(s, a, "hello");
    expect(open.stopReason, "turning one bot off stopped another").toBe("end");

    await leave(s, a, "off", "researcher");
    s.model.queue(say("Researcher here."));
    const back = await playTurn(s, a, "hello", { channelId: "dm:researcher", toAgentId: "researcher" });
    expect(back.stopReason, "a bot turned back on did not answer").toBe("end");
  });

  for (const state of ["paused", "unreadable"] as const) {
    scenarioTest(`${state}: messages that waited are answered, in the order they came, once the owner resumes`, async () => {
      const s = await scenarios.start();
      const a = await s.connect({ label: "A" });
      await enter(s, a, state, "ea");
      const since = a.mark();
      a.send({ type: "msg.send", channelId: "main", text: "first question" });
      await heldNotice(a, since);
      const second = a.mark();
      a.send({ type: "msg.send", channelId: "main", text: "second question" });
      await heldNotice(a, second);
      expect(modelCalls(s), "a held message reached the model").toBe(0);

      s.model.queue(say("First answer."), say("Second answer."));
      await leave(s, a, state, "ea");
      await a.until((frame) => frame.type === "turn.end", { since, why: "the first held message to be answered" });
      await s.model.requested(1);
      const asked = (n: number): string => JSON.stringify(s.model.requests[n]?.messages ?? []);
      expect(asked(0), "the first answer was not to the first message").toContain("first question");
      await s.model.requested(2);
      expect(asked(1), "the second answer was not to the second message").toContain("second question");
    });
  }

  scenarioTest("paused: a message queued behind a running turn is not started when that turn is stopped by the pause", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    const held = gate();
    s.model.queue({ text: "Thinking.", hold: held }, say("The queued message was answered."));
    const { turnID, since } = await a.startTurn("first, runs");
    await s.model.requested(1);
    a.send({ type: "msg.send", channelId: "main", text: "second, queued" });
    await a.until((frame) => frame.type === "status.update" && /queued/i.test(frame.text), { since, why: "the queued notice" });
    expectFrame(await setPaused(a, true), "policy.pause.ok", "pausing everything");
    held.open();
    await a.waitFor("turn.end", { since, match: (frame) => frame.turnID === turnID, why: "the stopped turn to end" });
    await a.sync();
    expect(s.model.requests.length, "the queued message started a turn while paused").toBe(1);
    expect(a.framesOf("turn.start", since).length, "a second turn started while paused").toBe(1);
  });

  scenarioTest("paused: `bind.direct` and `session.new`, which summarise with the model, are refused", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    a.send({ type: "conversation.open", conversationID: "", agentID: "ea" });
    const opened = await a.waitFor("conversation.ok", { why: "the conversation" });
    await enter(s, a, "paused", "ea");
    const since = a.mark();
    a.send({ type: "session.new", conversationID: opened.conversationID });
    expect((await a.waitFor("error", { since, why: "a refusal of session.new" })).code, "session.new was not refused as paused").toBe("paused");
    const next = a.mark();
    a.send({ type: "bind.direct", agentID: "researcher" });
    expect((await a.waitFor("error", { since: next, why: "a refusal of bind.direct" })).code, "bind.direct was not refused as paused").toBe("paused");
    expect(a.framesOf("session.start", since), "session.new ran while paused").toEqual([]);
    expect(modelCalls(s), "the model was called").toBe(0);
  });
});

// ---------------------------------------------------------------------------
// jobs
// ---------------------------------------------------------------------------

const PAST = "2020-01-01T00:00:00.000Z";

interface JobDoor {
  name: string;
  kind: string;
  bot: string;
  /** The states in which it must not run. Housekeeping belongs to no bot, so a bot being off does not hold it. */
  states: State[];
  make: (s: Scenario) => Record<string, unknown>;
}

const JOB_DOORS: JobDoor[] = [
  { name: "a scheduled turn of the main assistant", kind: "turn", bot: "ea", states: STATES, make: () => ({ text: "go" }) },
  { name: "a scheduled turn under the agni alias", kind: "turn", bot: "ea", states: STATES, make: () => ({ text: "go", agentID: "agni" }) },
  { name: "a scheduled turn of a specialist", kind: "turn", bot: "researcher", states: STATES, make: () => ({ text: "go", agentID: "researcher" }) },
  {
    name: "a delegated task", kind: "turn", bot: "researcher", states: STATES,
    make: (s) => ({ text: "go", agentID: "researcher", delegationTaskID: createDelegationTask(s.db, { ownerAgentID: "researcher", brief: { goal: "look it up" } as never }).id }),
  },
  {
    name: "a wake of the parent bot", kind: "turn", bot: "ea", states: STATES,
    make: () => ({ text: "wake", agentID: "ea", wakeKey: "thr_1", results: [{ taskID: "tsk_1", agentID: "researcher", summary: "done", redacted: false }] }),
  },
  {
    name: "a routine", kind: "routine", bot: "researcher", states: STATES,
    make: (s) => {
      s.db.run("INSERT INTO jobs (id, kind, payload, run_at, enabled, created_at, updated_at) VALUES ('job_parked', 'routine', '{}', '2099-01-01T00:00:00.000Z', 1, ?, ?)", [nowISO(), nowISO()]);
      insertRoutine(s.db, {
        id: "rtn_parked", jobID: "job_parked", agentID: "researcher", name: "Check", prompt: "p", cron: "0 9 * * *", timezone: "UTC",
        misfire: "run_once", preflight: { kind: "none" }, maxTokens: 1000, maxExecutionMs: 1000, allowedDomains: [], threadID: null,
        lastStateHash: null, stateContext: null, successStreak: 0, failureStreak: 0, createdAt: nowISO(), updatedAt: nowISO(),
      });
      return { routineID: "rtn_parked" };
    },
  },
  // Housekeeping that calls the model belongs to no bot: pause-all and an unreadable state hold it, a bot being off does not.
  ...["tagger", "summary.rollup", "rollover.summarize", "memory.consolidate", "memory.embed", "harness.review"].map((kind): JobDoor => (
    { name: `the internal ${kind} job`, kind, bot: "ea", states: ["paused", "unreadable"], make: () => ({}) }
  )),
];

/** What a job that did not run looks like, per state (docs/protocol.md): skipped and not run late, or put back for later. */
function expectedOutcome(state: State): (job: { state: string; result: string | null }) => boolean {
  if (state === "paused") return (job) => job.result === "skipped (paused)";
  if (state === "off") return (job) => job.result === "skipped (bot off)";
  return (job) => job.state === "queued" && job.result === "waiting: pause state unavailable";
}

describe("INV-15b a job does not run while paused, while its bot is off, or while the state cannot be read", () => {
  const SCENES: Array<{ state: State; bot: string }> = [
    { state: "paused", bot: "ea" },
    { state: "off", bot: "ea" },
    { state: "off", bot: "researcher" },
    { state: "unreadable", bot: "ea" },
  ];
  for (const { state, bot } of SCENES) {
    scenarioTest(`${state}${state === "off" ? ` (${bot})` : ""}: every kind of job that this state covers is skipped or put back, and the model is never called`, async () => {
      const s = await scenarios.start();
      const a = await s.connect({ label: "A" });
      const doors = JOB_DOORS.filter((door) => door.states.includes(state) && (state !== "off" || door.bot === bot));
      expect(doors.length, "the table has no job for this state").toBeGreaterThan(0);
      const jobs = doors.map((door) => ({ door, id: enqueueJob(s.db, { kind: door.kind, payload: door.make(s), runAt: PAST }).id }));
      s.model.queue(say("This must not be asked for."));
      await enter(s, a, state, bot);
      await s.runner().tick();

      const problems: string[] = [];
      for (const { door, id } of jobs) {
        const job = getJob(s.db, id)!;
        if (job.state === "running") problems.push(`${door.name}: left running`);
        else if (door.kind === "routine" || door.kind === "turn") {
          if (!expectedOutcome(state)(job)) problems.push(`${door.name}: ended as ${job.state} / ${job.result ?? "(no result)"}`);
        } else if (job.state !== "queued") {
          problems.push(`${door.name}: housekeeping was claimed (${job.state}) while the app was ${state}`);
        }
      }
      expect(problems, "jobs that were not held").toEqual([]);
      expect(modelCalls(s), "the model was called for a job").toBe(0);
    });
  }

  scenarioTest("off: a bot's own job is skipped while another bot's job runs in the same tick", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    await enter(s, a, "off", "researcher");
    s.model.queue(say("Assistant job done."));
    const off = enqueueJob(s.db, { kind: "turn", payload: { text: "go", agentID: "researcher", notify: false }, runAt: PAST }).id;
    const on = enqueueJob(s.db, { kind: "turn", payload: { text: "go", agentID: "ea", notify: false }, runAt: PAST }).id;
    for (let tick = 0; tick < 3 && getJob(s.db, on)?.state !== "done"; tick += 1) await s.runner().tick();
    expect(getJob(s.db, on)?.state, "the other bot's job did not run").toBe("done");
    expect(getJob(s.db, off)?.result, "the bot that is off had its job run").toBe("skipped (bot off)");
    expect(modelCalls(s)).toBe(1);
  });

  scenarioTest("off: a wake that tells a parent its task finished is skipped when the parent is off, and no model call is made for it", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    s.model.queue(...scripted(true, [call("delegate_task", { toAgentID: "researcher", goal: "Count the pallets." }, "call_delegate"), say("On it.")]));
    await playTurn(s, a, "have the researcher count the pallets");
    expectFrame(await setBotEnabled(a, "ea", false), "policy.pause.ok", "turning the parent off");

    const before = modelCalls(s);
    s.model.queue(say("There are 42."), say("The parent must not be asked."));
    for (let tick = 0; tick < 4; tick += 1) await s.runner().tick();
    expect(allCallsTo(s, "delegate_task").length, "the delegation was never made").toBe(1);
    expect(modelCalls(s) - before, "the researcher's answer plus a wake for a parent that is off: only the researcher may call the model").toBe(1);
    const wake = s.get<{ result: string | null }>("SELECT result FROM jobs WHERE kind = 'turn' AND payload LIKE '%wakeKey%'");
    expect(wake?.result, "the parent that is off was woken").toBe("skipped (bot off)");
  });
});

// ---------------------------------------------------------------------------
// what is already running
// ---------------------------------------------------------------------------

describe("INV-15b what is already running stops at the next boundary", () => {
  scenarioTest("paused: the tool call a stopped response had asked for does not run", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    const file = `${s.scratch}/after-the-pause.txt`.replaceAll("\\", "/");
    const held = gate();
    s.model.queue(
      ...scripted(true, [{ text: "Writing it.", calls: [{ name: "write_file", args: { path: file, content: "x" }, id: "call_write" }], hold: held }]),
      say("Done."),
    );
    const { turnID, since } = await a.startTurn("save a note");
    await s.model.requested(2);
    expectFrame(await setPaused(a, true), "policy.pause.ok", "pausing everything");
    held.open();
    const end = await a.waitFor("turn.end", { since, match: (frame) => frame.turnID === turnID, why: "the stopped turn to end" });
    expect(end.stopReason, "a paused turn did not end as stopped").toBe("cancelled");
    expect(allCallsTo(s, "write_file").filter((entry) => entry.ok), "a tool call ran after the owner paused everything").toEqual([]);
    expect(s.model.requests.length, "the turn took another step after pause-all").toBe(2);
  });

  scenarioTest("off: turning the running bot off stops its turn, and says how many were stopped", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    const held = gate();
    s.model.queue({ text: "Thinking.", calls: [{ name: "memory_search", args: { query: "x" }, id: "call_x" }], hold: held }, say("Done."));
    const { turnID, since } = await a.startTurn("look into it");
    await s.model.requested(1);
    const answer = await setBotEnabled(a, "ea", false);
    expectFrame(answer, "policy.pause.ok", "turning the bot off");
    expect((answer as { stopped: number }).stopped, "the answer did not count the turn it stopped").toBe(1);
    held.open();
    const end = await a.waitFor("turn.end", { since, match: (frame) => frame.turnID === turnID, why: "the stopped turn to end" });
    expect(end.stopReason).toBe("cancelled");
    expect(s.model.requests.length, "the turn took another step after its bot was turned off").toBe(1);
  });

  scenarioTest("unreadable: a turn whose pause state becomes unreadable mid-run takes no further step", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    const held = gate();
    s.model.queue({ text: "Thinking.", calls: [{ name: "memory_search", args: { query: "x" }, id: "call_x" }], hold: held }, say("Done."));
    const { turnID, since } = await a.startTurn("look into it");
    await s.model.requested(1);
    await enter(s, a, "unreadable", "ea");
    held.open();
    const end = await a.waitFor("turn.end", { since, match: (frame) => frame.turnID === turnID, why: "the turn to end" });
    expect(end.stopReason, "a turn whose pause state could not be read ended as a success").not.toBe("end");
    expect(s.model.requests.length, "the turn took another step with an unreadable pause state").toBe(1);
  });

  scenarioTest("off: a handoff to a bot that is off does not call that bot's model", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    expectFrame(await setBotEnabled(a, "coder", false), "policy.pause.ok", "turning the coder off");
    s.model.queue(
      call("handoff", { toAgentID: "coder", task: "Write a note." }, "call_handoff"),
      say("The coder is off, so I could not hand it over."),
    );
    const report = await playTurn(s, a, "have the coder write a note");
    expect(report.stopReason).toBe("end");
    expect(s.model.requests.length, "the bot that is off was called through a handoff (only the caller's own two steps are expected)").toBe(2);
  });
});
