/**
 * Background job runner. The daemon owns one runner; it claims due jobs from
 * SQLite and executes them on a small pool (`concurrency`, default 1 here and
 * 2 in the daemon), so background work is visible, bounded, and survives
 * restarts (claims and retries live in the table). Only kinds in
 * PARALLEL_KINDS may overlap with themselves; every other kind is a singleton
 * (memory consolidate, rollover, backup, ...) and never runs twice at once.
 *
 * Failure honesty: a handler that throws is retried up to `maxAttempts` with
 * exponential backoff and jitter, then parked as `failed` and announced with
 * a `notify` frame. A recurring kind skips to its next scheduled run instead
 * of dying. Nothing is silently dropped.
 */
import type { Database } from "bun:sqlite";
import type { ServerFrameBody } from "@agni/protocol";
import { log } from "../log";
import { defaultPersona, resolvePersona } from "../agent/personas";
import { isRunPaused } from "../policy/pause";
import { claimDueJob, finishJob, parseJobPayload, requeueJob, type JobRow } from "../stores/jobs";
import { getRoutine } from "../stores/routines";
import { setDelegationState } from "../stores/tasks";

export interface JobOutcome {
  /** Short human-readable note stored on the job row. */
  result?: string;
  /** Set to run this job again at a later time (recurring jobs). */
  nextRunAt?: string;
  /**
   * With `nextRunAt`: the same run, put off (a wake whose parent thread is busy), not a move to the next slot. The run
   * keeps the clock it started (`jobs.run_clock_key`); only a move to a new slot starts the next run on a clock of its own.
   */
  deferred?: boolean;
}

export type JobHandler = (job: JobRow, ctx: JobContext) => Promise<JobOutcome | void>;

/** Throw to fail this run without a retry (e.g. a retry would replay side effects). */
export class JobGiveUp extends Error {
  /** quiet: the handler already told the owner, so the runner does not notify. */
  constructor(message: string, readonly quiet = false) {
    super(message);
  }
}

export interface JobRegisterOptions {
  /** For recurring kinds: the next scheduled run after a failed one, or null for none. */
  nextRun?: (job: JobRow) => string | null;
}

const MAX_RETRY_DELAY_MS = 3_600_000;

/**
 * Kinds that start a bot's work. They stop for pause-all and for their own bot being off (S2-13). Task
 * reminders, backups and the morning brief start no bot and go on.
 */
const BOT_KINDS: ReadonlySet<string> = new Set(["turn", "routine"]);

/**
 * Housekeeping that calls the model. It belongs to no one bot, so only pause-all (or a pause state that cannot
 * be read) holds it: it stays queued and runs after resume.
 */
const INTERNAL_MODEL_KINDS: readonly string[] = ["tagger", "memory.embed", "memory.consolidate", "summary.rollup", "rollover.summarize", "harness.review"];

/** How long a job waits when the pause state cannot be read, before it is looked at again. */
const UNREADABLE_RETRY_MS = 15_000;

/** The bot a job will run as, or why there is none. */
export type JobAgent = { ok: true; agentID: string | null } | { ok: false; reason: string };

/**
 * The one place that decides which bot a job runs as. The pause gate asks it, and the handler is given its
 * answer (`JobContext.agentID`), so what is checked is what runs. A bot job whose bot cannot be resolved
 * (a name nobody has, a routine that is gone) does not run, rather than running as the default bot.
 * Housekeeping and reminders have no bot (`agentID: null`).
 */
export function resolveJobAgent(db: Database, job: JobRow): JobAgent {
  if (!BOT_KINDS.has(job.kind)) return { ok: true, agentID: null };
  let payload: { agentID?: unknown; routineID?: unknown };
  try {
    payload = parseJobPayload(job);
  } catch {
    return { ok: false, reason: "its payload cannot be read" };
  }
  const byID = (id: string): JobAgent => {
    const persona = resolvePersona(db, id);
    return persona ? { ok: true, agentID: persona.id } : { ok: false, reason: `there is no bot "${id.slice(0, 64)}"` };
  };
  if (job.kind === "routine") {
    if (typeof payload.routineID !== "string" || !payload.routineID) return { ok: false, reason: "it names no routine" };
    const routine = getRoutine(db, payload.routineID);
    return routine ? byID(routine.agentID) : { ok: false, reason: `there is no routine "${payload.routineID.slice(0, 64)}"` };
  }
  if (payload.agentID === undefined || payload.agentID === null || payload.agentID === "") return byID(defaultPersona().id);
  return typeof payload.agentID === "string" ? byID(payload.agentID.trim()) : { ok: false, reason: "its bot is not a name" };
}

/** Kinds whose jobs are independent of each other; all others run one at a time. */
export const PARALLEL_KINDS: ReadonlySet<string> = new Set(["turn", "routine", "task.reminder"]);

