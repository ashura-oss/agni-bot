/**
 * Scheduling tools — the agent's clock.
 *
 * The daemon already knows how to run background turns (the `turn` job kind:
 * a prompt in a thread, optionally recurring) and how to pause and resume
 * them. What was missing was a way for the *agent* to put work on that clock.
 * "Check my inbox every weekday at 9:05" had no tool at all, so the model
 * went looking for one in the app's own source and burned the turn.
 *
 * A scheduled job is a durable row: it survives restarts, it is visible in
 * `job_list`, and `job_cancel` stops it. Nothing here sends anything by
 * itself — a scheduled run is a normal turn, with the same tool rules.
 */
import type { Database } from "bun:sqlite";
import type { ToolContext, ToolDefinition } from "./registry";
import {
  deleteJob, enqueueJob, getJob, getJobByPrefix, listFinishedJobs, listJobs, setJobEnabled,
} from "../stores/jobs";
import { canonicalAgentID } from "../agent/personas";
import { describeSchedule, nextDailyRun, parseDay, parseWallClock } from "../jobs/schedule";
import { isPeerPrincipal, isTainted, packTaint, unknownTaint } from "../policy/context";
import type { RunContext, TaintSource } from "../policy/types";
import { denialScope } from "../policy/denials";
import { audit } from "../policy/audit-sink";
import { describeRecurring, isRecurringSchedule, standingRuleOrigin } from "../policy/standing-rules";
import { CLOSURE_WORDING_REFUSAL, closureWording } from "../agent/closure";
import { canSelfSchedule, maxSelfScheduledJobs } from "../agent/guardrails";

export interface JobScheduleArgs {
  /** The prompt the scheduled run executes. */
  text: string;
  /** One-off run at an ISO timestamp. */
  at?: string;
  /** Recurring run at a local wall-clock time, "09:05". */
  dailyAt?: string;
  /** Weekdays a `dailyAt` schedule fires on: "mon".."sun". */
  days?: string[];
  /** Recurring run every N minutes. */
  everyMinutes?: number;
  /** Which agent runs it. Defaults to the agent that scheduled it. */
  agentID?: string;
  /** Raise a notification when a run ends. Default true. */
  notify?: boolean;
}

export interface JobScheduleResult {
  id: string;
  /** When it next fires, ISO. */
  nextRun: string;
  /** Plain description of the schedule. */
  recurrence: string;
  agent: string;
  what: string;
}

export interface JobListResult {
  scheduled: ScheduledJobView[];
  recentlyFinished: ScheduledJobView[];
}

export interface ScheduledJobView {
  id: string;
  state: string;
  nextRun: string;
  recurrence: string;
  agent: string;
  what: string;
  lastResult: string | null;
}

const MIN_EVERY_MINUTES = 5;

/** Jobs this bot put on its own clock that are still queued or running. Jobs the owner or a routine made are not counted. */
function selfScheduledCount(db: Database, callerAgentID: string): number {
  return listJobs(db, { limit: 1_000 }).filter((row) => {
    if (row.kind !== "turn") return false;
    const payload = parsePayload(row.payload);
    return payload.scheduledBy === "bot" && canonicalAgentID(String(payload.agentID ?? "ea")) === canonicalAgentID(callerAgentID);
  }).length;
}

/**
 * Why this call may not schedule work, or null when it may. A run that read outside text may not
 * (what a page asks for must not become a standing job); a bot's brief from another bot and a
 * routine's saved state may not either. A wake or a scheduled job that read nothing outside may,
 * as the owner's own turn may.
 */
function schedulingRefusal(ctx: ToolContext): string | null {
  if (!ctx.run) return ctx.peerInput ? "not done: this turn started from another agent's message" : null;
  if (isPeerPrincipal(ctx.run)) return "not done: this turn started from another agent's message";
  if (isTainted(ctx.run)) return "not done: this run read outside content, so it may not schedule work. Tell the owner what you wanted to schedule and ask them to confirm it.";
  return null;
}

