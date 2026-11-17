/**
 * Sprint 2, fix round K: a one-shot job from a chain a bot made is a standing rule, decided by one bit carried forward.
 *
 * The decision used to look at the ROOT job's `scheduledBy`. If the owner's job fired and a bot scheduled a follow-up, the follow-up's
 * wake read as the owner's (its root was the owner's job), and a wake whose root was no job at all (null) got past even when its chain
 * went through a bot's job. Now the run's own bit decides (`ownerOnly`, `policy/carry.ts`): the owner's work only if the chain started with the
 * owner and no bot made a link since; anything missing or unreadable is a bot's.
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { addApprovalRule, approvalTarget } from "../src/stores/approval-rules";
import { decide } from "../src/policy/engine";
import { ownerJobPayload } from "../src/jobs/owner-job";
import { standingRuleOrigin, standingScheduleKind } from "../src/policy/standing-rules";
import { resetS2Startup } from "../src/startup/s2";
import { enqueueJob } from "../src/stores/jobs";
import { createJobTools, scheduleJob } from "../src/tools/jobs-tool";
import type { RunContext } from "../src/policy/types";
import { scenarioTest, useScenarios, say } from "./scenarios/harness";
import { allCallsTo, answerCards, call, playTurn, resultJson, scripted, useWeb } from "./invariants/support";
import { policyRig, type PolicyRig } from "./policy-fixture";

const scenarios = useScenarios();
useWeb();
afterEach(() => { setSystemTime(); resetS2Startup(); });

const future = (): string => new Date(Date.now() + 3_600_000).toISOString();
const past = (): string => new Date(Date.now() - 1_000).toISOString();
const once = (): Record<string, unknown> => ({ text: "do the next round", at: future() });

describe("the engine asks about a one-shot job by the run's own flags, not by a root job's row", () => {
  let rig: PolicyRig | undefined;
  afterEach(() => { rig?.close(); rig = undefined; });
  const asked = (run: RunContext) => decide(run, { tool: "job_schedule", args: once(), callID: "call_1" });

  test("a wake whose chain a bot made a link of is asked, whatever its root is: a null root, the owner's job, a job that is gone", () => {
    rig = policyRig();
    const ownerJob = enqueueJob(rig.db, { kind: "turn", payload: ownerJobPayload({ text: "weekly check", agentID: "ea" }) }).id;
    for (const [what, rootJob] of [["no root job at all", undefined], ["the owner's own job", ownerJob], ["a job that is gone", "job_gone"]] as const) {
      const decision = asked(rig.another({ principal: { kind: "wake" }, ...(rootJob ? { rootJob } : {}), ownerOnly: false }));
      expect({ what, action: decision.action }).toEqual({ what, action: "ask" });
      if (decision.action === "ask") {
        expect(decision.card.standingKind).toBe("next_job");
        expect(decision.card.canRemember, "a one-shot job from a bot's chain offered Always allow").toBe(false);
      }
    }
  });

  test("a wake with no record of where its chain came from is asked", () => {
    rig = policyRig();
    expect(asked(rig.another({ principal: { kind: "wake" } })).action, "a wake with no provenance got past").toBe("ask");
    expect(asked(rig.another({ principal: { kind: "wake" }, rootJob: "job_gone" })).action).toBe("ask");
  });

  test("a run whose bit cannot be read is asked, the owner's own turn included", () => {
    rig = policyRig();
    for (const ownerOnly of [undefined, "yes", 1, null, {}, "true"]) {
      const broken = { ...rig.another({ principal: { kind: "wake" }, ownerOnly: true }), ownerOnly } as unknown as RunContext;
      expect({ ownerOnly, action: asked(broken).action }).toEqual({ ownerOnly, action: "ask" });
    }
    const ownTurn = { ...rig.run, ownerOnly: "yes" } as unknown as RunContext;
    expect(standingScheduleKind(once(), ownTurn)).toBe("next_job");
    expect(standingRuleOrigin(ownTurn), "the card has nothing to say about why the owner is asked").not.toBeNull();
  });

  test("the root job's row is not read at all: a root that is gone, or whose payload is not an object, changes nothing", () => {
    rig = policyRig();
    const botJob = scheduleJob(rig.db, { text: "start", at: future() }, "ea").id;
    const junk = enqueueJob(rig.db, { kind: "turn", payload: ["not", "an", "object"] }).id;
    for (const rootJob of [botJob, junk, "job_gone"]) {
      expect({ rootJob, action: asked(rig.another({ principal: { kind: "wake" }, rootJob, ownerOnly: true })).action }).toEqual({ rootJob, action: "run" });
    }
  });

  test("a pure owner chain is not asked: the owner's own turn, a wake of it, and a job the owner made", async () => {
    rig = policyRig();
    expect(asked(rig.run).action).toBe("run");
    expect(asked(rig.another({ principal: { kind: "wake" }, ownerOnly: true })).action).toBe("run");
    expect(asked(rig.another({ principal: { kind: "owner" }, jobID: "job_owner", ownerOnly: true })).action).toBe("run");
    // The tool's own check agrees: the engine and the handler ask one question.
    const wake = rig.another({ principal: { kind: "wake" }, ownerOnly: true });
    const handler = createJobTools(rig.db)[0]!.handler as unknown as (args: unknown, ctx: unknown) => Promise<{ id?: string; error?: string }>;
    const ctx = (run: RunContext) => ({ threadID: "thr", turnID: "trn", signal: new AbortController().signal, run, chain: { depth: 1, rootAgentID: "ea", currentAgentID: "ea", handoffSummary: null } });
    expect((await handler(once(), ctx(wake))).id, "the owner's own chain was refused").toBeDefined();
    expect((await handler(once(), ctx(rig.another({ principal: { kind: "wake" }, ownerOnly: false })))).error).toMatch(/standing rule|not you/i);
    expect((await handler(once(), ctx(rig.another({ principal: { kind: "wake" } })))).error, "a wake with no record of its chain was let through").toMatch(/standing rule|not you/i);
  });

  test("a stored rule never approves a one-shot job from a bot's chain, and a pure owner chain is not held up by one", () => {
    rig = policyRig();
    const args = once();
    const target = approvalTarget("job_schedule", args);
    expect(target).not.toBeNull();
    addApprovalRule(rig.db, { agentID: rig.run.bot, toolName: "job_schedule", target: target! });
    const fromBot = asked(rig.another({ principal: { kind: "wake" }, ownerOnly: false }));
    expect(fromBot.action, "a stored rule approved work a bot's chain started").toBe("ask");
    expect(asked(rig.another({ principal: { kind: "wake" }, ownerOnly: true })).action).toBe("run");
  });
});

// ---------------------------------------------------------------------------
// through the real loop
// ---------------------------------------------------------------------------

describe("through the real loop: a bot's follow-up chain is put to the owner at its wake", () => {
  scenarioTest("the owner's job fires, a bot schedules a follow-up, the follow-up fires: its wake is asked, and the flag survives every hop", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    const owner = answerCards(a, "once");
    enqueueJob(s.db, { kind: "turn", payload: ownerJobPayload({ text: "Weekly pallet check.", agentID: "ea", notify: false }) });
    s.model.queue(
      // Run 1: the owner's own job fires. The owner's chain: it may schedule a follow-up with no card.
      ...scripted(true, [call("job_schedule", { text: "Count the pallets.", at: past() }, "call_follow"), say("Scheduled.")]),
      // Run 2: the follow-up (a bot's job) fires and delegates.
      ...scripted(true, [call("delegate_task", { toAgentID: "researcher", goal: "Count the pallets." }, "call_delegate"), say("The researcher is counting.")]),
      say("There are 41 pallets."),
      // Run 4: the wake. It is the follow-up's chain, which a bot made a link of: asked, though its root is the owner's own job.
      ...scripted(true, [call("job_schedule", { text: "Count them again.", at: future() }, "call_next"), say("Noted.")]),
    );
    const decided = (): boolean => allCallsTo(s, "job_schedule", a).some((entry) => entry.callID === "call_next");
    for (let tick = 0; tick < 14 && !decided(); tick += 1) await s.runner().tick();
    owner.stop();

    const records = allCallsTo(s, "job_schedule", a);
    const follow = records.find((entry) => entry.callID === "call_follow");
    const next = records.find((entry) => entry.callID === "call_next");
    expect(follow, "the owner's job never scheduled its follow-up; the script is out of step").toBeDefined();
    expect(next, "the wake never made its call; the script is out of step").toBeDefined();
    expect(follow!.card, "the owner's own job was asked about its follow-up").toBeNull();
    expect(resultJson(follow).id, "the follow-up was not made").toBeDefined();
    expect(owner.cards.length, "the wake of a bot-made follow-up scheduled the next link with no card").toBe(1);
    expect(owner.cards[0]!.buttons).toEqual(["once", "reject"]);
    expect(next!.card).not.toBeNull();

    // The chain's record, hop by hop: the job the bot scheduled, the task's brief, and the wake that reports back.
    const hops = s.all<{ payload: string }>("SELECT payload FROM jobs WHERE kind = 'turn'").map((row) => JSON.parse(row.payload) as { text?: string; ownerOnly?: unknown; wakeKey?: string; delegationTaskID?: string });
    expect(hops.find((hop) => hop.text === "Count the pallets.")?.ownerOnly, "the follow-up job does not say a bot made it").toBe(false);
    expect(hops.find((hop) => hop.delegationTaskID)?.ownerOnly, "the delegation dropped the bit").toBe(false);
    expect(JSON.parse(s.get<{ brief: string }>("SELECT brief FROM tasks WHERE owner_agent_id = 'researcher'")!.brief).ownerOnly, "the task's brief dropped the bit").toBe(false);
    expect(hops.find((hop) => hop.wakeKey)?.ownerOnly, "the wake dropped the bit").toBe(false);
    // The job the owner said yes to is a bot's link too, and carries the bit into its own fire.
    const approved = hops.find((hop) => hop.text === "Count them again.");
    expect(approved, "the owner's yes did not make the job").toBeDefined();
    expect(approved!.ownerOnly).toBe(false);
  });

  scenarioTest("a wake with no root job, whose chain went through a bot's job, is asked", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    const owner = answerCards(a, "reject");
    s.model.queue(
      // The owner's own turn delegates; the wake it gets is the owner's chain, and may schedule with no card (it is made at once).
      ...scripted(true, [call("delegate_task", { toAgentID: "researcher", goal: "Count the pallets." }, "call_delegate"), say("The researcher is counting.")]),
    );
    await playTurn(s, a, "count the pallets", { answer: () => "once" });
    s.model.queue(
      say("There are 41 pallets."),
      ...scripted(true, [call("job_schedule", { text: "Count the crates.", at: past() }, "call_seed"), say("Scheduled.")]),
      // The job a bot made fires and delegates; its wake has no root job (the chain began in the owner's turn), but went through a bot's job.
      ...scripted(true, [call("delegate_task", { toAgentID: "researcher", goal: "Count the crates." }, "call_delegate_2"), say("Counting.")]),
      say("There are 12 crates."),
      ...scripted(true, [call("job_schedule", { text: "Count the barrels.", at: future() }, "call_next"), say("Noted.")]),
    );
    const decided = (): boolean => allCallsTo(s, "job_schedule", a).some((entry) => entry.callID === "call_next");
    for (let tick = 0; tick < 16 && !decided(); tick += 1) await s.runner().tick();
    owner.stop();

    const seed = allCallsTo(s, "job_schedule", a).find((entry) => entry.callID === "call_seed");
    const next = allCallsTo(s, "job_schedule", a).find((entry) => entry.callID === "call_next");
    expect(seed, "the owner-chain wake never scheduled its job; the script is out of step").toBeDefined();
    expect(next, "the second wake never made its call; the script is out of step").toBeDefined();
    expect(seed!.card, "a wake of the owner's own turn was asked").toBeNull();
    const made = s.all<{ payload: string }>("SELECT payload FROM jobs WHERE kind = 'turn'").map((row) => JSON.parse(row.payload) as { text?: string; rootJob?: string | null; rootTurnID?: string });
    const link = made.find((payload) => payload.text === "Count the crates.");
    expect(link?.rootTurnID, "the job did not stay in the owner's request").toBeDefined();
    expect(link?.rootJob, "the test is not about a wake with no root job").toBeNull();
    expect(owner.cards.length, "the wake of a chain that went through a bot's job got past with no card").toBe(1);
    expect(next!.card).not.toBeNull();
  });

  // A job nothing proves to be the owner's is a bot's, and a bot's job with no record of what its sender read is tainted as an unknown source
  // (round L): a tainted run may not schedule at all, so it is not asked either; the follow-up is not made. (The owner's own jobs from before the
  // marker are stamped by migration 65.)
  scenarioTest("a job with no marker, or whose marker cannot be read, is not shown to be the owner's: it is tainted and may not schedule a follow-up", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    const owner = answerCards(a, "reject");
    for (const [text, extra] of [["Old job.", {}], ["Odd job.", { ownerOnly: "owner" }], ["List job.", { ownerOnly: [true, false] }], ["Half job.", { ownerOnly: "true" }]] as const) {
      enqueueJob(s.db, { kind: "turn", payload: { text, agentID: "ea", notify: false, ...extra } });
    }
    s.model.queue(
      ...scripted(true, [call("job_schedule", { text: "Follow old.", at: future() }, "call_old"), say("Tried.")]),
      ...scripted(true, [call("job_schedule", { text: "Follow odd.", at: future() }, "call_odd"), say("Tried.")]),
      ...scripted(true, [call("job_schedule", { text: "Follow list.", at: future() }, "call_list"), say("Tried.")]),
      ...scripted(true, [call("job_schedule", { text: "Follow half.", at: future() }, "call_half"), say("Tried.")]),
    );
    const done = (): boolean => allCallsTo(s, "job_schedule", a).length >= 4;
    for (let tick = 0; tick < 8 && !done(); tick += 1) await s.runner().tick();
    owner.stop();
    expect(allCallsTo(s, "job_schedule", a).length, "the fires never made their calls; the script is out of step").toBe(4);
    expect(owner.cards.length, "a tainted run was put a card for a one-shot job").toBe(0);
    for (const entry of allCallsTo(s, "job_schedule", a)) expect({ call: entry.callID, made: resultJson(entry).id }).toEqual({ call: entry.callID, made: undefined });
    expect(s.all<{ payload: string }>("SELECT payload FROM jobs WHERE kind = 'turn'").filter((row) => /Follow /.test((JSON.parse(row.payload) as { text?: string }).text ?? "") && (JSON.parse(row.payload) as { scheduledBy?: string }).scheduledBy === "bot"), "a job with no readable marker scheduled its follow-up").toEqual([]);
  });

  scenarioTest("a pure owner chain of two links is not asked, and its stored rules apply", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    const owner = answerCards(a, "reject");
    s.model.queue(
      ...scripted(true, [call("delegate_task", { toAgentID: "researcher", goal: "Count the pallets." }, "call_delegate"), say("The researcher is counting.")]),
    );
    await playTurn(s, a, "count the pallets", { answer: () => "once" });
    s.model.queue(
      say("There are 41 pallets."),
      ...scripted(true, [call("job_schedule", { text: "Count them again later.", at: future() }, "call_next"), say("Noted.")]),
    );
    const decided = (): boolean => allCallsTo(s, "job_schedule", a).some((entry) => entry.callID === "call_next");
    for (let tick = 0; tick < 8 && !decided(); tick += 1) await s.runner().tick();
    owner.stop();
    const next = allCallsTo(s, "job_schedule", a).find((entry) => entry.callID === "call_next");
    expect(next, "the wake never made its call; the script is out of step").toBeDefined();
    expect(owner.cards, "a wake of the owner's own turn was asked").toEqual([]);
    expect(next!.card).toBeNull();
    expect(resultJson(next).id, "the owner's own chain could not schedule").toBeDefined();
  });
});
