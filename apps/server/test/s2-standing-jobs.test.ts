/**
 * A repeating job is a standing rule (Sprint 2, fix round G).
 *
 * A recurring job (`dailyAt`, `everyMinutes`) gives every fire a fresh request, so one request could turn into unbounded
 * wakes, and an injected bot could plant a job that keeps itself alive. Making one is therefore a standing rule: it may
 * be created directly only by the owner's own untainted turn. Any other origin (a job-fire run, a bot-to-bot, delegated,
 * wake or resumed run, a tainted run, an origin that cannot be read) puts a card to the owner, and no job exists until
 * the owner approves. A refusal is a run denial. A card never offers "Always allow", and no stored rule approves one.
 *
 * Also here: the wake key carries the wake scope (two runs of one recurring job do not share a queued wake).
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { resetS2Startup } from "../src/startup/s2";
import { setRunCaps } from "../src/stores/policy-settings";
import { enqueueJob } from "../src/stores/jobs";
import { addApprovalRule, approvalTarget } from "../src/stores/approval-rules";
import { createJobTools } from "../src/tools/jobs-tool";
import { resolvePersona } from "../src/agent/personas";
import { decide } from "../src/policy/engine";
import { addTaint } from "../src/policy/context";
import type { Decision, RunContext } from "../src/policy/types";
import { scenarioTest, useScenarios, say, type Scenario, type ScenarioClient } from "./scenarios/harness";
import { HOSTILE_URL, allCallsTo, answerCards, call, later, minutes, playTurn, resultJson, scripted, useWeb, type Answer, type TurnReport } from "./invariants/support";
import { policyRig, type PolicyRig } from "./policy-fixture";

const scenarios = useScenarios();
useWeb();
afterEach(() => { setSystemTime(); resetS2Startup(); });

const past = (): string => new Date(Date.now() - 1_000).toISOString();

interface JobPayload { text?: string; everyMs?: number; dailyAt?: string; scheduledBy?: string; denialRoot?: string; createdByRequest?: string; rootTurnID?: string }
interface JobRowOf { id: string; state: string; payload: JobPayload }

const turnJobs = (s: Scenario): JobRowOf[] =>
  s.all<{ id: string; state: string; payload: string }>("SELECT id, state, payload FROM jobs WHERE kind = 'turn' ORDER BY rowid").map((row) => ({ id: row.id, state: row.state, payload: JSON.parse(row.payload) as JobPayload }));
const recurringJobs = (s: Scenario): JobRowOf[] => turnJobs(s).filter((job) => job.payload.everyMs !== undefined || job.payload.dailyAt !== undefined);
const auditRows = (s: Scenario, kind: string): Array<{ actor: string | null; turn_id: string | null; job_id: string | null; detail: Record<string, unknown> }> =>
  s.all<{ actor: string | null; turn_id: string | null; job_id: string | null; detail: string }>("SELECT actor, turn_id, job_id, detail FROM audit_events WHERE kind = ? ORDER BY seq", kind)
    .map((row) => ({ ...row, detail: JSON.parse(row.detail) as Record<string, unknown> }));
const botName = (s: Scenario): string => resolvePersona(s.db, "ea")!.name;

/** The owner's own clean turn schedules a one-shot job; the job is due at once. The run that job gets is a job-fire run. */
async function ownerSchedulesAJob(s: Scenario, a: ScenarioClient): Promise<TurnReport> {
  s.model.queue(...scripted(true, [call("job_schedule", { text: "Look after the inbox.", at: past() }, "call_seed"), say("Scheduled.")]));
  const report = await playTurn(s, a, "look after the inbox", { answer: () => "once" });
  expect(report.calls.find((entry) => entry.callID === "call_seed")?.ok, "the owner's turn could not schedule the seed job; the script is out of step").toBe(true);
  return report;
}