/** The request a one-shot job a bot schedules stays in: its wakes are counted with the request's. */
export interface RequestRoot {
  rootTurnID: string;
  rootJob: string | null;
}

/** What a job a bot schedules keeps of the run that scheduled it. */
export interface ScheduledFrom {
  /** The scheduling run's refusal scope: what the owner refused there holds in every run of the job. Always set for a run. */
  denialRoot?: string;
  /**
   * The scheduling run's request, for the wake count of a one-shot job: it is part of that request. A recurring job never
   * takes it: each of its runs is a request of its own, counted by its own wakes (`jobID@turnID`).
   */
  root?: RequestRoot;
  /**
   * The request that made a repeating job, for the audit log: the scheduling run's refusal scope (the chat turn, or the job a chain
   * began in). Set by the server from the run, never by a tool argument.
   */
  createdByRequest?: string;
  /** For the audit row of a repeating job: the bot's turn, and how the job came to be allowed. */
  created?: { turnID?: string; jobID?: string | null; approval: "own_turn" | "owner_card" };
  /**
   * What the scheduling run had read, when it had read outside text (or could not say): every run of the job starts with it, so a job
   * the owner approved from such a run does not shed its restrictions. Absent for a run that read nothing outside.
   */
  taint?: TaintSource[];
}

/** What a job made by this run must start with, or undefined when the run read nothing outside. A record that cannot be read is one unknown source. */
function carriedTaint(run: RunContext | undefined): TaintSource[] | undefined {
  if (!run || !isTainted(run)) return undefined;
  return Array.isArray(run.taint?.sources) && run.taint.sources.length > 0 ? packTaint(run) : [unknownTaint("a run with no record of what it had read")];
}

/**
 * The request a one-shot job scheduled by this call stays in, or undefined when it starts one of its own. Only the owner's own
 * turn starts a request. Any other run (a wake, a delegated child, a resumed task, a job, a job scheduled from one) hands its
 * request on, so a chain of jobs, each scheduling the next, is counted as one: its wakes, its spend.
 */
function inheritedRoot(ctx: ToolContext): RequestRoot | undefined {
  const run = ctx.run;
  if (!run || run.principal.kind === "owner") return undefined;
  return { rootTurnID: run.rootTurnID, rootJob: run.rootJob };
}

