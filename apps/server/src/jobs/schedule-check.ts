/**
 * What a `job_schedule` call may ask for, checked in one place (as `checkRoutine` is for a routine).
 *
 * Three places need the same answer: the engine before it raises a card (`scheduleProblem`, the tool's `validate`), the card itself
 * (`jobPreview`), and the tool that makes the job (`scheduleJob`). Each used to carry its own copy of these rules, and the copies
 * drifted: a job with no time at all was told it was "not a date" on the card and "say when" in the tool. The words are for the model.
 */
import { canonicalAgentID } from "../agent/personas";
import { CLOSURE_WORDING_REFUSAL, closureWording } from "../agent/closure";
import { parseDay, parseWallClock } from "./schedule";
import { entry } from "../agent/card-text";

/** What a bot is told when a job it asks for could never be made. */
export const SELF_ONLY = "an agent may only schedule jobs for itself";
export const NOTHING_TO_DO = "a scheduled job needs something to do";
export const notADate = (at: unknown): string => `"${String(at)}" is not a date`;

export const MIN_EVERY_MINUTES = 5;
export const MAX_EVERY_MINUTES = 10_080;

/**
 * How far behind now a one-shot job's time may be and still mean "now": a model's clock is as old as its turn, and a chain link is set
 * to run at once.
 */
export const PAST_GRACE_MS = 60_000;

/** Why this interval can never be a schedule, or null. */
export function everyMinutesProblem(minutes: number): string | null {
  return Number.isFinite(minutes) && minutes >= MIN_EVERY_MINUTES && minutes <= MAX_EVERY_MINUTES
    ? null
    : `everyMinutes must be between ${MIN_EVERY_MINUTES} and ${MAX_EVERY_MINUTES} (a week)`;
}

const given = (value: unknown): boolean => value !== undefined && value !== null;

/** The time a one-shot job is asked to run at, as a number: NaN when it is not a date. */
function oneShotMs(at: unknown): number {
  return typeof at === "string" && at.trim() ? new Date(at).getTime() : Number.NaN;
}

/**
 * Why these `job_schedule` arguments (as the model wrote them, `agent_id` and all) can never be made into a job by `bot`, or null.
 * It names the first problem and is the same for every caller. The bot's cap on jobs it keeps is not here: it depends on the database.
 *
 * `now` is the time to hold a one-shot job's time to: when it is given, a time already past (beyond the grace) is a problem too. The
 * owner's own turn does not give it (a time just past runs at once, as it always has); the card and the owner's yes do, because the
 * owner approves a time, and approving a time that has gone by would run the job at once.
 */
export function checkSchedule(args: Record<string, unknown>, bot: string | undefined, now?: number): string | null {
  const choices = [args.at, args.dailyAt, args.everyMinutes].filter(given).length;
  if (choices === 0) return "say when it should run: `at` (one-off), `dailyAt` (a clock time), or `everyMinutes`";
  if (choices > 1) return "pick one: `at`, `dailyAt` or `everyMinutes`";
  // Whose job it is, and what it says.
  const requested = typeof args.agent_id === "string" ? args.agent_id.trim() : "";
  if (requested && bot && canonicalAgentID(requested) !== canonicalAgentID(bot)) return SELF_ONLY;
  const text = typeof args.text === "string" ? args.text.trim() : "";
  if (!text) return NOTHING_TO_DO;
  if (closureWording(text)) return CLOSURE_WORDING_REFUSAL;
  if (given(args.at)) {
    const when = oneShotMs(args.at);
    if (Number.isNaN(when)) return notADate(typeof args.at === "string" ? entry(args.at, 80) : args.at);
    if (now !== undefined && when < now - PAST_GRACE_MS) {
      return `the time you gave (${new Date(when).toISOString()}) has already passed. Give a time in the future.`;
    }
  }
  try {
    if (given(args.dailyAt)) parseWallClock(String(args.dailyAt));
    if (given(args.dailyAt) && Array.isArray(args.days)) for (const day of args.days) parseDay(String(day));
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (given(args.everyMinutes)) return everyMinutesProblem(Number(args.everyMinutes));
  return null;
}
