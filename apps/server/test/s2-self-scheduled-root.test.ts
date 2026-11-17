/**
 * What a job a bot schedules keeps of the run that scheduled it (S2-09, fix rounds E and F).
 *
 * Refusals: every job a bot schedules, one-shot or recurring, keeps the refusal scope of the run that scheduled it. What the
 * owner refused in a chat holds in a routine made from it for good, and in what the routine delegates, wakes and schedules.
 *
 * Wakes: only the owner's own turn starts a request. A one-shot job scheduled by any other run is part of that run's request
 * (its wakes are counted together), so a chain of jobs cannot get a fresh wake allowance at each link. A recurring job is a
 * request on each run, counted by its own wakes. Every job has a clock of its own.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, setSystemTime } from "bun:test";
import { resetS2Startup } from "../src/startup/s2";
import { setRunCaps } from "../src/stores/policy-settings";
import { scenarioTest, useScenarios, say, type ModelStep, type Scenario, type ScenarioClient } from "./scenarios/harness";
import { answerCards, allCallsTo, call, later, minutes, playTurn, resultJson, scripted, type CallRecord, type TurnReport } from "./invariants/support";

const scenarios = useScenarios();
afterEach(() => { setSystemTime(); resetS2Startup(); });

const shell = (path: string): string => path.replaceAll("\\", "/");

function setUp(s: Scenario): string {
  mkdirSync(s.scratch, { recursive: true });
  const target = join(s.scratch, "ledger.txt");
  writeFileSync(target, "original ledger");
  return target;
}

interface JobPayload { rootTurnID?: string; rootJob?: string | null; scheduledBy?: string; clockKey?: string; denialRoot?: string }

describe("a job scheduled from a wake", () => {
  scenarioTest("is counted and refused in the request it came from, and still has a clock of its own", async () => {
    const s = await scenarios.start();
    setRunCaps(s.db, { maxWakesPerRequest: 1 });
    const target = setUp(s);
    const a = await s.connect({ label: "A" });

    // The owner refuses a delete in the request, and the request delegates.
    s.model.queue(...scripted(true, [
      call("bash", { command: `rm ${shell(target)}` }, "call_rm"),
      call("delegate_task", { toAgentID: "researcher", goal: "Count the pallets in the east warehouse." }, "call_delegate"),
      say("The researcher is counting."),
    ]));
    const request = await playTurn(s, a, "clean up the old ledger", { answer: (card) => (card.action.includes("rm ") ? "reject" : "once") });

    // The child answers. Its wake (the request's one) schedules a job; the job tries the delete again, and delegates again.
    const owner = answerCards(a, (card) => (card.action.includes("rm ") ? "reject" : "once"));
    s.model.queue(
      say("There are 42 pallets."),
      ...scripted(true, [call("job_schedule", { text: "Count the pallets again and report.", at: new Date(Date.now() - 1_000).toISOString() }, "call_schedule"), say("A recount is scheduled.")]),
      ...scripted(true, [
        call("bash", { command: `rm ${shell(target)}` }, "call_job_rm"),
        call("delegate_task", { toAgentID: "researcher", goal: "Count the pallets in the west warehouse." }, "call_job_delegate"),
        say("The recount is under way."),
      ]),
      say("There are 17 pallets."),
    );
    const scheduled = (): boolean => allCallsTo(s, "job_schedule", a).length > 0;
    for (let tick = 0; tick < 8 && !scheduled(); tick += 1) await s.runner().tick();
    expect(allCallsTo(s, "job_schedule", a)[0]?.ok, "the wake could not schedule the job; the script is out of step").toBe(true);

    const rows = s.all<{ id: string; payload: string }>("SELECT id, payload FROM jobs WHERE kind = 'turn' ORDER BY rowid").map((row) => ({ id: row.id, payload: JSON.parse(row.payload) as JobPayload }));
    const job = rows.find((row) => row.payload.scheduledBy === "bot");
    expect(job, "no job was scheduled").toBeDefined();
    expect(job!.payload.rootTurnID, "the new job did not keep the request it was scheduled in").toBe(request.turnID);
    expect(job!.payload.clockKey, "the new job was put on the wake's clock instead of its own").toBeUndefined();

    // Let the new job run, its task finish, and the wake that would report it come due.
    const wakeCount = (): number => s.all("SELECT id FROM jobs WHERE kind = 'turn' AND payload LIKE '%wakeKey%'").length;
    for (let tick = 0; tick < 10 && wakeCount() < 2; tick += 1) await s.runner().tick();
    await s.runner().tick();
    owner.stop();

    // The earlier refusal still holds in the new job.
    const retried = allCallsTo(s, "bash", a).find((entry) => entry.callID === "call_job_rm");
    expect(retried, "the new job never tried the delete; the script is out of step").toBeDefined();
    expect(retried!.card, "the new job asked the owner again about a delete its request was refused").toBeNull();
    expect(String(resultJson(retried).error ?? "(no error)"), "the new job was stopped by something other than the refusal").toMatch(/refus|said no|not allowed|denied/i);
    expect(readFileSync(target, "utf8")).toBe("original ledger");

    // Its own wake is the request's second, over the limit of one: not run.
    expect(s.model.overruns, "a second wake of the request ran a model turn").toBe(0);
    const wakes = s.all<{ result: string | null }>("SELECT result FROM jobs WHERE kind = 'turn' AND payload LIKE '%wakeKey%' ORDER BY rowid");
    expect(wakes.length, "the new job's task did not queue a wake; the script is out of step").toBe(2);
    expect(wakes[1]!.result ?? "", "the new job's wake was not held to the request's limit").toMatch(/wake limit/i);

    // And it ran on a clock of its own.
    const clock = s.get<{ run_clock_key: string | null }>("SELECT run_clock_key FROM jobs WHERE id = ?", job!.id)?.run_clock_key;
    expect(clock, "the new job has no clock of its own").toMatch(new RegExp(`^${job!.id}@`));
  });
});

describe("a job scheduled from the owner's own turn", () => {
  scenarioTest("is its own request for wakes: a daily routine's wakes are not counted against the chat turn that made it", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    s.model.queue(...scripted(true, [call("job_schedule", { text: "Check the warehouse.", dailyAt: "09:05" }, "call_schedule"), say("Scheduled.")]));
    const report = await playTurn(s, a, "check the warehouse every morning", { answer: () => "once" });
    expect(report.calls.find((entry) => entry.callID === "call_schedule")?.ok, "the owner's turn could not schedule the job; the script is out of step").toBe(true);
    const payload = s.all<{ payload: string }>("SELECT payload FROM jobs WHERE kind = 'turn'").map((row) => JSON.parse(row.payload) as JobPayload).find((entry) => entry.scheduledBy === "bot");
    expect(payload, "no job was scheduled").toBeDefined();
    expect(payload!.rootTurnID, "the job was tied to the chat turn that scheduled it").toBeUndefined();
    expect(payload!.rootJob, "the job was tied to a root job").toBeUndefined();
    expect(payload!.denialRoot, "the job does not remember whose refusals it is under").toBe(report.turnID);
  });
});

/** The owner lets the bot overwrite the ledger "always" (a stored rule), then refuses to delete it; the bot schedules a job from that turn. */
async function refusedThenScheduled(s: Scenario, a: ScenarioClient, target: string, schedule: ModelStep[]): Promise<TurnReport> {
  s.model.queue(...scripted(true, [call("write_file", { path: target, content: "original ledger" }, "call_rule"), say("Saved.")]));
  const first = await playTurn(s, a, "save the ledger", { answer: () => "always" });
  expect(first.cards[0]?.buttons, "the baseline cannot store a rule").toContain("always");
  s.model.queue(...scripted(true, [call("write_file", { path: target, content: "original ledger" }, "call_rule_again"), say("Saved.")]));
  const second = await playTurn(s, a, "save the ledger again");
  expect(second.cards.length, "the baseline rule did not cover the same write in a clean run").toBe(0);

  s.model.queue(...scripted(true, [call("bash", { command: `rm ${shell(target)}` }, "call_rm"), ...schedule]));
  const request = await playTurn(s, a, "clean up the old ledger", { answer: (card) => (card.action.includes("rm ") ? "reject" : "once") });
  expect(request.calls.find((entry) => entry.callID === "call_schedule")?.ok, "the owner's turn could not schedule the job; the script is out of step").toBe(true);
  return request;
}