async function tickUntil(s: Scenario, done: () => boolean, ticks = 8): Promise<void> {
  for (let tick = 0; tick < ticks && !done(); tick += 1) await s.runner().tick();
}

const FORMS: Array<[string, Record<string, unknown>, RegExp]> = [
  ["everyMinutes", { text: "Check the inbox.", everyMinutes: 30 }, /every 30 minutes/i],
  ["dailyAt", { text: "Check the inbox.", dailyAt: "09:05", days: ["mon", "tue"] }, /09:05/],
];

describe("a run a job fire started may not create a repeating job without the owner's card", () => {
  for (const [form, args, words] of FORMS) {
    scenarioTest(`${form}: a card is shown with the bot, the schedule in words and the prompt; no job exists until the owner approves`, async () => {
      const s = await scenarios.start();
      const a = await s.connect({ label: "A" });
      await ownerSchedulesAJob(s, a);

      const owner = answerCards(a, "reject");
      s.model.queue(...scripted(true, [call("job_schedule", args, "call_recur"), say("Tried.")]));
      await tickUntil(s, () => allCallsTo(s, "job_schedule", a).some((entry) => entry.callID === "call_recur"));
      owner.stop();

      const record = allCallsTo(s, "job_schedule", a).find((entry) => entry.callID === "call_recur");
      expect(record, "the job-fire run never made the call; the script is out of step").toBeDefined();
      expect(owner.cards.length, "the job-fire run was not asked about; the repeating job was made (or refused) without the owner").toBe(1);
      const card = owner.cards[0]!;
      expect(card.buttons, "a repeating job card offers Always allow").toEqual(["once", "reject"]);
      expect(card.preview, "the card does not name the bot").toContain(botName(s));
      expect(card.preview, "the card does not say the schedule in words").toMatch(words);
      expect(card.preview, "the card does not show the job's prompt").toContain("Check the inbox.");
      expect(String(resultJson(record).error ?? "(no error)"), "the bot was not told the owner said no").toMatch(/denied|not approved/i);
      expect(recurringJobs(s), "a repeating job exists though the owner refused").toEqual([]);
    });
  }

  scenarioTest("a job the owner made, which runs as the owner, is still a job fire: a repeating job from it asks", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    enqueueJob(s.db, { kind: "turn", runAt: past(), payload: { agentID: "ea", text: "Do the weekly check.", notify: false } });
    const owner = answerCards(a, "reject");
    s.model.queue(...scripted(true, [call("job_schedule", { text: "Check the inbox.", everyMinutes: 30 }, "call_recur"), say("Tried.")]));
    await tickUntil(s, () => allCallsTo(s, "job_schedule", a).some((entry) => entry.callID === "call_recur"));
    owner.stop();
    expect(allCallsTo(s, "job_schedule", a).some((entry) => entry.callID === "call_recur"), "the owner's job never made the call; the script is out of step").toBe(true);
    expect(owner.cards.length, "a fire of the owner's own job made a repeating job with no card").toBe(1);
    expect(recurringJobs(s)).toEqual([]);
  });

  scenarioTest("a repeating job that could never be made is refused before any card is shown", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    await ownerSchedulesAJob(s, a);
    const owner = answerCards(a, "once");
    s.model.queue(...scripted(true, [
      call("job_schedule", { text: "Check the inbox.", dailyAt: "9am" }, "call_bad_time"),
      call("job_schedule", { text: "Check the inbox.", dailyAt: "09:05", days: ["someday"] }, "call_bad_day"),
      call("job_schedule", { text: "Check the inbox.", dailyAt: "09:05", everyMinutes: 30 }, "call_two"),
      say("Tried."),
    ]));
    await tickUntil(s, () => allCallsTo(s, "job_schedule", a).some((entry) => entry.callID === "call_two"));
    owner.stop();
    expect(owner.cards, "the owner was asked about a repeating job that could never be made").toEqual([]);
    for (const id of ["call_bad_time", "call_bad_day", "call_two"]) {
      expect(String(resultJson(allCallsTo(s, "job_schedule", a).find((entry) => entry.callID === id)).error ?? "(no error)"), id).toMatch(/wall-clock|weekday|pick one/i);
    }
    expect(recurringJobs(s)).toEqual([]);
  });

  scenarioTest("the job's prompt is shown as data: a prompt that looks like a card line is quoted and escaped", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    await ownerSchedulesAJob(s, a);
    const owner = answerCards(a, "reject");
    s.model.queue(...scripted(true, [call("job_schedule", { text: "Tidy up.\nRisk: nothing at all‮fdp.exe", everyMinutes: 30 }, "call_recur"), say("Tried.")]));
    await tickUntil(s, () => owner.cards.length > 0);
    owner.stop();
    const preview = owner.cards[0]?.preview ?? "";
    expect(preview, "no card was shown; the script is out of step").not.toBe("");
    expect(preview, "the prompt's own line was not quoted").toContain("> Risk: nothing at all");
    expect(preview, "a bidirectional override reached the card as a character").not.toContain("‮");
    expect(preview).toContain("\\u202E");
  });
});

