/**
 * Sprint 1 exit-test findings, server side (int5).
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { JobRunner } from "../src/jobs/runner";
import { insertRoutine } from "../src/stores/routines";
import { claimDueJob, enqueueJob, finishJob, getJob, requeueJob, requeueStuckJobs, setJobEnabled, wakeJob } from "../src/stores/jobs";

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

describe("P2: Run now on a paused job runs it exactly once and leaves it paused", () => {
  const paused = (database: Database) => {
    // A routine job names a routine whose bot exists: the runner will not start one that does not.
    const job = enqueueJob(database, { kind: "routine", payload: { routineID: "rtn_int5" }, runAt: new Date(Date.now() + 3_600_000).toISOString() });
    const now = new Date().toISOString();
    insertRoutine(database, {
      id: "rtn_int5", jobID: job.id, agentID: "ea", name: "Check", prompt: "p", cron: "0 9 * * *", timezone: "UTC",
      misfire: "run_once", preflight: { kind: "none" }, maxTokens: 1000, maxExecutionMs: 1000, allowedDomains: [], threadID: null,
      lastStateHash: null, stateContext: null, successStreak: 0, failureStreak: 0, createdAt: now, updatedAt: now,
    });
    setJobEnabled(database, job.id, false);
    return job;
  };
  const enabledOf = (id: string): number => getJob(db!, id)!.enabled;

  test("Run now makes a paused job claimable once, and never sets enabled", () => {
    db = openDatabase(":memory:");
    const job = paused(db);
    expect(claimDueJob(db)).toBeNull();
    expect(wakeJob(db, job.id)).toBe("woken");
    expect(enabledOf(job.id)).toBe(0);
    expect(claimDueJob(db)?.id).toBe(job.id);
    expect(enabledOf(job.id)).toBe(0);
  });

  test("(a) success: a recurring paused job is back at its next slot, still paused, and not claimed again", async () => {
    db = openDatabase(":memory:");
    const job = paused(db);
    wakeJob(db, job.id);
    let runs = 0;
    const runner = new JobRunner(db, () => undefined, { maxPerTick: 5 });
    const next = new Date(Date.now() + 86_400_000).toISOString();
    runner.register("routine", async () => { runs += 1; return { result: "ran", nextRunAt: next }; });
    await runner.tick();
    await runner.tick();
    expect(runs).toBe(1);
    const after = getJob(db, job.id)!;
    expect([after.enabled, after.state, after.run_at]).toEqual([0, "queued", next]);
  });

  test("(b) the handler throws: no second run, even after the retry time", async () => {
    db = openDatabase(":memory:");
    const job = paused(db);
    wakeJob(db, job.id);
    let runs = 0;
    const runner = new JobRunner(db, () => undefined, { maxPerTick: 5, retryDelayMs: 1 });
    runner.register("routine", async () => { runs += 1; throw new Error("boom"); });
    await runner.tick();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await runner.tick();
    await runner.tick();
    expect(runs).toBe(1);
    expect(enabledOf(job.id)).toBe(0);
  });

  test("(c) a re-queue puts it back in the queue, and it still does not run again", () => {
    db = openDatabase(":memory:");
    const job = paused(db);
    wakeJob(db, job.id);
    expect(claimDueJob(db)?.id).toBe(job.id);
    requeueJob(db, job.id, new Date(Date.now() - 1_000).toISOString());
    expect(claimDueJob(db)).toBeNull();
    expect(enabledOf(job.id)).toBe(0);
  });

  test("(d) a crash between the claim and the finish: after restart it is queued but not run again", () => {
    db = openDatabase(":memory:");
    const job = paused(db);
    wakeJob(db, job.id);
    expect(claimDueJob(db)?.id).toBe(job.id);
    expect(requeueStuckJobs(db)).toBe(1);
    expect(claimDueJob(db)).toBeNull();
    expect(enabledOf(job.id)).toBe(0);
  });

  test("a disabled recurring job does not fire at its next due time after a Run now", () => {
    db = openDatabase(":memory:");
    const job = paused(db);
    wakeJob(db, job.id);
    claimDueJob(db);
    finishJob(db, job.id, "done");
    requeueJob(db, job.id, new Date(Date.now() - 1_000).toISOString());
    expect(claimDueJob(db)).toBeNull();
  });

  test("pausing a job whose Run now is waiting cancels that run", () => {
    db = openDatabase(":memory:");
    const job = paused(db);
    wakeJob(db, job.id);
    setJobEnabled(db, job.id, false);
    expect(claimDueJob(db)).toBeNull();
  });

  test("an enabled job is woken as before", () => {
    db = openDatabase(":memory:");
    const job = enqueueJob(db, { kind: "routine", runAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect(wakeJob(db, job.id)).toBe("woken");
    expect(enabledOf(job.id)).toBe(1);
    expect(claimDueJob(db)?.id).toBe(job.id);
  });
});

describe("approval label for a write into an existing scratch file", () => {
  const saved = process.env.AGNI_SCRATCH_DIR;
  afterEach(() => { if (saved === undefined) delete process.env.AGNI_SCRATCH_DIR; else process.env.AGNI_SCRATCH_DIR = saved; });

  async function labelFor(args: Record<string, unknown>): Promise<string> {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { ApprovalBroker } = await import("../src/agent/approval-broker");
    const scratch = mkdtempSync(join(tmpdir(), "agni-int5-scratch-"));
    process.env.AGNI_SCRATCH_DIR = scratch;
    writeFileSync(join(scratch, "log.txt"), "old");
    db = openDatabase(":memory:");
    const seen: Array<{ action: string }> = [];
    const broker = new ApprovalBroker({ db, emit: (frame) => seen.push(frame), waitForDecision: async () => "once" });
    await broker.request("thr_x", "trn_x", "write_file", "call_1", args, new AbortController().signal);
    return seen[0]!.action;
  }

  test("an append to an existing file says append, not write", async () => {
    expect(await labelFor({ path: "log.txt", content: "more", append: true })).toMatch(/^append to existing file: log\.txt/);
  });
  test("a replacement still says overwrite, and a new file still says write", async () => {
    expect(await labelFor({ path: "log.txt", content: "new" })).toMatch(/^overwrite existing file: /);
    expect(await labelFor({ path: "fresh.txt", content: "new", append: true })).toMatch(/^write file: /);
  });
});
