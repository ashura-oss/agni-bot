/**
 * A job a bot schedules from inside a request stays in that request (S2-09, fix round E).
 *
 * A wake, a delegated child and a resumed task run under the root of the request they came from: the owner's earlier
 * refusals hold there, and the request's wakes are counted together. A bot in such a run could call `job_schedule`, and the
 * new job was its own root: it had no refusals, a wake count of zero, and so a way round the limit. The job now keeps the
 * root of the run that scheduled it. It is still a job: it has a clock of its own.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, setSystemTime } from "bun:test";
import { resetS2Startup } from "../src/startup/s2";
import { setRunCaps } from "../src/stores/policy-settings";
import { scenarioTest, useScenarios, say, type Scenario } from "./scenarios/harness";
import { answerCards, allCallsTo, call, playTurn, resultJson, scripted } from "./invariants/support";

const scenarios = useScenarios();
afterEach(() => { setSystemTime(); resetS2Startup(); });

const shell = (path: string): string => path.replaceAll("\\", "/");

function setUp(s: Scenario): string {
  mkdirSync(s.scratch, { recursive: true });
  const target = join(s.scratch, "ledger.txt");
  writeFileSync(target, "original ledger");
  return target;
}

interface JobPayload { rootTurnID?: string; rootJob?: string | null; scheduledBy?: string; clockKey?: string }

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
  scenarioTest("is its own request: a daily routine's wakes are not counted against the chat turn that made it", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    s.model.queue(...scripted(true, [call("job_schedule", { text: "Check the warehouse.", dailyAt: "09:05" }, "call_schedule"), say("Scheduled.")]));
    const report = await playTurn(s, a, "check the warehouse every morning", { answer: () => "once" });
    expect(report.calls.find((entry) => entry.callID === "call_schedule")?.ok, "the owner's turn could not schedule the job; the script is out of step").toBe(true);
    const payload = s.all<{ payload: string }>("SELECT payload FROM jobs WHERE kind = 'turn'").map((row) => JSON.parse(row.payload) as JobPayload).find((entry) => entry.scheduledBy === "bot");
    expect(payload, "no job was scheduled").toBeDefined();
    expect(payload!.rootTurnID, "the job was tied to the chat turn that scheduled it").toBeUndefined();
  });
});

