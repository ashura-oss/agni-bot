/**
 * Sprint 2, fix round J: standing work that a bot starts from a chain.
 *
 *  1. A wake in a chain a bot made a link of is a link of that chain: a one-shot job it schedules is put to the owner (round K: decided by
 *     the flag the chain carries, `policy/provenance.ts`, not by the root job's row).
 *  2. A job approved from a run whose tools were narrowed (a bot's brief, a delegated task, a job that was itself narrowed) fires with
 *     the tools of the run that asked, never with its persona's full set; unreadable means the inert tools only.
 *  3. A routine's creation or resumption from a run a routine's own tool would refuse is refused before any card.
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { resetS2Startup } from "../src/startup/s2";
import { createJobTools, scheduleJob } from "../src/tools/jobs-tool";
import { createRoutineTools } from "../src/tools/routines-tool";
import { decide } from "../src/policy/engine";
import { addTaint } from "../src/policy/context";
import { OWNER_STARTED } from "../src/policy/provenance";
import { standingRuleOrigin, standingScheduleKind } from "../src/policy/standing-rules";
import { enqueueJob } from "../src/stores/jobs";
import type { RunContext } from "../src/policy/types";
import { scenarioTest, useScenarios, say } from "./scenarios/harness";
import { allCallsTo, answerCards, call, later, minutes, playTurn, resultJson, scripted, useWeb } from "./invariants/support";
import { policyRig, type PolicyRig } from "./policy-fixture";

const scenarios = useScenarios();
useWeb();
afterEach(() => { setSystemTime(); resetS2Startup(); });

const future = (): string => new Date(Date.now() + 3_600_000).toISOString();
const past = (): string => new Date(Date.now() - 1_000).toISOString();
const FROM_BOT = { ownerStarted: true, botChained: true };

type Handler = (args: unknown, ctx: unknown) => Promise<{ id?: string; error?: string }>;
const jobHandler = (rig: PolicyRig): Handler => createJobTools(rig.db)[0]!.handler as unknown as Handler;
const ctxOf = (run: RunContext, extra: Record<string, unknown> = {}) => ({ threadID: "thr", turnID: "trn", signal: new AbortController().signal, run, chain: { depth: 1, rootAgentID: "ea", currentAgentID: "ea", handoffSummary: null }, ...extra });

describe("a wake in a chain a bot-made job started may not schedule the next one-shot job without a card", () => {
  let rig: PolicyRig | undefined;
  afterEach(() => { rig?.close(); rig = undefined; });
  const once = (): Record<string, unknown> => ({ text: "do the next round", at: future() });

  test("the engine asks for a wake of a chain a bot made a link of, and for nothing else of a wake", () => {
    rig = policyRig();
    const botJob = scheduleJob(rig.db, { text: "start", at: future() }, "ea").id;

    const fromBotChain = decide(rig.another({ principal: { kind: "wake" }, rootJob: botJob, provenance: FROM_BOT }), { tool: "job_schedule", args: once(), callID: "call_1" });
    expect(fromBotChain.action, "a wake in a bot's chain scheduled the next link with no card").toBe("ask");
    if (fromBotChain.action === "ask") {
      expect(fromBotChain.card.standingKind).toBe("next_job");
      expect(fromBotChain.card.canRemember).toBe(false);
    }
    // The root job's row is not what decides (the flag the chain carries is: test/s2-chain-decision.test.ts): the owner's own chat turn that
    // delegated, and a job the owner made, are the owner's work whatever job they name as the root.
    expect(decide(rig.another({ principal: { kind: "wake" }, provenance: OWNER_STARTED }), { tool: "job_schedule", args: once(), callID: "call_1" }).action).toBe("run");
    expect(decide(rig.another({ principal: { kind: "wake" }, rootJob: "job_gone", provenance: OWNER_STARTED }), { tool: "job_schedule", args: once(), callID: "call_1" }).action).toBe("run");
    // A tainted wake is still refused outright, as any tainted run is.
    const tainted = rig.another({ principal: { kind: "wake" }, rootJob: botJob, provenance: FROM_BOT });
    addTaint(tainted, { kind: "web", label: "evil.example/page", tool: "web_fetch", at: "2026-11-16T10:00:00Z" });
    expect(decide(tainted, { tool: "job_schedule", args: once(), callID: "call_1" })).toMatchObject({ action: "refuse", code: "protected_write" });
  });

  test("the classification and the tool's own check agree, and the card names the wake", () => {
    rig = policyRig();
    const botJob = scheduleJob(rig.db, { text: "start", at: future() }, "ea").id;
    const wake = rig.another({ principal: { kind: "wake" }, rootJob: botJob, provenance: FROM_BOT });
    expect(standingScheduleKind(once(), wake)).toBe("next_job");
    expect(standingRuleOrigin(wake)).toMatch(/reporting back/);
  });

  test("the tool refuses it too unless the loop carries the owner's yes", async () => {
    rig = policyRig();
    const botJob = scheduleJob(rig.db, { text: "start", at: future() }, "ea").id;
    const wake = rig.another({ principal: { kind: "wake" }, rootJob: botJob, provenance: FROM_BOT });
    const before = rig.db.query("SELECT id FROM jobs WHERE kind = 'turn'").all().length;
    const refused = await jobHandler(rig)(once(), ctxOf(wake));
    expect(refused.id, "a wake in a bot-made job's chain made the next link with no owner's yes").toBeUndefined();
    expect(refused.error).toMatch(/standing rule|not you/i);
    expect(rig.db.query("SELECT id FROM jobs WHERE kind = 'turn'").all().length).toBe(before);
    const approved = await jobHandler(rig)(once(), ctxOf(wake, { ownerApproved: true }));
    expect(approved.id, "the owner's yes did not make the link").toBeDefined();
    // The owner's own chat turn that delegated is not asked.
    expect((await jobHandler(rig)(once(), ctxOf(rig.another({ principal: { kind: "wake" }, provenance: OWNER_STARTED })))).id).toBeDefined();
  });

  scenarioTest("through the real loop: the job delegates, the wake schedules the next link, and the owner is asked", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    s.model.queue(...scripted(true, [call("job_schedule", { text: "Count the pallets.", at: past() }, "call_seed"), say("Scheduled.")]));
    await playTurn(s, a, "count the pallets", { answer: () => "once" });

    const owner = answerCards(a, "reject");
    s.model.queue(
      ...scripted(true, [call("delegate_task", { toAgentID: "researcher", goal: "Count the pallets." }, "call_delegate"), say("The researcher is counting.")]),
      say("There are 41 pallets."),
      ...scripted(true, [call("job_schedule", { text: "Count them again.", at: future() }, "call_next"), say("Noted.")]),
    );
    for (let tick = 0; tick < 12 && !allCallsTo(s, "job_schedule", a).some((entry) => entry.callID === "call_next"); tick += 1) await s.runner().tick();
    owner.stop();

    const next = allCallsTo(s, "job_schedule", a).find((entry) => entry.callID === "call_next");
    expect(next, "the wake never made the call; the script is out of step").toBeDefined();
    expect(owner.cards.length, "the wake scheduled the next link of a bot-made chain with no card").toBe(1);
    expect(owner.cards[0]!.buttons).toEqual(["once", "reject"]);
    expect(String(resultJson(next).error ?? "(no error)")).toMatch(/denied|not approved/i);
    expect(s.all("SELECT id FROM jobs WHERE kind = 'turn' AND payload LIKE '%Count them again.%'")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. a job approved from a narrowed run fires narrowed
// ---------------------------------------------------------------------------

describe("a job approved from a run whose tools were narrowed fires with the tools of the run that asked", () => {
  let rig: PolicyRig | undefined;
  afterEach(() => { rig?.close(); rig = undefined; });
  const recur = { text: "do it", everyMinutes: 60 };
  const stored = (r: PolicyRig): { capabilities?: unknown } => JSON.parse(r.db.query<{ payload: string }, []>("SELECT payload FROM jobs WHERE kind = 'turn' ORDER BY rowid DESC").get()!.payload) as { capabilities?: unknown };

  test("a narrowed run's job stores the run's effective tools; a run that was not narrowed stores none", async () => {
    rig = policyRig();
    const narrowed = rig.another({ principal: { kind: "peer", from: "boss" }, capabilities: ["job_schedule", "say", "ask"], narrowed: true });
    const made = await jobHandler(rig)(recur, ctxOf(narrowed, { ownerApproved: true }));
    expect(made.id, "the owner-approved job was not made").toBeDefined();
    expect([...(stored(rig).capabilities as string[])].sort(), "the job does not carry the tools of the run that asked").toEqual(["ask", "job_schedule", "say"]);

    // A one-shot job a narrowed run schedules (a narrowed job's own next link) carries them too.
    const link = await jobHandler(rig)({ text: "next", at: future() }, ctxOf(rig.another({ principal: { kind: "job" }, capabilities: ["job_schedule", "say"], narrowed: true }), { ownerApproved: true }));
    expect(link.id).toBeDefined();
    expect([...(stored(rig).capabilities as string[])].sort()).toEqual(["job_schedule", "say"]);

    const owners = await jobHandler(rig)(recur, ctxOf(rig.run));
    expect(owners.id).toBeDefined();
    expect(stored(rig).capabilities, "a run that was not narrowed stored a cut-down tool list").toBeUndefined();
  });

  test("a narrowed run whose tool set cannot be read stores a list that reads as unknown, not no list", async () => {
    rig = policyRig();
    const broken = { ...rig.another({ principal: { kind: "peer", from: "boss" }, narrowed: true }), effectiveCapabilities: undefined } as unknown as RunContext;
    const made = await jobHandler(rig)(recur, ctxOf(broken, { ownerApproved: true }));
    expect(made.id).toBeDefined();
    expect(Object.hasOwn(stored(rig), "capabilities"), "the job carries no mark that its tools were narrowed").toBe(true);
    expect(stored(rig).capabilities).toBeNull();
  });

  test("the card says the job runs with the tools of the run that asked", () => {
    rig = policyRig();
    const narrowed = rig.another({ principal: { kind: "peer", from: "boss" }, narrowed: true });
    const asked = decide(narrowed, { tool: "job_schedule", args: recur, callID: "call_1" });
    expect(asked.action).toBe("ask");
    if (asked.action === "ask") expect(asked.card.standingNarrowed).toBe(true);
    const plain = decide(rig.another({ principal: { kind: "job" }, jobID: "job_bot" }), { tool: "job_schedule", args: recur, callID: "call_1" });
    expect(plain.action).toBe("ask");
    if (plain.action === "ask") expect(plain.card.standingNarrowed).toBeUndefined();
  });

  scenarioTest("through the real loop: approved from a bot's brief, the job stores the tools and every fire is cut down to them", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    // A brief from another bot that says it read nothing outside: its child holds only what the brief's sender could call.
    enqueueJob(s.db, {
      kind: "turn",
      payload: {
        text: "Keep an eye on the pallets.", agentID: "ea", notify: false, inputRole: "system",
        peer: { from: "Someone", intent: "request" }, taint: [],
        capabilities: ["job_schedule", "say", "ask"],
      },
    });
    const owner = answerCards(a, "once");
    s.model.queue(call("job_schedule", { text: "Count the pallets.", everyMinutes: 5 }, "call_recur"), say("Scheduled."));
    const made = (): Array<{ payload: string }> => s.all<{ payload: string }>("SELECT payload FROM jobs WHERE payload LIKE '%Count the pallets.%' AND payload LIKE '%everyMs%'");
    for (let tick = 0; tick < 6 && made().length === 0; tick += 1) await s.runner().tick();
    const [row] = made();
    expect(row, "the approved job was not made; the script is out of step").toBeDefined();
    expect(owner.cards.length, "the brief's run was not asked").toBe(1);
    expect(owner.cards[0]!.preview, "the card does not say the job runs with the tools of the run that asked").toMatch(/tools of the run that asked/i);
    const payload = JSON.parse(row!.payload) as { capabilities?: string[] };
    // The run's own set: what its sender could call, plus the inert tools every bot has (saying and asking, drafting).
    expect(payload.capabilities, "the job does not carry the tools of the run that asked").toEqual(expect.arrayContaining(["ask", "job_schedule", "say"]));
    expect(payload.capabilities ?? [], "the job carries a tool the run that asked could not call").not.toContain("bash");

    // The fire: the persona has many more tools, but only these are callable.
    later(minutes(6));
    s.model.queue(...scripted(true, [call("job_list", {}, "call_fire_list"), call("bash", { command: "ls" }, "call_fire_bash"), say("Counted.")]));
    for (let tick = 0; tick < 6 && !allCallsTo(s, "bash", a).length; tick += 1) await s.runner().tick();
    owner.stop();
    for (const [tool, id] of [["job_list", "call_fire_list"], ["bash", "call_fire_bash"]] as const) {
      const record = allCallsTo(s, tool, a).find((entry) => entry.callID === id);
      expect(record, `the fire never made ${id}; the script is out of step`).toBeDefined();
      expect({ call: id, error: String(resultJson(record).error ?? "(no error)") }).toEqual({ call: id, error: expect.stringMatching(/not available/i) });
    }
  });

  scenarioTest("a job whose stored tools cannot be read fires with the inert tools only, and one with no stored tools is as before", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    enqueueJob(s.db, { kind: "turn", payload: { text: "Unreadable.", agentID: "ea", notify: false, inputRole: "system", scheduledBy: "bot", capabilities: "everything" } });
    enqueueJob(s.db, { kind: "turn", payload: { text: "Plain.", agentID: "ea", notify: false, inputRole: "system", scheduledBy: "bot" } });
    s.model.queue(...scripted(true, [call("job_list", {}, "call_unreadable"), say("Tried.")]), ...scripted(true, [call("job_list", {}, "call_plain"), say("Listed.")]));
    for (let tick = 0; tick < 6 && !allCallsTo(s, "job_list", a).some((entry) => entry.callID === "call_plain"); tick += 1) await s.runner().tick();
    const unreadable = allCallsTo(s, "job_list", a).find((entry) => entry.callID === "call_unreadable");
    const plain = allCallsTo(s, "job_list", a).find((entry) => entry.callID === "call_plain");
    expect(unreadable, "the first fire never made its call; the script is out of step").toBeDefined();
    expect(String(resultJson(unreadable).error ?? "(no error)"), "a fire whose stored tools cannot be read got its persona's tools").toMatch(/not available/i);
    expect(plain, "the second fire never made its call; the script is out of step").toBeDefined();
    expect(Object.hasOwn(resultJson(plain), "error"), "a job with no stored tools was cut down").toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. a routine from a run its own tool refuses is refused before any card
// ---------------------------------------------------------------------------

describe("a routine's creation or resumption from a run that the routine tools refuse raises no card", () => {
  let rig: PolicyRig | undefined;
  afterEach(() => { rig?.close(); rig = undefined; });
  const create = { name: "Inbox", prompt: "Check the inbox.", cron: "0 9 * * *", timezone: "UTC" };
  const routineHandler = (r: PolicyRig, at: number): Handler => createRoutineTools(r.db)[at]!.handler as unknown as Handler;

  test("a job, a wake, a brief from a bot and a routine are refused (the tool would refuse them after the owner said yes); the owner's own turn and a job the owner made are not", async () => {
    rig = policyRig();
    const made = await routineHandler(rig, 0)(create, ctxOf(rig.run)) as unknown as { id: string };
    const resume = { id: made.id, enabled: true };
    for (const [tool, args] of [["routine_create", create], ["routine_pause", resume]] as const) {
      for (const [what, run] of [
        ["a job a bot made", rig.another({ principal: { kind: "job" }, jobID: "job_bot" })],
        ["a wake", rig.another({ principal: { kind: "wake" } })],
        ["a brief from a bot that read nothing outside", rig.another({ principal: { kind: "peer", from: "boss" }, taint: [] })],
      ] as const) {
        expect({ tool, what, decision: decide(run, { tool, args, callID: "call_1" }) }).toMatchObject({ tool, what, decision: { action: "refuse", code: "protected_write" } });
      }
      // The owner's own turn runs it; a job the owner made (it runs as the owner) is still asked, as before.
      expect({ tool, own: decide(rig.run, { tool, args, callID: "call_1" }).action }).toEqual({ tool, own: "run" });
      expect({ tool, ownersJob: decide(rig.another({ principal: { kind: "owner" }, jobID: "job_owner" }), { tool, args, callID: "call_1" }).action }).toEqual({ tool, ownersJob: "ask" });
    }
    // Pausing is not a standing rule and is not refused here.
    expect(decide(rig.another({ principal: { kind: "job" }, jobID: "job_bot" }), { tool: "routine_pause", args: { id: made.id, enabled: false }, callID: "call_1" }).action).toBe("run");
  });

  test("the refusal says why and is not recorded as the owner's no", () => {
    rig = policyRig();
    const decision = decide(rig.another({ principal: { kind: "job" }, jobID: "job_bot" }), { tool: "routine_create", args: create, callID: "call_1" });
    expect(decision.action).toBe("refuse");
    if (decision.action === "refuse") expect(decision.error).toMatch(/routine/i);
    expect(rig.db.query("SELECT id FROM run_denials").all(), "a refusal the owner never made was recorded as a denial").toEqual([]);
  });

  scenarioTest("through the real loop: a fire of a job a bot made is told no and the owner is never asked", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    s.model.queue(...scripted(true, [call("job_schedule", { text: "Make a routine.", at: past() }, "call_seed"), say("Scheduled.")]));
    await playTurn(s, a, "set up a job", { answer: () => "once" });
    const owner = answerCards(a, "once");
    s.model.queue(...scripted(true, [call("routine_create", create, "call_routine"), say("Tried.")]));
    for (let tick = 0; tick < 6 && !allCallsTo(s, "routine_create", a).some((entry) => entry.callID === "call_routine"); tick += 1) await s.runner().tick();
    owner.stop();
    const record = allCallsTo(s, "routine_create", a).find((entry) => entry.callID === "call_routine");
    expect(record, "the job never made the call; the script is out of step").toBeDefined();
    expect(owner.cards, "the owner was asked about a routine the tool would refuse anyway").toEqual([]);
    expect(String(resultJson(record).error ?? "(no error)")).toMatch(/routine/i);
    expect(s.all("SELECT id FROM routines")).toEqual([]);
  });
});
