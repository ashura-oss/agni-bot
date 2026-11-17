/**
 * A request's wakes are counted (S2-09, fix round D). A delegated task that finishes wakes the bot that delegated it,
 * which may delegate again, so the chain delegate, wake, delegate has no end in time (each wake has a clock of its own).
 * It is bounded by count: at most 10 wakes (the owner's number) per request, the one the owner's refusals hold in. The
 * next wake is not run as a model turn; its results are posted to the parent's conversation as a plain notice.
 */
import { afterEach, describe, expect, setSystemTime } from "bun:test";
import { resetS2Startup } from "../src/startup/s2";
import { WAKE_COUNT_SQL } from "../src/jobs/wake-limit";
import { enqueueJob } from "../src/stores/jobs";
import { createThread } from "../src/stores/threads";
import { getRunCaps, setRunCaps } from "../src/stores/policy-settings";
import { scenarioTest, gate, say, useScenarios, type Scenario } from "./scenarios/harness";
import { call, later, minutes } from "./invariants/support";

const scenarios = useScenarios();
// A scenario boots the startup hooks, which wire the router gate and the budget to its database: unwire them with it.
afterEach(() => { setSystemTime(); resetS2Startup(); });

/** A wake job for the request `root`: what a finished delegated task queues for the bot that delegated it. */
function queueWake(s: Scenario, threadID: string, root: string, n: number): string {
  return enqueueJob(s.db, {
    kind: "turn",
    payload: {
      agentID: "ea",
      threadID,
      channelID: "main",
      notify: false,
      inputRole: "system",
      wakeKey: `wake:${threadID}:${root}:${n}`,
      depth: 1,
      rootTurnID: root,
      rootJob: null,
      results: [{ taskID: `tsk_${root}_${n}`, agentID: "researcher", summary: `Result number ${n}.`, redacted: false }],
    },
  }).id;
}

const stateOf = (s: Scenario, id: string): string | undefined => s.get<{ state: string }>("SELECT state FROM jobs WHERE id = ?", id)?.state;
const notices = (s: Scenario): string[] => s.all<{ text: string }>("SELECT text FROM channel_messages WHERE channel_id = 'main' AND from_type = 'system' ORDER BY created_at, rowid").map((row) => row.text);

