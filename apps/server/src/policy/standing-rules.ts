/**
 * Standing rules (Sprint 2, fix round G): work that starts again on its own, until the owner cancels it.
 *
 * A repeating job (`dailyAt`, `everyMinutes`) gives every fire a request of its own, so one request could turn
 * into unbounded wakes, and an injected bot could plant a job that keeps itself alive. Making one is a standing rule.
 * The owner's own chat turn, when it has read nothing outside, may make one directly. Any other origin asks the owner with
 * a card: a job-fire run, a bot's brief, a wake, a resumed task, a routine, a run that read outside text, and a run
 * whose principal or taint record cannot be read (fail closed). The card never offers "Always allow", and no stored
 * rule approves it. A refusal is a run denial on `STANDING_JOB_RESOURCE`, so a retry in the run is refused and the
 * refusal follows the run into what it schedules, delegates and wakes.
 */
import { entry } from "../agent/card-text";
import { describeSchedule, parseDay, parseWallClock } from "../jobs/schedule";
import { isTainted } from "./context";
import type { ToolResource } from "./tool-meta";
import type { RunContext, StandingKind } from "./types";

/** What a refused repeating job is recorded under: it names no file, so the refusal is of making repeating jobs at all. */
export const STANDING_JOB_RESOURCE: ToolResource = { kind: "other", value: "agni:standing-job" };

/** The refusal in words, for the lines that say what the owner said no to. */
export const STANDING_JOB_LABEL = "repeating jobs";

const isGiven = (value: unknown): boolean => value !== undefined && value !== null;

/** Does this `job_schedule` call ask for a job that runs again and again (a clock time, or a fixed interval)? */
export function isRecurringSchedule(args: Record<string, unknown>): boolean {
  return isGiven(args.dailyAt) || isGiven(args.everyMinutes);
}

const KINDS: Record<StandingKind, true> = { repeating_job: true, next_job: true, routine_create: true, routine_resume: true };

/** Every kind of standing rule the engine can give a call. A record, so a new kind cannot be added without being listed here. */
export const STANDING_KINDS: readonly StandingKind[] = Object.keys(KINDS) as StandingKind[];

/**
 * What kind of standing rule is this `job_schedule` call, or null when it is not one? A repeating job always is. A one-shot job is
 * too when it is made by a fire of a job a bot made: a chain of one-shot jobs, each telling its run to schedule the next, is a
 * repeating job by another route. The owner's own turn, a wake and a fire of a job the owner made are not the start of a chain. A
 * run that read outside text is not asked about a one-shot job at all: it is refused (a protected write), as before.
 *
 * This one answer is what the engine asks with and what the card is drawn from: nothing else decides what the owner is shown.
 */
export function standingScheduleKind(args: Record<string, unknown>, run: RunContext | undefined): StandingKind | null {
  if (isRecurringSchedule(args)) return "repeating_job";
  return run?.principal?.kind === "job" && !isTainted(run) ? "next_job" : null;
}

/**
 * What kind of standing rule is this `routine_create` call or `routine_pause` call, or null when it is not one? A new routine starts
 * work that runs on a schedule by itself, and so does resuming a paused one (`enabled: true`); pausing one does not. Like a repeating
 * job, it is the owner's own untainted turn or the owner's card. A run that read outside text is not asked: it is refused outright
 * (a protected write), as before.
 */
export function standingRoutineKind(args: Record<string, unknown>, run: RunContext | undefined, tool: "routine_create" | "routine_pause"): StandingKind | null {
  if (tool === "routine_pause" && args.enabled !== true) return null;
  if (run === undefined || isTainted(run)) return null;
  return tool === "routine_create" ? "routine_create" : "routine_resume";
}

/** The refusal a routine's creation or resumption is recorded under: the same one a repeating job has. */
export function standingRoutineResources(args: Record<string, unknown>, tool: "routine_create" | "routine_pause"): ToolResource[] {
  return tool === "routine_pause" && args.enabled !== true ? [] : [STANDING_JOB_RESOURCE];
}

const PRINCIPAL_LINE: Record<string, string> = {
  job: "This task was started by a scheduled job, not by you.",
  wake: "This task was started by a finished task reporting back, not by you.",
  peer: "This task started from another bot's message, not from you.",
  routine: "This task started from a routine's saved state, not from you.",
};

const UNREADABLE_LINE = "I cannot tell who started this task or what it read, so I am treating it as not yours.";

/**
 * Why this run may not make a repeating job without the owner's card (one sentence for the card), or null when it may:
 * the owner's own chat turn (no job behind it), with taint known and empty. A run that is missing, or whose principal or taint cannot be read, is
 * never let through.
 */
export function standingRuleOrigin(run: RunContext | undefined): string | null {
  try {
    if (!run) return UNREADABLE_LINE;
    const kind = run.principal?.kind;
    if (typeof kind !== "string") return UNREADABLE_LINE;
    if (kind !== "owner") return PRINCIPAL_LINE[kind] ?? UNREADABLE_LINE;
    // A fire of a job the owner made runs as the owner too, but it is not the owner's chat turn: nobody is there to say what it may start.
    if (run.jobID !== null) return run.jobID === undefined ? UNREADABLE_LINE : PRINCIPAL_LINE.job!;
    if (!Array.isArray(run.taint?.sources)) return UNREADABLE_LINE;
    if (isTainted(run)) return "This task read outside content, so what it asks for may not be what you meant.";
    return null;
  } catch {
    return UNREADABLE_LINE;
  }
}

/** The moment a one-shot job runs, as the server will read it (an exact UTC time); a text that is not a date is shown as written. */
export function oneShotTime(at: unknown): string {
  const when = typeof at === "string" ? new Date(at) : null;
  return when !== null && !Number.isNaN(when.getTime()) ? when.toISOString() : entry(at, 40);
}

/** The schedule of a `job_schedule` call in plain words, from the arguments as the model wrote them. Never throws. */
export function describeRecurring(args: Record<string, unknown>): string {
  if (isGiven(args.at) && !isRecurringSchedule(args)) return `once, at ${oneShotTime(args.at)}`;
  try {
    if (isGiven(args.dailyAt)) {
      const clock = parseWallClock(String(args.dailyAt));
      const at = `${String(clock.hour).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")}`;
      const days = Array.isArray(args.days) ? args.days.map((day) => parseDay(day as string | number)) : undefined;
      return describeSchedule(at, days && days.length > 0 ? days : undefined);
    }
    if (isGiven(args.everyMinutes)) {
      const minutes = Number(args.everyMinutes);
      if (Number.isFinite(minutes)) return `every ${minutes} minute${minutes === 1 ? "" : "s"}`;
    }
  } catch {
    // Fall through to the arguments as written.
  }
  const given = [args.dailyAt, args.days, args.everyMinutes].filter(isGiven).map((value) => entry(value, 80)).join(" ");
  return given ? `on the schedule "${given}"` : "on a schedule";
}