export function scheduleJob(db: Database, args: JobScheduleArgs, callerAgentID: string, from: ScheduledFrom = {}): JobScheduleResult {
  const { root, denialRoot, createdByRequest, created, taint } = from;
  const requested = args.agentID?.trim();
  if (requested && canonicalAgentID(requested) !== canonicalAgentID(callerAgentID)) {
    throw new Error("an agent may only schedule jobs for itself");
  }
  const text = args.text.trim();
  if (!text) throw new Error("a scheduled job needs something to do");
  if (closureWording(text)) throw new Error(CLOSURE_WORDING_REFUSAL);
  const mine = selfScheduledCount(db, callerAgentID);
  const mostToKeep = maxSelfScheduledJobs(db);
  if (!canSelfSchedule(mine, mostToKeep)) {
    throw new Error(`you already have ${mine} scheduled jobs and ${mostToKeep} is the most a bot may keep. Cancel one with job_cancel before scheduling another.`);
  }
  const choices = [args.at, args.dailyAt, args.everyMinutes].filter((value) => value !== undefined && value !== null);
  if (choices.length === 0) throw new Error("say when it should run: `at` (one-off), `dailyAt` (a clock time), or `everyMinutes`");
  if (choices.length > 1) throw new Error("pick one: `at`, `dailyAt` or `everyMinutes`");

  const payload: Record<string, unknown> = {
    text,
    agentID: callerAgentID,
    // C4: scheduled text is model-authored, so it runs as non-owner input.
    inputRole: "system",
    // Counted against the bot's own allowance (S2-09).
    scheduledBy: "bot",
    notify: args.notify !== false,
    // The owner's refusals in the run that scheduled it hold in every run of this job, for good (what the run delegates, wakes and schedules too).
    ...(denialRoot ? { denialRoot } : {}),
    // What the scheduling run read stays with the job: each fire starts as tainted as that run was.
    ...(taint && taint.length > 0 ? { taint } : {}),
  };

  let runAt: string;
  let recurrence: string;
  if (args.at) {
    const when = new Date(args.at);
    if (Number.isNaN(when.getTime())) throw new Error(`"${args.at}" is not a date`);
    runAt = when.toISOString();
    recurrence = "once";
    // Still the request it was scheduled in, for its wake count (it has a clock of its own, which `clockKey` would take away).
    if (root) { payload.rootTurnID = root.rootTurnID; payload.rootJob = root.rootJob; }
  } else if (args.dailyAt) {
    const clock = parseWallClock(args.dailyAt);
    const days = args.days?.map((day) => parseDay(day));
    const at = `${String(clock.hour).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")}`;
    runAt = nextDailyRun(at, days).toISOString();
    recurrence = describeSchedule(at, days);
    payload.dailyAt = at;
    if (days && days.length > 0) payload.days = days;
    if (createdByRequest) payload.createdByRequest = createdByRequest;
  } else {
    const minutes = Number(args.everyMinutes);
    if (!Number.isFinite(minutes) || minutes < MIN_EVERY_MINUTES || minutes > 10_080) {
      throw new Error(`everyMinutes must be between ${MIN_EVERY_MINUTES} and 10080 (a week)`);
    }
    const everyMs = Math.round(minutes * 60_000);
    runAt = new Date(Date.now() + everyMs).toISOString();
    recurrence = `every ${minutes} minute${minutes === 1 ? "" : "s"}`;
    payload.everyMs = everyMs;
    if (createdByRequest) payload.createdByRequest = createdByRequest;
  }

  const row = enqueueJob(db, { kind: "turn", payload, runAt });
  if (!args.at) {
    // A repeating job leaves its own audit row, and is not kept without it (fail closed).
    try {
      audit({
        kind: "job.recurring.created",
        actor: callerAgentID,
        ...(created?.turnID ? { turnID: created.turnID } : {}),
        ...(created?.jobID ? { jobID: created.jobID } : {}),
        detail: { jobID: row.id, agent: callerAgentID, schedule: recurrence, nextRun: runAt, createdByRequest: createdByRequest ?? null, approval: created?.approval ?? "direct", what: text.slice(0, 200) },
      });
    } catch (error) {
      deleteJob(db, row.id);
      throw new Error(`not done: the audit log could not record the repeating job, so it was not kept (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return {
    id: row.id,
    nextRun: runAt,
    recurrence,
    agent: String(payload.agentID),
    what: text.slice(0, 200),
  };
}

export function listScheduledJobs(db: Database, callerAgentID: string, limit = 20): JobListResult {
  const view = (row: NonNullable<ReturnType<typeof getJob>>): ScheduledJobView => {
    const payload = parsePayload(row.payload);
    const dailyAt = typeof payload.dailyAt === "string" ? payload.dailyAt : null;
    const days = Array.isArray(payload.days) ? (payload.days as unknown[]).map(Number) : undefined;
    return {
      id: row.id,
      state: row.enabled === 0 ? "paused" : row.state,
      nextRun: row.run_at,
      recurrence: dailyAt
        ? describeSchedule(dailyAt, days)
        : payload.everyMs
          ? `every ${Math.round(Number(payload.everyMs) / 60_000)} minute(s)`
          : "once",
      agent: String(payload.agentID ?? "ea"),
      what: String(payload.text ?? "").slice(0, 200),
      lastResult: row.result,
    };
  };
  const mine = (row: NonNullable<ReturnType<typeof getJob>>) => ownsJob(row, callerAgentID);
  return {
    scheduled: listJobs(db, { limit: 500 }).filter(mine).slice(0, limit).map(view),
    recentlyFinished: listFinishedJobs(db, 100).filter(mine).slice(0, 5).map(view),
  };
}

function ownsJob(row: NonNullable<ReturnType<typeof getJob>>, callerAgentID: string): boolean {
  return row.kind === "turn" && canonicalAgentID(String(parsePayload(row.payload).agentID ?? "ea")) === canonicalAgentID(callerAgentID);
}

function isRecordRow(row: NonNullable<ReturnType<typeof getJob>>): boolean {
  const payload = parsePayload(row.payload);
  return payload.wakeKey !== undefined || payload.delegationTaskID !== undefined;
}

export function cancelScheduledJob(db: Database, id: string, callerAgentID: string): { id: string; state: string; note: string } {
  const found = getJob(db, id) ?? getJobByPrefix(db, id);
  // Someone else's job looks the same as a missing one.
  const row = found && ownsJob(found, callerAgentID) ? found : undefined;
  if (!row) throw new Error(`no scheduled job with id "${id}"`);
  // A wake is the count of its request's wakes, and a delegated task's job is the record of that task: deleting either
  // would reset a limit or erase what ran. They are not reminders the bot set, so it may not remove them.
  if (isRecordRow(row)) throw new Error(`job "${row.id}" is not one of your reminders: it is the record of a delegated task or a wake, and job_cancel cannot remove it`);
  if (row.state === "running") {
    setJobEnabled(db, row.id, false);
    return { id: row.id, state: "paused", note: "it is running right now; it will not run again" };
  }
  deleteJob(db, row.id);
  return { id: row.id, state: "cancelled", note: "it will not run again" };
}

function parsePayload(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const objectSchema = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
  type: "object", properties, required, additionalProperties: false,
});
const stringProp = { type: "string", minLength: 1 };

function callerOf(ctx: ToolContext): string {
  const id = ctx.chain?.currentAgentID;
  if (!id) throw new Error("unknown calling agent");
  return id;
}

/** Why these `job_schedule` arguments can never be made into a job, or null. The same checks `scheduleJob` makes, said before the call is judged. */
function scheduleProblem(args: Record<string, unknown>): string | null {
  const given = (value: unknown): boolean => value !== undefined && value !== null;
  if ([args.at, args.dailyAt, args.everyMinutes].filter(given).length > 1) return "pick one: `at`, `dailyAt` or `everyMinutes`";
  try {
    if (given(args.dailyAt)) parseWallClock(String(args.dailyAt));
    if (given(args.dailyAt) && Array.isArray(args.days)) for (const day of args.days) parseDay(String(day));
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return null;
}

/**
 * The answer to a repeating job nobody may make unasked: the tool's own line of defence behind the policy engine, which puts the
 * owner a card for the same call. It leaves an audit row too.
 */
function refuseStandingJob(ctx: ToolContext, input: Record<string, unknown>, why: string): { error: string } {
  try {
    audit({
      kind: "job.recurring.refused",
      actor: ctx.chain?.currentAgentID ?? "unknown",
      turnID: ctx.turnID,
      ...(ctx.run?.jobID ? { jobID: ctx.run.jobID } : {}),
      detail: { tool: "job_schedule", cause: "not_approved", schedule: describeRecurring(input), principal: ctx.run?.principal?.kind ?? "unknown" },
    });
  } catch {
    // The refusal stands without its row.
  }
  return { error: `not done: work that starts again on its own (a repeating job, or a job that schedules the next one) is a standing rule, and only your owner's own turn may start it without asking. ${why} Tell the owner what you wanted to schedule and ask them to confirm it.` };
}

/** The scheduling tools, as the task lane sees them. */
export function createJobTools(db: Database): ToolDefinition<unknown, unknown>[] {
  return [
    {
      name: "job_schedule",
      description:
        "Schedule work for later. Use it when the owner asks for something on a clock (\"every weekday at 9:05\", \"tomorrow morning\", \"every 30 minutes\"). " +
        "The job runs the given text as a turn — say exactly what it should do, in the imperative, and let it use tools. " +
        "Give a `dailyAt` (local wall-clock time like \"09:05\") with `days` ([\"mon\",\"tue\",\"wed\",\"thu\",\"fri\"]) for a recurring clock, " +
        "`at` (ISO timestamp) for a one-off, or `everyMinutes` for a fixed interval.",
      kind: "static",
      schema: objectSchema({
        text: { type: "string", minLength: 1, maxLength: 4_000 },
        at: { type: "string", description: "ISO timestamp for a one-off run" },
        dailyAt: { type: "string", description: "Local wall-clock time for a recurring run, e.g. \"09:05\"" },
        days: { type: "array", maxItems: 7, items: { type: "string" }, description: "Weekdays for a dailyAt schedule" },
        everyMinutes: { type: "integer", minimum: MIN_EVERY_MINUTES, maximum: 10_080 },
        agent_id: stringProp,
        notify: { type: "boolean" },
      }, ["text"]),
      timeoutMs: 3_000,
      // What the schema cannot say: a schedule that could never be made is refused before the owner is asked about a repeating job.
      validate: scheduleProblem,
      handler: async (args, ctx) => {
        const input = (args ?? {}) as Record<string, unknown>;
        const recurring = isRecurringSchedule(input);
        if (recurring) {
          // A repeating job is a standing rule: only the owner's own clean turn, or the owner's yes to this very call's card
          // (set by the loop, never by an argument), makes one. A run or an origin that cannot be read is not the owner's.
          const why = ctx.ownerApproved === true ? null : standingRuleOrigin(ctx.run);
          if (why !== null) return refuseStandingJob(ctx, input, why);
        } else {
          const refusal = schedulingRefusal(ctx);
          if (refusal) return { error: refusal };
          // A fire of a job a bot made may not schedule the next one unasked: a chain of one-shot jobs is a repeating job (policy/standing-rules.ts).
          if (ctx.ownerApproved !== true && ctx.run?.principal?.kind === "job") return refuseStandingJob(ctx, input, "This task was started by a scheduled job, not by you.");
        }
        return scheduleJob(db, {
          text: String(input.text ?? ""),
          ...(input.at === undefined ? {} : { at: String(input.at) }),
          ...(input.dailyAt === undefined ? {} : { dailyAt: String(input.dailyAt) }),
          ...(input.days === undefined ? {} : { days: (input.days as unknown[]).map((day) => String(day)) }),
          ...(input.everyMinutes === undefined ? {} : { everyMinutes: Number(input.everyMinutes) }),
          ...(input.agent_id === undefined ? {} : { agentID: String(input.agent_id) }),
          ...(input.notify === undefined ? {} : { notify: Boolean(input.notify) }),
        }, callerOf(ctx), {
          ...(ctx.run ? { denialRoot: denialScope(ctx.run), ...(recurring ? { createdByRequest: denialScope(ctx.run) } : {}) } : {}),
          root: inheritedRoot(ctx),
          taint: carriedTaint(ctx.run),
          created: { turnID: ctx.turnID, jobID: ctx.run?.jobID ?? null, approval: ctx.ownerApproved === true ? "owner_card" : "own_turn" },
        });
      },
    } as ToolDefinition<unknown, unknown>,
    {
      name: "job_list",
      description: "List scheduled work: what is queued, when it next runs, and what ran recently.",
      kind: "static",
      schema: objectSchema({ limit: { type: "integer", minimum: 1, maximum: 50 } }, []),
      timeoutMs: 2_000,
      handler: async (args, ctx) => {
        const input = (args ?? {}) as Record<string, unknown>;
        const limit = typeof input.limit === "number" ? Math.max(1, Math.min(50, Math.floor(input.limit))) : 20;
        return listScheduledJobs(db, callerOf(ctx), limit);
      },
    } as ToolDefinition<unknown, unknown>,
    {
      name: "job_cancel",
      description: "Cancel a scheduled job by id (or a unique prefix). It will not run again.",
      kind: "static",
      schema: objectSchema({ id: stringProp }, ["id"]),
      timeoutMs: 2_000,
      handler: async (args, ctx) => {
        if (ctx.peerInput) return { error: "not done: this turn started from another agent's message" };
        const input = (args ?? {}) as Record<string, unknown>;
        return cancelScheduledJob(db, String(input.id ?? ""), callerOf(ctx));
      },
    } as ToolDefinition<unknown, unknown>,
  ];
}