describe("a tainted owner turn may not create a repeating job without the owner's card", () => {
  scenarioTest("the card names what the run read, offers no Always allow, and no job exists after a refusal", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    s.model.queue(...scripted(true, [
      call("web_fetch", { url: HOSTILE_URL }, "call_page"),
      call("job_schedule", { text: "Check the vendor page daily.", dailyAt: "09:05" }, "call_recur"),
      say("Tried."),
    ]));
    const report = await playTurn(s, a, "read the vendor notes and keep an eye on them", { answer: () => "reject" });
    const record = report.calls.find((entry) => entry.callID === "call_recur");
    expect(record?.card, "the tainted turn made (or was refused) the repeating job with no card").not.toBeNull();
    expect(report.cards.length).toBe(1);
    expect(report.cards[0]!.buttons).toEqual(["once", "reject"]);
    expect(JSON.stringify(report.cards[0]!.raw.source ?? []), "the card does not say the run read a web page").toMatch(/web/i);
    expect(recurringJobs(s)).toEqual([]);
  });

  scenarioTest("a one-shot job is still refused outright in a tainted turn (no card)", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    s.model.queue(...scripted(true, [
      call("web_fetch", { url: HOSTILE_URL }, "call_page"),
      call("job_schedule", { text: "Check later.", at: new Date(Date.now() + 3_600_000).toISOString() }, "call_once"),
      say("Tried."),
    ]));
    const report = await playTurn(s, a, "read the vendor notes", { answer: () => "once" });
    expect(report.cards, "a one-shot job in a tainted turn raised a card").toEqual([]);
    expect(String(resultJson(report.calls.find((entry) => entry.callID === "call_once")).error ?? "(no error)")).toMatch(/outside content|not allowed/i);
  });

  scenarioTest("when the owner approves, the job exists and keeps the run's refusal scope and request", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    s.model.queue(...scripted(true, [
      call("web_fetch", { url: HOSTILE_URL }, "call_page"),
      call("job_schedule", { text: "Check the vendor page daily.", dailyAt: "09:05" }, "call_recur"),
      say("Done."),
    ]));
    const report = await playTurn(s, a, "read the vendor notes and keep an eye on them", { answer: () => "once" });
    expect(report.calls.find((entry) => entry.callID === "call_recur")?.ok, "the approved repeating job was not created").toBe(true);
    const [job] = recurringJobs(s);
    expect(job, "no repeating job exists after the owner approved").toBeDefined();
    expect(job!.payload.createdByRequest).toBe(report.turnID);
    expect(job!.payload.denialRoot).toBe(report.turnID);
  });
});

