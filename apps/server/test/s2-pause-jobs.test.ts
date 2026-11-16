/**
 * S2-13: the job runner honours pause-all and per-bot off at the claim.
 * Due jobs of a paused or switched-off bot are skipped and recorded, not run
 * late on resume (tech lead decision). Housekeeping and reminders go on.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { JobRunner } from "../src/jobs/runner";
import { bindPauseStore, setAgentEnabled, setAllPaused, unbindPauseStore } from "../src/policy/pause";
import { setAuditSink } from "../src/policy/audit-sink";
import { enqueueJob, getJob } from "../src/stores/jobs";
import { createDelegationTask, getTask } from "../src/stores/tasks";
import { insertRoutine } from "../src/stores/routines";
import { nowISO } from "../src/util/ids";

let db: Database;
let ran: string[];
let runner: JobRunner;

const PAST = "2020-01-01T00:00:00.000Z";

beforeEach(() => {
  db = openDatabase(":memory:");
  setAuditSink({ record() {} });
  bindPauseStore(db);
  ran = [];
  runner = new JobRunner(db, () => undefined, { pollMs: 60_000, maxPerTick: 10, concurrency: 1 });
  for (const kind of ["turn", "routine", "tagger", "task.reminder", "brief"]) {
    runner.register(kind, async (job) => { ran.push(`${kind}:${job.id}`); return { result: "ran" }; }, {
      nextRun: kind === "turn" ? (job) => (JSON.parse(job.payload ?? "{}").everyMs ? "2099-01-01T00:00:00.000Z" : null) : undefined,
    });
  }
});

afterEach(() => {
  runner.stop();
  unbindPauseStore();
  db.close();
});

describe("pause-all", () => {
  test("a due turn job is not run, and is recorded as skipped (paused)", async () => {
    const job = enqueueJob(db, { kind: "turn", payload: { text: "hi", agentID: "ea" }, runAt: PAST });
    setAllPaused(db, true, { actor: "owner" });
    await runner.tick();
    expect(ran).toEqual([]);
    expect(getJob(db, job.id)).toMatchObject({ state: "done", result: "skipped (paused)" });
  });

  test("it is not run on resume either", async () => {
    const job = enqueueJob(db, { kind: "turn", payload: { text: "hi" }, runAt: PAST });
    setAllPaused(db, true, { actor: "owner" });
    await runner.tick();
    setAllPaused(db, false, { actor: "owner" });
    await runner.tick();
    expect(ran).toEqual([]);
    expect(getJob(db, job.id)!.state).toBe("done");
  });

  test("a recurring turn job skips this run and waits for its next slot, attempts reset", async () => {
    const job = enqueueJob(db, { kind: "turn", payload: { text: "hi", everyMs: 3_600_000 }, runAt: PAST });
    setAllPaused(db, true, { actor: "owner" });
    await runner.tick();
    expect(ran).toEqual([]);
    expect(getJob(db, job.id)).toMatchObject({ state: "queued", run_at: "2099-01-01T00:00:00.000Z", attempts: 0, result: "skipped (paused)" });
  });

  test("a Run now on a paused job is skipped too", async () => {
    const job = enqueueJob(db, { kind: "turn", payload: { text: "hi" }, runAt: PAST });
    db.run("UPDATE jobs SET enabled = 0, run_once = 1 WHERE id = ?", [job.id]);
    setAllPaused(db, true, { actor: "owner" });
    await runner.tick();
    expect(ran).toEqual([]);
    expect(getJob(db, job.id)!.result).toBe("skipped (paused)");
  });

  test("housekeeping, reminders and the brief are not bots: they still run", async () => {
    const tag = enqueueJob(db, { kind: "tagger", payload: {}, runAt: PAST });
    const reminder = enqueueJob(db, { kind: "task.reminder", payload: {}, runAt: PAST });
    const brief = enqueueJob(db, { kind: "brief", payload: {}, runAt: PAST });
    setAllPaused(db, true, { actor: "owner" });
    await runner.tick();
    expect(ran.sort()).toEqual([`brief:${brief.id}`, `tagger:${tag.id}`, `task.reminder:${reminder.id}`].sort());
  });

  test("nothing changes while not paused", async () => {
    const job = enqueueJob(db, { kind: "turn", payload: { text: "hi" }, runAt: PAST });
    await runner.tick();
    expect(ran).toEqual([`turn:${job.id}`]);
  });

  test("a skipped delegation is marked failed with the reason, so its parent is not left waiting", async () => {
    const task = createDelegationTask(db, { ownerAgentID: "researcher", brief: { goal: "look something up" } as never });
    const job = enqueueJob(db, { kind: "turn", payload: { text: "go", agentID: "researcher", delegationTaskID: task.id }, runAt: PAST });
    setAllPaused(db, true, { actor: "owner" });
    await runner.tick();
    expect(ran).toEqual([]);
    expect(getJob(db, job.id)!.result).toBe("skipped (paused)");
    expect(getTask(db, task.id)).toMatchObject({ delegate_state: "failed" });
    expect(getTask(db, task.id)!.result).toContain("paused");
  });
});

describe("per-bot off", () => {
  test("that bot's turn job is skipped; another bot's runs", async () => {
    const mine = enqueueJob(db, { kind: "turn", payload: { text: "a", agentID: "researcher" }, runAt: PAST });
    const other = enqueueJob(db, { kind: "turn", payload: { text: "b", agentID: "ea" }, runAt: PAST });
    setAgentEnabled(db, "researcher", false, { actor: "owner" });
    await runner.tick();
    expect(ran).toEqual([`turn:${other.id}`]);
    expect(getJob(db, mine.id)).toMatchObject({ state: "done", result: "skipped (bot off)" });
  });

  test("a turn job with no agent belongs to the main assistant", async () => {
    const job = enqueueJob(db, { kind: "turn", payload: { text: "a" }, runAt: PAST });
    setAgentEnabled(db, "ea", false, { actor: "owner" });
    await runner.tick();
    expect(ran).toEqual([]);
    expect(getJob(db, job.id)!.result).toBe("skipped (bot off)");
  });

  test("a routine job is matched to its routine's bot", async () => {
    const job = enqueueJob(db, { kind: "routine", payload: { routineID: "rtn_1" }, runAt: PAST });
    insertRoutine(db, {
      id: "rtn_1", jobID: job.id, agentID: "researcher", name: "Check", prompt: "p", cron: "0 9 * * *", timezone: "UTC",
      misfire: "run_once", preflight: { kind: "none" }, maxTokens: 1000, maxExecutionMs: 1000, allowedDomains: [], threadID: null,
      lastStateHash: null, stateContext: null, successStreak: 0, failureStreak: 0, createdAt: nowISO(), updatedAt: nowISO(),
    });
    setAgentEnabled(db, "researcher", false, { actor: "owner" });
    await runner.tick();
    expect(ran).toEqual([]);
    expect(getJob(db, job.id)!.result).toBe("skipped (bot off)");
  });

  test("turning the bot back on lets its later jobs run", async () => {
    setAgentEnabled(db, "researcher", false, { actor: "owner" });
    setAgentEnabled(db, "researcher", true, { actor: "owner" });
    const job = enqueueJob(db, { kind: "turn", payload: { text: "a", agentID: "researcher" }, runAt: PAST });
    await runner.tick();
    expect(ran).toEqual([`turn:${job.id}`]);
  });
});