export interface JobContext {
  emit: (frame: ServerFrameBody) => void;
  /** The bot this job runs as, resolved once by `resolveJobAgent` and checked against the pause switch. Null for jobs with no bot. */
  agentID: string | null;
}

export interface JobRunnerOptions {
  pollMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  maxPerTick?: number;
  /** How many jobs may run at once (AGNI_JOB_CONCURRENCY). Default 1. */
  concurrency?: number;
}

export class JobRunner {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly nextRuns = new Map<string, (job: JobRow) => string | null>();
  private readonly pollMs: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly maxPerTick: number;
  private readonly concurrency: number;
  private readonly runningSingletons = new Set<string>();
  private workers = 0;

  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  constructor(
    private readonly db: Database,
    private readonly emit: (frame: ServerFrameBody) => void,
    options: JobRunnerOptions = {},
  ) {
    this.pollMs = options.pollMs ?? 3000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 30_000;
    this.maxPerTick = options.maxPerTick ?? 3;
    this.concurrency = Math.max(1, options.concurrency ?? 1);
  }

  register(kind: string, handler: JobHandler, options: JobRegisterOptions = {}): void {
    if (this.handlers.has(kind)) throw new Error(`job kind already registered: ${kind}`);
    this.handlers.set(kind, handler);
    if (options.nextRun) this.nextRuns.set(kind, options.nextRun);
  }

  /** Kinds this runner can execute — everything else is parked as failed. */
  kinds(): string[] {
    return [...this.handlers.keys()];
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.pollSafely();
    this.timer = setInterval(() => this.pollSafely(), this.pollMs);
    log.info(`job runner: polling every ${this.pollMs}ms [${this.kinds().join(", ") || "no kinds"}]`);
  }