describe("the wake limit", () => {
  scenarioTest("the default is 10, and it is a run cap the owner can read and set", async () => {
    const s = await scenarios.start();
    expect(getRunCaps(s.db).maxWakesPerRequest).toBe(10);
    setRunCaps(s.db, { maxWakesPerRequest: 3 });
    expect(getRunCaps(s.db).maxWakesPerRequest).toBe(3);
    expect(() => setRunCaps(s.db, { maxWakesPerRequest: 0 })).toThrow();
    expect(() => setRunCaps(s.db, { maxWakesPerRequest: 2.5 })).toThrow();
  });

  scenarioTest("the 11th wake of one request is not run as a model turn; its results become a plain notice", async () => {
    const s = await scenarios.start();
    const threadID = createThread(s.db, "ea").id;
    for (let n = 1; n <= 10; n += 1) {
      s.model.queue(say(`Told the owner about result ${n}.`));
      const id = queueWake(s, threadID, "trn_root_a", n);
      await s.runner().tick();
      expect(stateOf(s, id), `wake ${n} did not run; the script is out of step`).toBe("done");
    }
    expect(s.model.requests.length, "the ten wakes did not each run one model turn").toBe(10);
    expect(notices(s).filter((text) => /wake limit/i.test(text)), "a notice came before the limit").toEqual([]);

    s.model.queue(say("This must not be asked for."));
    const eleventh = queueWake(s, threadID, "trn_root_a", 11);
    await s.runner().tick();
    expect(s.model.requests.length, "the 11th wake ran a model turn").toBe(10);
    expect(stateOf(s, eleventh), "the 11th wake was left to retry").toBe("done");
    const posted = notices(s).filter((text) => /wake limit/i.test(text));
    expect(posted.length, "the owner was not told that the request reached its wake limit").toBe(1);
    expect(posted[0], "the notice does not name the task whose result came back").toContain("tsk_trn_root_a_11");
    expect(posted[0], "the notice carries the task's own words, which are text to read, not a note to post").not.toContain("Result number 11.");
    const inThread = s.all<{ text: string }>("SELECT text FROM messages WHERE thread_id = ? AND role = 'system'", threadID).map((row) => row.text);
    expect(inThread.some((text) => /wake limit/i.test(text)), "the parent thread was not told").toBe(true);
  });

  scenarioTest("another request is counted on its own", async () => {
    const s = await scenarios.start();
    setRunCaps(s.db, { maxWakesPerRequest: 2 });
    const threadID = createThread(s.db, "ea").id;
    for (let n = 1; n <= 2; n += 1) {
      s.model.queue(say("Noted."));
      queueWake(s, threadID, "trn_root_a", n);
      await s.runner().tick();
    }
    s.model.queue(say("Noted."));
    const otherRequest = queueWake(s, threadID, "trn_root_b", 1);
    await s.runner().tick();
    expect(stateOf(s, otherRequest)).toBe("done");
    expect(s.model.requests.length, "a second request was held to the first one's count").toBe(3);
    s.model.queue(say("Must not run."));
    queueWake(s, threadID, "trn_root_a", 3);
    await s.runner().tick();
    expect(s.model.requests.length, "the first request's third wake ran").toBe(3);
  });

  scenarioTest("a wake that is tried again still runs, and the request's count is the wakes, not the tries", async () => {
    const s = await scenarios.start({ turnTimeoutMs: 150 });
    setRunCaps(s.db, { maxWakesPerRequest: 2 });
    const threadID = createThread(s.db, "ea").id;
    s.model.queue({ text: "Looking.", hold: gate() });
    const first = queueWake(s, threadID, "trn_root_a", 1);
    await s.runner().tick();
    expect(stateOf(s, first), "the first try did not fail into a retry; the script is out of step").toBe("queued");

    s.model.queue(say("Noted."));
    const second = queueWake(s, threadID, "trn_root_a", 2);
    await s.runner().tick();
    expect(stateOf(s, second), "the second wake of two was refused").toBe("done");

    later(minutes(15));
    s.model.queue(say("Told the owner."));
    await s.runner().tick();
    expect(stateOf(s, first), "the retry of a wake that was already counted was refused").toBe("done");

    const before = s.model.requests.length;
    s.model.queue(say("Must not run."));
    queueWake(s, threadID, "trn_root_a", 3);
    await s.runner().tick();
    expect(s.model.requests.length - before, "a third wake ran under a limit of two").toBe(0);
  });

  scenarioTest("a daily routine that delegates is held to the limit per run, not for ever: day 11's wake runs", async () => {
    const s = await scenarios.start();
    const DAY = minutes(24 * 60);
    const routine = enqueueJob(s.db, { kind: "turn", payload: { text: "check the warehouse", agentID: "ea", notify: false, everyMs: DAY } }).id;
    for (let day = 1; day <= 11; day += 1) {
      s.model.queue(
        call("delegate_task", { toAgentID: "researcher", goal: `Count the pallets for day ${day}.` }, `call_d${day}`),
        say("On it."),
        say(`Counted for day ${day}.`),
        say(`Told the owner about day ${day}.`),
      );
      const before = s.model.requests.length;
      for (let tick = 0; tick < 6 && s.model.requests.length - before < 4; tick += 1) await s.runner().tick();
      expect(s.model.requests.length - before, `day ${day}: the routine, its task and its wake did not each run a model turn`).toBe(4);
      const wakes = s.all<{ state: string; result: string | null }>("SELECT state, result FROM jobs WHERE kind = 'turn' AND payload LIKE '%wakeKey%' ORDER BY rowid");
      expect(wakes.length, `day ${day}: the wake was not queued`).toBe(day);
      expect(wakes[day - 1]!.state, `day ${day}: the wake was not completed (${wakes[day - 1]!.result})`).toBe("done");
      expect(wakes[day - 1]!.result ?? "", `day ${day}: the wake was refused by the limit`).not.toMatch(/wake limit/i);
      later(DAY);
    }
    expect(stateOf(s, routine), "the routine is still scheduled").toBe("queued");
  });

  scenarioTest("counting a request's wakes reads an index, not every turn job", async () => {
    const s = await scenarios.start();
    const plan = s.db.query<{ detail: string }, [string, string]>(`EXPLAIN QUERY PLAN ${WAKE_COUNT_SQL}`).all("trn_root_a", "job_none").map((row) => row.detail);
    expect(plan.some((detail) => /USING (COVERING )?INDEX idx_jobs_wake_scope/.test(detail)), `the count does not use idx_jobs_wake_scope: ${plan.join(" | ")}`).toBe(true);
    expect(plan.some((detail) => /^SCAN jobs/.test(detail)), `the count scans every job: ${plan.join(" | ")}`).toBe(false);
  });
});
