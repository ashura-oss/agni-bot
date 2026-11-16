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

export function isOwnerJob(job: JobInfo): boolean {
  return !HOUSEKEEPING_KINDS.has(job.kind);
}

export function ownerJobs(jobs: readonly JobInfo[]): JobInfo[] {
  return jobs.filter(isOwnerJob);
}
