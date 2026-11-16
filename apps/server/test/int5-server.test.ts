/**
 * Sprint 1 exit-test findings, server side (int5).
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { JobRunner } from "../src/jobs/runner";
import { claimDueJob, enqueueJob, getJob, setJobEnabled, wakeJob } from "../src/stores/jobs";

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

describe("P2: Run now on a paused job runs it once and leaves it paused", () => {
  test("a paused job is claimed once after Run now, and enabled stays 0", () => {
    db = openDatabase(":memory:");
    const job = enqueueJob(db, { kind: "routine", payload: {}, runAt: new Date(Date.now() + 3_600_000).toISOString() });
    setJobEnabled(db, job.id, false);
    expect(claimDueJob(db)).toBeNull();

    expect(wakeJob(db, job.id)).toBe("woken");
    expect(getJob(db, job.id)!.enabled).toBe(0);
    const claimed = claimDueJob(db);
    expect(claimed?.id).toBe(job.id);
  });

  test("after the manual run a recurring paused job is back at its next slot, still paused, and not claimed again", async () => {
    db = openDatabase(":memory:");
    const job = enqueueJob(db, { kind: "routine", payload: {}, runAt: new Date(Date.now() + 3_600_000).toISOString() });
    setJobEnabled(db, job.id, false);
    wakeJob(db, job.id);
    let runs = 0;
    const runner = new JobRunner(db, () => undefined, { maxPerTick: 5 });
    const next = new Date(Date.now() + 86_400_000).toISOString();
    runner.register("routine", async () => { runs += 1; return { result: "ran", nextRunAt: next }; });
    await runner.tick();
    await runner.tick();

    expect(runs).toBe(1);
    const after = getJob(db, job.id)!;
    expect(after.enabled).toBe(0);
    expect(after.state).toBe("queued");
    expect(after.run_at).toBe(next);
  });

  test("an enabled job is woken as before", () => {
    db = openDatabase(":memory:");
    const job = enqueueJob(db, { kind: "routine", runAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect(wakeJob(db, job.id)).toBe("woken");
    expect(getJob(db, job.id)!.enabled).toBe(1);
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