  /**
   * One poll that never rejects: the database can be locked for a moment by
   * another process (a reader or a backup holding it), and the next poll tries
   * again. An unhandled rejection here would only be noise in the log.
   */
  private pollSafely(): void {
    this.tick().catch((error) => log.warn(`job runner: poll failed, trying again in ${this.pollMs}ms`, error));
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Fill the free pool slots with workers; each claims due jobs (bounded per
   * tick) until none is due. A long job keeps only its own slot busy, so the
   * next tick still starts workers for reminders. Public so tests can drive it.
   */
  async tick(): Promise<number> {
    const free = this.concurrency - this.workers;
    const loops: Promise<number>[] = [];
    for (let i = 0; i < free; i += 1) {
      this.workers += 1;
      loops.push(this.work().finally(() => { this.workers -= 1; }));
    }
    return (await Promise.all(loops)).reduce((a, b) => a + b, 0);
  }

  private async work(): Promise<number> {
    let ran = 0;
    while (ran < this.maxPerTick) {
      // While everything is paused (or the state cannot be read) housekeeping that calls the model waits too.
      const hold = isRunPaused({ agentID: null }).paused ? INTERNAL_MODEL_KINDS : [];
      const job = claimDueJob(this.db, undefined, [...this.runningSingletons, ...hold]);
      if (!job) break;
      ran += 1;
      const gate = this.gate(job);
      if (!gate.run) continue;
      const singleton = !PARALLEL_KINDS.has(job.kind);
      if (singleton) this.runningSingletons.add(job.kind);
      try {
        await this.execute(job, gate.agentID);
      } finally {
        if (singleton) this.runningSingletons.delete(job.kind);
      }
    }
    return ran;
  }

  /**
   * S2-13: decide, once, whether a claimed job runs and as which bot. A bot job whose bot cannot be resolved is
   * not run and says why. A job of a paused or switched-off bot is not run: it is recorded as skipped and not
   * run late on resume (a recurring job waits for its next slot, a one-shot is done). A pause state that cannot
   * be read puts the job back a little later, never runs it. A delegation that does not run is marked failed, so
   * the bot waiting on it is told instead of waiting for ever.
   */
  private gate(job: JobRow): { run: true; agentID: string | null } | { run: false } {
    const who = resolveJobAgent(this.db, job);
    if (!who.ok) {
      this.close(job, `not run: ${who.reason}`, "Not run: the bot for this task does not exist.", "failed");
      return { run: false };
    }
    if (!BOT_KINDS.has(job.kind)) return { run: true, agentID: who.agentID };
    const verdict = isRunPaused({ agentID: who.agentID });
    if (!verdict.paused) return { run: true, agentID: who.agentID };
    if (verdict.unavailable) {
      requeueJob(this.db, job.id, new Date(Date.now() + UNREADABLE_RETRY_MS).toISOString());
      this.db.run("UPDATE jobs SET attempts = 0, result = ? WHERE id = ?", ["waiting: pause state unavailable", job.id]);
      log.warn(`job ${job.id} (${job.kind}) put back: the pause state cannot be read`);
      return { run: false };
    }
    const off = verdict.scope === "bot";
    this.close(job, off ? "skipped (bot off)" : "skipped (paused)", off ? "Not run: the owner turned this bot off." : "Not run: the owner paused all bots.", "done");
    return { run: false };
  }

  /** End a claimed job that will not run: a recurring one waits for its next slot, a one-shot ends as `state`. */
  private close(job: JobRow, result: string, delegationNote: string, state: "done" | "failed"): void {
    try {
      const delegationID = parseJobPayload<{ delegationTaskID?: string }>(job).delegationTaskID;
      if (delegationID) setDelegationState(this.db, delegationID, "failed", delegationNote);
    } catch {
      // An unreadable payload has no delegation to fail.
    }
    let next: string | null = null;
    try {
      next = this.nextRuns.get(job.kind)?.(job) ?? null;
    } catch {
      // A broken schedule cannot be skipped to; the job is closed below.
    }
    if (next) {
      requeueJob(this.db, job.id, next);
      this.db.run("UPDATE jobs SET attempts = 0, run_clock_key = NULL, result = ? WHERE id = ?", [result, job.id]);
    } else {
      finishJob(this.db, job.id, state, result);
    }
    log.info(`job ${job.id} (${job.kind}) ${result}${next ? `, next run ${next}` : ""}`);
  }

  private async execute(job: JobRow, agentID: string | null): Promise<void> {
    const handler = this.handlers.get(job.kind);
    if (!handler) {
      finishJob(this.db, job.id, "failed", `no handler registered for kind "${job.kind}"`);
      this.notify(`Job failed`, `${job.kind}: no handler registered`);
      return;
    }

    try {
      const outcome = (await handler(job, { emit: this.emit, agentID })) ?? {};
      if (outcome.nextRunAt) {
        requeueJob(this.db, job.id, outcome.nextRunAt);
        // A clean recurring run starts a fresh retry budget for its next failure, and its next slot a clock of its own. A run that is
        // only put off is the same run: it keeps its clock.
        this.db.run(outcome.deferred ? "UPDATE jobs SET attempts = 0 WHERE id = ?" : "UPDATE jobs SET attempts = 0, run_clock_key = NULL WHERE id = ?", [job.id]);
        if (outcome.result !== undefined) {
          this.db.run("UPDATE jobs SET result = ? WHERE id = ?", [`${outcome.result} (recurring)`, job.id]);
        }
        log.debug(`job ${job.id} (${job.kind}) done, next run ${outcome.nextRunAt}`);
      } else {
        finishJob(this.db, job.id, "done", outcome.result);
        log.info(`job ${job.id} (${job.kind}) done${outcome.result ? `: ${truncate(outcome.result, 80)}` : ""}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const quiet = error instanceof JobGiveUp && error.quiet;
      if (error instanceof JobGiveUp || job.attempts >= this.maxAttempts) {
        let next: string | null = null;
        try {
          next = this.nextRuns.get(job.kind)?.(job) ?? null;
        } catch {
          // A broken schedule cannot be skipped to; park the job below.
        }
        if (next) {
          // M38: a recurring job outlives a bad run: skip to its next slot.
          requeueJob(this.db, job.id, next);
          this.db.run("UPDATE jobs SET attempts = 0, run_clock_key = NULL, result = ? WHERE id = ?", [`run failed: ${message}; next run ${next}`, job.id]);
          log.error(`job ${job.id} (${job.kind}) gave up on this run: ${message} — next run ${next}`);
          if (!quiet) this.notify("Job failed", `${job.kind}: ${truncate(message, 120)} (will run again ${next})`);
        } else {
          finishJob(this.db, job.id, "failed", message);
          log.error(`job ${job.id} (${job.kind}) failed after ${job.attempts} attempts: ${message}`);
          if (!quiet) this.notify("Job failed", `${job.kind}: ${truncate(message, 140)}`);
        }
      } else {
        const runAt = new Date(Date.now() + this.backoffMs(job.attempts)).toISOString();
        requeueJob(this.db, job.id, runAt);
        this.db.run("UPDATE jobs SET result = ? WHERE id = ?", [`attempt ${job.attempts} failed: ${message}`, job.id]);
        log.warn(`job ${job.id} (${job.kind}) attempt ${job.attempts} failed: ${message} — retrying at ${runAt}`);
      }
    }
  }

  /** Exponential backoff from `retryDelayMs`, capped at an hour, with jitter in [half, full]. */
  backoffMs(attempt: number): number {
    const full = Math.min(this.retryDelayMs * 2 ** Math.max(0, attempt - 1), MAX_RETRY_DELAY_MS);
    return Math.round(full / 2 + Math.random() * (full / 2));
  }

  private notify(title: string, body: string): void {
    this.emit({ type: "notify", title, body, sound: false });
  }
}

function truncate(text: string, max: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}
