import { afterEach, describe, expect, test } from "bun:test";
import * as jobs from "../src/stores/jobs";
const { enqueueJob, getJob } = jobs;
import { startHarness, type Harness } from "./ws-harness";

/** W2-A item 4: "Run now" tells the asker the truth, and so does `job run`. */

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const FAR = "2099-01-01T00:00:00.000Z";

describe("job.set run", () => {
  test("a job that is already running answers already_running and is left alone", async () => {
    harness = await startHarness();
    const job = enqueueJob(harness.db, { kind: "test.noop", runAt: FAR });
    harness.db.run("UPDATE jobs SET state = 'running' WHERE id = ?", [job.id]);
    const client = await harness.connect();

    client.send({ type: "job.set", jobID: job.id, action: "run" });
    const error = await client.next("error");
    expect(error.code).toBe("already_running");
    expect(getJob(harness.db, job.id)).toMatchObject({ state: "running", run_at: FAR });
    await Bun.sleep(100);
    expect(client.seen().filter((frame) => frame.type === "job.list.ok")).toEqual([]);
  });

  test("a paused job is made due now, stays paused, and the asker gets the fresh list", async () => {
    harness = await startHarness();
    const job = enqueueJob(harness.db, { kind: "test.noop", runAt: FAR });
    harness.db.run("UPDATE jobs SET enabled = 0 WHERE id = ?", [job.id]);
    const client = await harness.connect();

    client.send({ type: "job.set", jobID: job.id, action: "run" });
    const list = await client.next("job.list.ok");
    expect(list.jobs.some((entry) => entry.id === job.id)).toBe(true);
    expect(getJob(harness.db, job.id)!.run_at < FAR).toBe(true);
    // Run now runs it once; it does not resume it.
    expect(getJob(harness.db, job.id)!.enabled).toBe(0);
  });
});

describe("describeWake (what `job run` prints)", () => {
  test("says what happened for each outcome", () => {
    expect(jobs.describeWake("job_1", "woken")).toEqual({ ok: true, message: "job_1 is due now — the daemon picks it up on its next poll" });
    expect(jobs.describeWake("job_1", "running")).toMatchObject({ ok: false });
    expect(jobs.describeWake("job_1", "running").message).toContain("already running");
    expect(jobs.describeWake("job_1", "not_found")).toMatchObject({ ok: false });
  });
});