describe("the owner's own untainted turn creates a repeating job directly", () => {
  scenarioTest("no card, the job exists, and it names the request that made it, with an audit row", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    s.model.queue(...scripted(true, [call("job_schedule", { text: "Check the warehouse.", dailyAt: "09:05" }, "call_recur"), say("Scheduled.")]));
    const report = await playTurn(s, a, "check the warehouse every morning", { answer: () => "reject" });
    expect(report.cards, "the owner's own clean turn was asked about its own repeating job").toEqual([]);
    expect(report.calls.find((entry) => entry.callID === "call_recur")?.ok).toBe(true);
    const [job] = recurringJobs(s);
    expect(job, "the repeating job was not created").toBeDefined();
    expect(job!.payload.createdByRequest, "the job does not name the request that made it").toBe(report.turnID);
    const rows = auditRows(s, "job.recurring.created");
    expect(rows.length, "creating a repeating job left no audit row").toBe(1);
    expect(rows[0]!.detail.jobID).toBe(job!.id);
    expect(rows[0]!.detail.createdByRequest).toBe(report.turnID);
    expect(rows[0]!.detail.approval).toBe("own_turn");
  });
});

describe("an origin that cannot be read is asked about", () => {
  let rig: PolicyRig | undefined;
  afterEach(() => { rig?.close(); rig = undefined; });
  const recur = { text: "do it", everyMinutes: 60 };

  test("a run whose principal or taint record is missing or unknown gets a card with no Always allow", () => {
    rig = policyRig();
    const base = rig.run;
    const broken: Array<[string, RunContext]> = [
      ["no principal", { ...base, principal: undefined } as unknown as RunContext],
      ["an unknown principal kind", { ...base, principal: { kind: "stranger" } } as unknown as RunContext],
      ["no taint record", { ...base, taint: undefined } as unknown as RunContext],
      ["a taint record that is not a list", { ...base, taint: { sources: "none" } } as unknown as RunContext],
    ];
    for (const [what, run] of broken) {
      const decision: Decision = decide(run, { tool: "job_schedule", args: recur, callID: "call_1" });
      expect({ what, action: decision.action }).toEqual({ what, action: "ask" });
      if (decision.action === "ask") expect({ what, canRemember: decision.card.canRemember }).toEqual({ what, canRemember: false });
    }
  });

  test("the owner's own clean run is the only one let through", () => {
    rig = policyRig();
    expect(decide(rig.run, { tool: "job_schedule", args: recur, callID: "call_1" }).action).toBe("run");
    for (const kind of ["job", "wake", "peer", "routine"] as const) {
      const decision = decide(rig.another({ principal: { kind } }), { tool: "job_schedule", args: recur, callID: "call_1" });
      expect({ kind, action: decision.action }).toEqual({ kind, action: "ask" });
    }
    const tainted = rig.another();
    addTaint(tainted, { kind: "web", label: "evil.example/page", tool: "web_fetch", at: "2026-11-16T10:00:00Z" });
    expect(decide(tainted, { tool: "job_schedule", args: recur, callID: "call_1" }).action).toBe("ask");
    // A one-shot job is not a standing rule: a clean run of any kind may make one, a tainted run may not.
    const once = { text: "do it", at: new Date(Date.now() + 3_600_000).toISOString() };
    expect(decide(rig.another({ principal: { kind: "job" } }), { tool: "job_schedule", args: once, callID: "call_1" }).action).toBe("run");
    expect(decide(tainted, { tool: "job_schedule", args: once, callID: "call_1" })).toMatchObject({ action: "refuse", code: "protected_write" });
  });

  test("the tool itself fails closed: no run behind the call, or a run it cannot read, makes no job", async () => {
    rig = policyRig();
    const handler = createJobTools(rig.db)[0]!.handler as unknown as (args: unknown, ctx: unknown) => Promise<{ id?: string; error?: string }>;
    const ctx = { threadID: "thr", turnID: "trn", signal: new AbortController().signal, chain: { depth: 1, rootAgentID: "ea", currentAgentID: "ea", handoffSummary: null } };
    const noRun = await handler(recur, ctx);
    expect(noRun.id, "a repeating job was made by a call with no run behind it").toBeUndefined();
    expect(noRun.error).toMatch(/owner/i);
    const unreadable = await handler(recur, { ...ctx, run: { ...rig.run, principal: undefined } });
    expect(unreadable.id, "a repeating job was made by a run whose principal cannot be read").toBeUndefined();
    const job = rig.db.query("SELECT id FROM jobs WHERE kind = 'turn'").all();
    expect(job).toEqual([]);
  });

  test("a call that says it was approved by the owner is not believed from its arguments", async () => {
    rig = policyRig();
    const handler = createJobTools(rig.db)[0]!.handler as unknown as (args: unknown, ctx: unknown) => Promise<{ id?: string; error?: string }>;
    const run = rig.another({ principal: { kind: "job" } });
    const ctx = { threadID: "thr", turnID: "trn", signal: new AbortController().signal, run, chain: { depth: 1, rootAgentID: "ea", currentAgentID: "ea", handoffSummary: null } };
    const result = await handler({ ...recur, ownerApproved: true, approved: true }, ctx);
    expect(result.id, "a job-fire run made a repeating job by claiming approval in its arguments").toBeUndefined();
  });
});