function expectRefused(record: CallRecord | undefined, what: string): void {
  expect(record, `${what} never tried the write; the script is out of step`).toBeDefined();
  expect(record!.card, `${what} was let through (by a card or a stored rule) to a file its request was refused`).toBeNull();
  expect(String(resultJson(record).error ?? "(no error)"), `${what} was stopped by something other than the refusal`).toMatch(/refus|said no|not allowed|denied/i);
}

const past = (): string => new Date(Date.now() - 1_000).toISOString();

describe("a refusal in the owner's turn holds in a job the bot schedules from it", () => {
  scenarioTest("the owner refused a delete; the job may not write the file, and no stored rule lets it", async () => {
    const s = await scenarios.start();
    const target = setUp(s);
    const a = await s.connect({ label: "A" });
    await refusedThenScheduled(s, a, target, [call("job_schedule", { at: past(), text: "Empty the old ledger file." }, "call_schedule"), say("Scheduled.")]);

    const owner = answerCards(a, "once");
    s.model.queue(...scripted(true, [call("write_file", { path: target, content: "emptied by the job" }, "call_job_write"), say("Tried.")]));
    const tried = (): boolean => allCallsTo(s, "write_file", a).some((entry) => entry.callID === "call_job_write");
    for (let tick = 0; tick < 4 && !tried(); tick += 1) await s.runner().tick();
    owner.stop();

    expectRefused(allCallsTo(s, "write_file", a).find((entry) => entry.callID === "call_job_write"), "the job");
    expect(owner.cards, "the job raised a card").toEqual([]);
    expect(readFileSync(target, "utf8")).toBe("original ledger");
  });

  scenarioTest("a chain of jobs keeps it: the job's own job may not write the file either", async () => {
    const s = await scenarios.start();
    const target = setUp(s);
    const a = await s.connect({ label: "A" });
    await refusedThenScheduled(s, a, target, [call("job_schedule", { at: past(), text: "Start the cleanup." }, "call_schedule"), say("Scheduled.")]);

    const owner = answerCards(a, "once");
    s.model.queue(
      ...scripted(true, [call("job_schedule", { at: past(), text: "Empty the old ledger file." }, "call_chain"), say("Handed on.")]),
      ...scripted(true, [call("write_file", { path: target, content: "emptied by the second job" }, "call_job2_write"), say("Tried.")]),
    );
    const tried = (): boolean => allCallsTo(s, "write_file", a).some((entry) => entry.callID === "call_job2_write");
    for (let tick = 0; tick < 6 && !tried(); tick += 1) await s.runner().tick();
    owner.stop();

    expect(allCallsTo(s, "job_schedule", a).find((entry) => entry.callID === "call_chain")?.ok, "the first job could not schedule the second; the script is out of step").toBe(true);
    expectRefused(allCallsTo(s, "write_file", a).find((entry) => entry.callID === "call_job2_write"), "the second job");
    // The first job's own scheduling of the second is the one card: a job a bot made may not make the next one unasked. The file write raised none.
    expect(owner.cards.map((card) => card.action), "a job raised a card other than for the job it scheduled").toEqual([expect.stringContaining("job_schedule")]);
    expect(readFileSync(target, "utf8")).toBe("original ledger");
  });
});

