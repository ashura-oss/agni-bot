import { describe, expect, test } from "vitest";
import type { JobInfo } from "../src";
import { isOwnerJob, ownerJobs } from "../src";

function job(kind: string, extra: Partial<JobInfo> = {}): JobInfo {
  return { id: `job_${kind}`, kind, state: "queued", runAt: "2026-11-16T09:00:00.000Z", enabled: true, attempts: 0, ...extra };
}

describe("owner jobs", () => {
  test("daemon housekeeping is not the owner's job (S1-40)", () => {
    for (const kind of ["tagger", "memory.embed", "memory.consolidate", "summary.rollup", "rollover.summarize", "db.backup", "harness.review"]) {
      expect(isOwnerJob(job(kind, { title: "/home/me/.agni/data/backups" }))).toBe(false);
    }
  });

  test("reminders, routines and briefs are the owner's", () => {
    for (const kind of ["turn", "routine", "brief", "task.reminder", "some.future.kind"]) {
      expect(isOwnerJob(job(kind))).toBe(true);
    }
  });

  test("ownerJobs keeps order and drops housekeeping", () => {
    const list = [job("tagger"), job("turn"), job("db.backup"), job("routine")];
    expect(ownerJobs(list).map((item) => item.kind)).toEqual(["turn", "routine"]);
  });
});