describe("a refusal of a repeating job is a run denial", () => {
  scenarioTest("the owner's no is recorded, audited, and a retry in that run is refused with no new card", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    const seed = await ownerSchedulesAJob(s, a);

    const owner = answerCards(a, "reject");
    s.model.queue(...scripted(true, [
      call("job_schedule", { text: "Check the inbox.", everyMinutes: 30 }, "call_first"),
      call("job_schedule", { text: "Check the inbox, in other words.", dailyAt: "09:05" }, "call_retry"),
      say("Tried twice."),
    ]));
    await tickUntil(s, () => allCallsTo(s, "job_schedule", a).some((entry) => entry.callID === "call_retry"));
    owner.stop();

    const retry = allCallsTo(s, "job_schedule", a).find((entry) => entry.callID === "call_retry");
    expect(retry, "the run never retried; the script is out of step").toBeDefined();
    expect(owner.cards.length, "the retry raised a second card").toBe(1);
    expect(String(resultJson(retry).error ?? "(no error)"), "the retry was stopped by something other than the refusal").toMatch(/said no|refus/i);
    expect(recurringJobs(s)).toEqual([]);

    const denials = s.all<{ run_key: string; tool_name: string; cause: string; resource_kind: string }>("SELECT run_key, tool_name, cause, resource_kind FROM run_denials");
    expect(denials.length, "the owner's no was not recorded as a run denial").toBe(1);
    expect(denials[0]).toMatchObject({ tool_name: "job_schedule", cause: "denied" });
    // It is the scope the job run holds: the request that made the job.
    expect(denials[0]!.run_key).toBe(seed.turnID);
    const refused = auditRows(s, "job.recurring.refused");
    expect(refused.length, "the refusal left no audit row").toBeGreaterThanOrEqual(1);
    expect(refused[0]!.detail.cause).toBe("denied");
  });

  scenarioTest("it follows the run: a job the refused run schedules may not make a repeating job either", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    await ownerSchedulesAJob(s, a);

    const owner = answerCards(a, "reject");
    s.model.queue(
      ...scripted(true, [
        call("job_schedule", { text: "Check the inbox.", everyMinutes: 30 }, "call_first"),
        call("job_schedule", { text: "Try again from a job.", at: past() }, "call_chain"),
        say("Handed on."),
      ]),
      ...scripted(true, [call("job_schedule", { text: "Check the inbox.", everyMinutes: 45 }, "call_from_chain"), say("Tried.")]),
    );
    await tickUntil(s, () => allCallsTo(s, "job_schedule", a).some((entry) => entry.callID === "call_from_chain"), 10);
    owner.stop();

    expect(allCallsTo(s, "job_schedule", a).find((entry) => entry.callID === "call_chain")?.ok, "the first run could not schedule the one-shot job; the script is out of step").toBe(true);
    const later = allCallsTo(s, "job_schedule", a).find((entry) => entry.callID === "call_from_chain");
    expect(later, "the second job never made the call; the script is out of step").toBeDefined();
    expect(owner.cards.length, "the job the refused run scheduled asked the owner again").toBe(1);
    expect(String(resultJson(later).error ?? "(no error)")).toMatch(/said no|refus/i);
    expect(recurringJobs(s)).toEqual([]);
  });

  scenarioTest("a stored rule never approves a repeating job: the card is still shown, with no Always allow", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    await ownerSchedulesAJob(s, a);
    const args = { text: "Check the inbox.", everyMinutes: 30 };
    const target = approvalTarget("job_schedule", args);
    expect(target, "the baseline cannot build a rule target").not.toBeNull();
    addApprovalRule(s.db, { agentID: "ea", toolName: "job_schedule", target: target! });

    const owner = answerCards(a, "reject");
    s.model.queue(...scripted(true, [call("job_schedule", args, "call_recur"), say("Tried.")]));
    await tickUntil(s, () => allCallsTo(s, "job_schedule", a).some((entry) => entry.callID === "call_recur"));
    owner.stop();

    expect(owner.cards.length, "a stored rule let a repeating job through with no card").toBe(1);
    expect(owner.cards[0]!.buttons).toEqual(["once", "reject"]);
    expect(recurringJobs(s)).toEqual([]);
  });

  scenarioTest("an answer of 'always' to the card still stores no rule", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    await ownerSchedulesAJob(s, a);
    const owner = answerCards(a, "always" as Answer);
    s.model.queue(...scripted(true, [call("job_schedule", { text: "Check the inbox.", everyMinutes: 30 }, "call_recur"), say("Done.")]));
    await tickUntil(s, () => allCallsTo(s, "job_schedule", a).some((entry) => entry.callID === "call_recur"));
    owner.stop();
    expect(s.all("SELECT id FROM approval_rules WHERE tool_name = 'job_schedule'"), "an 'always' answer stored a rule for a repeating job").toEqual([]);
  });
});