describe("a refusal holds in what a scheduled job hands work to", () => {
  scenarioTest("a task the job delegates, and the wake that reports it, may not write the file", async () => {
    const s = await scenarios.start();
    const target = setUp(s);
    const a = await s.connect({ label: "A" });
    await refusedThenScheduled(s, a, target, [call("job_schedule", { at: past(), text: "Have the coder empty the old ledger file." }, "call_schedule"), say("Scheduled.")]);

    const owner = answerCards(a, "once");
    s.model.queue(
      ...scripted(true, [call("delegate_task", { toAgentID: "coder", goal: "Empty the old ledger file." }, "call_delegate"), say("The coder is on it.")]),
      call("write_file", { path: target, content: "emptied by the coder" }, "call_coder_write"),
      say("The owner would not let me."),
      ...scripted(true, [call("write_file", { path: target, content: "emptied by the wake" }, "call_wake_write"), say("Tried."), say("Noted.")]),
    );
    const tried = (): boolean => allCallsTo(s, "write_file", a).some((entry) => entry.callID === "call_wake_write");
    for (let tick = 0; tick < 8 && !tried(); tick += 1) await s.runner().tick();
    await s.runner().tick();
    owner.stop();

    expectRefused(allCallsTo(s, "write_file", a).find((entry) => entry.callID === "call_coder_write"), "the task the job delegated");
    expectRefused(allCallsTo(s, "write_file", a).find((entry) => entry.callID === "call_wake_write"), "the wake");
    expect(owner.cards, "something under the job raised a card").toEqual([]);
    expect(readFileSync(target, "utf8")).toBe("original ledger");
  });

  scenarioTest("a bot the job hands the work to may not write the file", async () => {
    const s = await scenarios.start();
    const target = setUp(s);
    const a = await s.connect({ label: "A" });
    await refusedThenScheduled(s, a, target, [call("job_schedule", { at: past(), text: "Have the coder empty the old ledger file." }, "call_schedule"), say("Scheduled.")]);

    const owner = answerCards(a, "once");
    s.model.queue(...scripted(true, [
      call("handoff", { toAgentID: "coder", task: "Empty the old ledger file." }, "call_handoff"),
      call("write_file", { path: target, content: "emptied by the coder" }, "call_coder_write"),
      say("Tried."),
      say("The coder could not do it."),
    ]));
    const tried = (): boolean => allCallsTo(s, "write_file", a).some((entry) => entry.callID === "call_coder_write");
    for (let tick = 0; tick < 4 && !tried(); tick += 1) await s.runner().tick();
    owner.stop();

    expectRefused(allCallsTo(s, "write_file", a).find((entry) => entry.callID === "call_coder_write"), "the coder");
    expect(owner.cards, "the coder raised a card").toEqual([]);
    expect(readFileSync(target, "utf8")).toBe("original ledger");
  });
});

