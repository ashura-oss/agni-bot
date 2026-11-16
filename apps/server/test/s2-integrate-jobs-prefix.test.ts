/** S2-INT item 8: a job id prefix is text, never a LIKE pattern. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { enqueueJob, getJobByPrefix } from "../src/stores/jobs";

let db: Database;
beforeEach(() => { db = openDatabase(":memory:"); });
afterEach(() => db.close());

describe("getJobByPrefix", () => {
  test("a full id and a unique prefix find the job", () => {
    const job = enqueueJob(db, { kind: "turn", payload: { text: "x" }, runAt: "2020-01-01T00:00:00.000Z" });
    expect(getJobByPrefix(db, job.id)?.id).toBe(job.id);
    expect(getJobByPrefix(db, job.id.slice(0, 8))?.id).toBe(job.id);
  });

  test("a % or _ in the prefix never matches, even when it is the only job", () => {
    const job = enqueueJob(db, { kind: "turn", payload: { text: "x" }, runAt: "2020-01-01T00:00:00.000Z" });
    expect(getJobByPrefix(db, "%")).toBeNull();
    expect(getJobByPrefix(db, "_")).toBeNull();
    expect(getJobByPrefix(db, "jo_")).toBeNull(); // would match "job" as a pattern
    expect(getJobByPrefix(db, `${job.id.slice(0, 4)}%`)).toBeNull();
    expect(getJobByPrefix(db, "j_b_")).toBeNull(); // as a pattern the _ would stand for the o
  });

  test("a prefix two jobs share is ambiguous, and an empty prefix finds nothing", () => {
    enqueueJob(db, { kind: "turn", payload: { text: "a" }, runAt: "2020-01-01T00:00:00.000Z" });
    enqueueJob(db, { kind: "turn", payload: { text: "b" }, runAt: "2020-01-01T00:00:00.000Z" });
    expect(getJobByPrefix(db, "job_")).toBeNull();
    expect(getJobByPrefix(db, "")).toBeNull();
  });
});
