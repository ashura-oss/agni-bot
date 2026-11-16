/**
 * Which background jobs the owner should see. The daemon's job table also
 * holds its own housekeeping (tagging, embedding, backups, rollover
 * summaries); those run on their own schedule and are not the owner's to
 * pause, run, or read about. Unknown kinds stay visible: hiding something
 * the owner may have created is the worse mistake.
 */
import type { JobInfo } from "@agni/protocol";

const HOUSEKEEPING_KINDS: ReadonlySet<string> = new Set([
  "tagger",
  "memory.embed",
  "memory.consolidate",
  "summary.rollup",
  "rollover.summarize",
  "db.backup",
  "harness.review",
]);

/**
 * The daemon says which jobs are its own (`internal`). A server that does not
 * send the flag is older than that, so the kind list stands in for it.
 */
export function isOwnerJob(job: JobInfo): boolean {
  if (job.internal !== undefined) return !job.internal;
  return !HOUSEKEEPING_KINDS.has(job.kind);
}

const WEEK = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const DAY_NAME: Record<string, string> = { sun: "Sun", mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat" };

/** "Every day at 09:00", "Weekdays at 09:00", "Mon, Wed at 07:15"; null for jobs that do not repeat on a clock. */
export function recurrenceLabel(job: JobInfo): string | null {
  // The morning brief puts itself back for the next morning every time it runs, but its
  // payload carries no clock time, so the daemon sends no `dailyAt` for it.
  if (!job.dailyAt) return job.kind === "brief" ? "Every morning" : null;
  const days = new Set((job.days ?? []).map((day) => day.toLowerCase()));
  const has = (list: readonly string[]) => list.length === days.size && list.every((day) => days.has(day));
  if (days.size === 0 || has(WEEK)) return `Every day at ${job.dailyAt}`;
  if (has(["mon", "tue", "wed", "thu", "fri"])) return `Weekdays at ${job.dailyAt}`;
  if (has(["sat", "sun"])) return `Weekends at ${job.dailyAt}`;
  const named = WEEK.filter((day) => days.has(day)).map((day) => DAY_NAME[day]);
  return `${named.join(", ")} at ${job.dailyAt}`;
}

export function ownerJobs(jobs: readonly JobInfo[]): JobInfo[] {
  return jobs.filter(isOwnerJob);
}