/** A repeating job a job-fire run made and the owner approved. */
async function approvedRecurringJob(s: Scenario, a: ScenarioClient): Promise<{ jobID: string; seed: TurnReport; owner: ReturnType<typeof answerCards> }> {
  const seed = await ownerSchedulesAJob(s, a);
  const owner = answerCards(a, "once");
  s.model.queue(...scripted(true, [call("job_schedule", { text: "Count the pallets again and report.", everyMinutes: 5 }, "call_recur"), say("A recount is scheduled.")]));
  await tickUntil(s, () => recurringJobs(s).length > 0);
  const [job] = recurringJobs(s);
  expect(job, "the approved repeating job was not created; the script is out of step").toBeDefined();
  expect(owner.cards.length, "the job-fire run was not asked").toBe(1);
  return { jobID: job!.id, seed, owner };
}

interface WakeJob { id: string; state: string; result: string | null; payload: { rootTurnID?: string; rootJob?: string | null; wakeKey?: string; results?: unknown[] } }
const wakeJobs = (s: Scenario): WakeJob[] =>
  s.all<{ id: string; state: string; result: string | null; payload: string }>("SELECT id, state, result, payload FROM jobs WHERE kind = 'turn' AND payload LIKE '%wakeKey%' ORDER BY rowid")
    .map((row) => ({ ...row, payload: JSON.parse(row.payload) as WakeJob["payload"] }));
const settled = (jobs: WakeJob[]): boolean => jobs.every((job) => job.state === "done" || job.state === "failed");

