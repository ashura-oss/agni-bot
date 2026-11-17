/**
 * Sprint 2, fix round J: standing work that a bot starts from a chain.
 *
 *  1. A wake in a chain a bot-made job started is a link of that chain: a one-shot job it schedules is put to the owner.
 *  2. A job approved from a run whose tools were narrowed (a bot's brief, a delegated task, a job that was itself narrowed) fires with
 *     the tools of the run that asked, never with its persona's full set; unreadable means the inert tools only.
 *  3. A routine's creation or resumption from a run a routine's own tool would refuse is refused before any card.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { resetS2Startup } from "../src/startup/s2";
import { createJobTools, scheduleJob } from "../src/tools/jobs-tool";
import { createRoutineTools } from "../src/tools/routines-tool";
import { decide } from "../src/policy/engine";
import { addTaint } from "../src/policy/context";
import { standingRuleOrigin, standingScheduleKind } from "../src/policy/standing-rules";
import { enqueueJob } from "../src/stores/jobs";
import type { RunContext } from "../src/policy/types";
import { scenarioTest, useScenarios, say } from "./scenarios/harness";
import { allCallsTo, answerCards, call, playTurn, resultJson, scripted, useWeb } from "./invariants/support";
import { policyRig, type PolicyRig } from "./policy-fixture";

const scenarios = useScenarios();
useWeb();
afterEach(() => { resetS2Startup(); });

const future = (): string => new Date(Date.now() + 3_600_000).toISOString();
const past = (): string => new Date(Date.now() - 1_000).toISOString();

type Handler = (args: unknown, ctx: unknown) => Promise<{ id?: string; error?: string }>;
const jobHandler = (rig: PolicyRig): Handler => createJobTools(rig.db)[0]!.handler as unknown as Handler;
const ctxOf = (run: RunContext, extra: Record<string, unknown> = {}) => ({ threadID: "thr", turnID: "trn", signal: new AbortController().signal, run, chain: { depth: 1, rootAgentID: "ea", currentAgentID: "ea", handoffSummary: null }, ...extra });

describe("a wake in a chain a bot-made job started may not schedule the next one-shot job without a card", () => {
  let rig: PolicyRig | undefined;
  afterEach(() => { rig?.close(); rig = undefined; });
  const once = (): Record<string, unknown> => ({ text: "do the next round", at: future() });

  test("the engine asks for a wake whose root is a job a bot made, and for nothing else of a wake", () => {
    rig = policyRig();
    const botJob = scheduleJob(rig.db, { text: "start", at: future() }, "ea").id;
    const ownerJob = enqueueJob(rig.db, { kind: "turn", runAt: past(), payload: { agentID: "ea", text: "weekly check" } }).id;

    const fromBotChain = decide(rig.another({ principal: { kind: "wake" }, rootJob: botJob }), { tool: "job_schedule", args: once(), callID: "call_1" });
    expect(fromBotChain.action, "a wake in a bot-made job's chain scheduled the next link with no card").toBe("ask");
    if (fromBotChain.action === "ask") {
      expect(fromBotChain.card.standingKind).toBe("next_job");
      expect(fromBotChain.card.canRemember).toBe(false);
    }
    // A root job that cannot be found is not shown to be the owner's: asked.
    expect(decide(rig.another({ principal: { kind: "wake" }, rootJob: "job_gone" }), { tool: "job_schedule", args: once(), callID: "call_1" }).action).toBe("ask");
    // The owner's own chat turn that delegated (no root job), and a job the owner made, are not the start of a chain.
    expect(decide(rig.another({ principal: { kind: "wake" } }), { tool: "job_schedule", args: once(), callID: "call_1" }).action).toBe("run");
    expect(decide(rig.another({ principal: { kind: "wake" }, rootJob: ownerJob }), { tool: "job_schedule", args: once(), callID: "call_1" }).action).toBe("run");
    // A tainted wake is still refused outright, as any tainted run is.
    const tainted = rig.another({ principal: { kind: "wake" }, rootJob: botJob });
    addTaint(tainted, { kind: "web", label: "evil.example/page", tool: "web_fetch", at: "2026-11-16T10:00:00Z" });
    expect(decide(tainted, { tool: "job_schedule", args: once(), callID: "call_1" })).toMatchObject({ action: "refuse", code: "protected_write" });
  });

  test("the classification and the tool's own check agree, and the card names the wake", () => {
    rig = policyRig();
    const botJob = scheduleJob(rig.db, { text: "start", at: future() }, "ea").id;
    const wake = rig.another({ principal: { kind: "wake" }, rootJob: botJob });
    expect(standingScheduleKind(once(), wake)).toBe("next_job");
    expect(standingRuleOrigin(wake)).toMatch(/reporting back/);
  });

  test("the tool refuses it too unless the loop carries the owner's yes", async () => {
    rig = policyRig();
    const botJob = scheduleJob(rig.db, { text: "start", at: future() }, "ea").id;
    const wake = rig.another({ principal: { kind: "wake" }, rootJob: botJob });
    const before = rig.db.query("SELECT id FROM jobs WHERE kind = 'turn'").all().length;
    const refused = await jobHandler(rig)(once(), ctxOf(wake));
    expect(refused.id, "a wake in a bot-made job's chain made the next link with no owner's yes").toBeUndefined();
    expect(refused.error).toMatch(/standing rule|not you/i);
    expect(rig.db.query("SELECT id FROM jobs WHERE kind = 'turn'").all().length).toBe(before);
    const approved = await jobHandler(rig)(once(), ctxOf(wake, { ownerApproved: true }));
    expect(approved.id, "the owner's yes did not make the link").toBeDefined();
    // The owner's own chat turn that delegated is not asked.
    expect((await jobHandler(rig)(once(), ctxOf(rig.another({ principal: { kind: "wake" } })))).id).toBeDefined();
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