interface WakeJob { id: string; state: string; result: string | null }
const wakeJobs = (s: Scenario): WakeJob[] => s.all<WakeJob>("SELECT id, state, result FROM jobs WHERE kind = 'turn' AND payload LIKE '%wakeKey%' ORDER BY rowid");
const settled = (jobs: WakeJob[]): boolean => jobs.every((job) => job.state === "done" || job.state === "failed");

describe("a one-shot job scheduled by a job", () => {
  scenarioTest("is part of its request: the chain's wakes are counted together", async () => {
    const s = await scenarios.start();
    setRunCaps(s.db, { maxWakesPerRequest: 1 });
    const a = await s.connect({ label: "A" });
    s.model.queue(...scripted(true, [call("job_schedule", { at: past(), text: "Start the count." }, "call_schedule"), say("Scheduled.")]));
    const request = await playTurn(s, a, "count the pallets", { answer: () => "once" });
    expect(request.calls.find((entry) => entry.callID === "call_schedule")?.ok, "the owner's turn could not schedule the job; the script is out of step").toBe(true);

    // The first job schedules a second one and delegates; the second delegates too. Each task's result wakes the job that delegated it.
    const owner = answerCards(a, "once");
    s.model.queue(
      ...scripted(true, [
        call("job_schedule", { at: past(), text: "Count the west warehouse." }, "call_chain"),
        call("delegate_task", { toAgentID: "researcher", goal: "Count the pallets in the east warehouse." }, "call_delegate_1"),
        say("The researcher is counting."),
      ]),
      ...scripted(true, [call("delegate_task", { toAgentID: "researcher", goal: "Count the pallets in the west warehouse." }, "call_delegate_2"), say("The researcher is counting again.")]),
      say("There are 42 pallets."),
      say("There are 17 pallets."),
      say("Noted."),
    );
    for (let tick = 0; tick < 12 && !(wakeJobs(s).length === 2 && settled(wakeJobs(s))); tick += 1) await s.runner().tick();
    owner.stop();

    expect(allCallsTo(s, "job_schedule", a).find((entry) => entry.callID === "call_chain")?.ok, "the first job could not schedule the second; the script is out of step").toBe(true);
    const wakes = wakeJobs(s);
    expect(wakes.length, "the two jobs' tasks did not each queue a wake; the script is out of step").toBe(2);
    expect(s.model.overruns, "the chain's second wake ran a model turn").toBe(0);
    expect(wakes[1]!.result ?? "", "the second job's wake was not held to the chain's wake limit").toMatch(/wake limit/i);
  });
});

describe("a recurring job scheduled from a wake", () => {
  scenarioTest("counts its wakes run by run: the limit is not used up for good by the first", async () => {
    const s = await scenarios.start();
    setRunCaps(s.db, { maxWakesPerRequest: 1 });
    const a = await s.connect({ label: "A" });
    s.model.queue(call("delegate_task", { toAgentID: "researcher", goal: "Count the pallets in the east warehouse." }, "call_delegate"), say("On it."));
    await playTurn(s, a, "count the pallets");

    // The child answers; the request's one wake schedules a recount every five minutes.
    const owner = answerCards(a, "once");
    s.model.queue(
      say("There are 42 pallets."),
      ...scripted(true, [call("job_schedule", { text: "Count the pallets again and report.", everyMinutes: 5 }, "call_schedule"), say("A recount is scheduled.")]),
    );
    const scheduled = (): boolean => allCallsTo(s, "job_schedule", a).length > 0;
    for (let tick = 0; tick < 6 && !scheduled(); tick += 1) await s.runner().tick();
    expect(allCallsTo(s, "job_schedule", a)[0]?.ok, "the wake could not schedule the recount; the script is out of step").toBe(true);

    // Each run delegates, and its wake is the run's own first, within the limit of one.
    for (let run = 1; run <= 2; run += 1) {
      later(minutes(6));
      s.model.queue(
        ...scripted(true, [call("delegate_task", { toAgentID: "researcher", goal: `Count the pallets, run ${run}.` }, `call_run_${run}`), say("The researcher is counting.")]),
        say(`There are ${40 + run} pallets.`),
        say("Noted."),
      );
      for (let tick = 0; tick < 8 && !(wakeJobs(s).length === run + 1 && settled(wakeJobs(s))); tick += 1) await s.runner().tick();
      expect(wakeJobs(s).length, `run ${run} did not queue its wake; the script is out of step`).toBe(run + 1);
      expect(wakeJobs(s)[run]!.result ?? "", `run ${run}'s wake was held to a wake count shared with the other runs`).not.toMatch(/wake limit/i);
    }
    owner.stop();
    expect(s.model.overruns, "a wake of a recurring run was not run").toBe(0);
  });
});