describe("a repeating job the owner approved", () => {
  scenarioTest("names its request, leaves an audit row, and every fire counts its own wakes", async () => {
    const s = await scenarios.start();
    setRunCaps(s.db, { maxWakesPerRequest: 1 });
    const a = await s.connect({ label: "A" });
    const { jobID, seed, owner } = await approvedRecurringJob(s, a);

    const job = recurringJobs(s)[0]!;
    expect(job.payload.createdByRequest, "the job does not name the request that made it").toBe(seed.turnID);
    expect(job.payload.scheduledBy).toBe("bot");
    const created = auditRows(s, "job.recurring.created");
    expect(created.length, "creating the repeating job left no audit row").toBe(1);
    expect(created[0]!.detail).toMatchObject({ createdByRequest: seed.turnID, approval: "owner_card" });
    expect(created[0]!.detail.jobID).toBe(jobID);

    // Each fire delegates, and its wake is the fire's own first, within the limit of one.
    for (let run = 1; run <= 2; run += 1) {
      later(minutes(6));
      s.model.queue(
        ...scripted(true, [call("delegate_task", { toAgentID: "researcher", goal: `Count the pallets, run ${run}.` }, `call_run_${run}`), say("The researcher is counting.")]),
        say(`There are ${40 + run} pallets.`),
        say("Noted."),
      );
      await tickUntil(s, () => wakeJobs(s).length === run && settled(wakeJobs(s)));
      expect(wakeJobs(s).length, `fire ${run} did not queue its wake; the script is out of step`).toBe(run);
      expect(wakeJobs(s)[run - 1]!.result ?? "", `fire ${run}'s wake was held to a wake count shared with the other fires`).not.toMatch(/wake limit/i);
    }
    owner.stop();
    expect(s.model.overruns, "a wake of a repeating job's fire was not run").toBe(0);
  });

  scenarioTest("two fires of one job do not share a queued wake", async () => {
    const s = await scenarios.start();
    setRunCaps(s.db, { maxWakesPerRequest: 1 });
    const a = await s.connect({ label: "A" });
    const { owner } = await approvedRecurringJob(s, a);

    // The delegated tasks are held until both fires have run, so both wakes are queued at once.
    s.db.run("CREATE TRIGGER hold_tasks AFTER INSERT ON jobs WHEN NEW.payload LIKE '%delegationTaskID%' BEGIN UPDATE jobs SET run_at = '2999-01-01T00:00:00.000Z' WHERE id = NEW.id; END");
    for (let run = 1; run <= 2; run += 1) {
      later(minutes(6));
      s.model.queue(...scripted(true, [call("delegate_task", { toAgentID: "researcher", goal: `Count the pallets, run ${run}.` }, `call_run_${run}`), say("The researcher is counting.")]));
      await tickUntil(s, () => allCallsTo(s, "delegate_task", a).some((entry) => entry.callID === `call_run_${run}`));
    }
    expect(allCallsTo(s, "delegate_task", a).length, "the two fires did not both delegate; the script is out of step").toBe(2);
    s.db.run("DROP TRIGGER hold_tasks");
    s.db.run("UPDATE jobs SET run_at = ? WHERE run_at = '2999-01-01T00:00:00.000Z'", [new Date().toISOString()]);
    s.model.queue(say("There are 41 pallets."), say("There are 42 pallets."), say("Noted."), say("Noted again."));
    await tickUntil(s, () => wakeJobs(s).length >= 1 && settled(wakeJobs(s)) && s.all("SELECT id FROM jobs WHERE state = 'queued' AND payload LIKE '%delegationTaskID%'").length === 0, 12);
    owner.stop();

    const wakes = wakeJobs(s);
    expect(wakes.length, "the two fires' tasks were reported in one shared wake").toBe(2);
    expect(new Set(wakes.map((wake) => wake.payload.rootTurnID)).size, "the two wakes carry the same run").toBe(2);
    expect(wakes.map((wake) => wake.result ?? ""), "a wake was held to the other fire's count").not.toContainEqual(expect.stringMatching(/wake limit/i));
    expect(s.model.overruns).toBe(0);
  });
});
