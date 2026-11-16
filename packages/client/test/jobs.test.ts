import { describe, expect, test } from "vitest";
import type { JobInfo } from "../src";
import { isOwnerJob, ownerJobs, recurrenceLabel } from "../src";

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

describe("the daemon's own flag", () => {
  test("internal decides, and beats the kind guess (W2-C)", () => {
    expect(isOwnerJob(job("turn", { internal: true }))).toBe(false);
    expect(isOwnerJob(job("tagger", { internal: false }))).toBe(true);
    // A server that does not send the flag falls back to the kind list.
    expect(isOwnerJob(job("tagger"))).toBe(false);
    expect(isOwnerJob(job("turn"))).toBe(true);
  });
});

describe("recurrenceLabel", () => {
  test("says a clock recurrence in words", () => {
    expect(recurrenceLabel(job("turn", { dailyAt: "09:00" }))).toBe("Every day at 09:00");
    expect(recurrenceLabel(job("turn", { dailyAt: "09:00", days: ["mon", "tue", "wed", "thu", "fri"] }))).toBe("Weekdays at 09:00");
    expect(recurrenceLabel(job("turn", { dailyAt: "18:30", days: ["sat", "sun"] }))).toBe("Weekends at 18:30");
    expect(recurrenceLabel(job("turn", { dailyAt: "07:15", days: ["wed", "mon"] }))).toBe("Mon, Wed at 07:15");
    expect(recurrenceLabel(job("turn", { dailyAt: "09:00", days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] }))).toBe("Every day at 09:00");
  });

  test("the morning brief repeats even though the daemon sends no clock time for it", () => {
    expect(recurrenceLabel(job("brief"))).toBe("Every morning");
  });

  test("is null for an interval job and for a one-off", () => {
    expect(recurrenceLabel(job("turn", { everyMs: 3_600_000 }))).toBeNull();
    expect(recurrenceLabel(job("turn"))).toBeNull();
  });
});
