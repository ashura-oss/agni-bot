/**
 * The `turn` job kind: run one prompt in a thread as background work. This is
 * how the daemon does things unprompted — reminders, the precomputed 07:55
 * brief, link resurfacing — and how it chats back: the turn streams to any
 * connected client through the normal frames, and completion raises a
 * `notify` frame.
 *
 * Payload: { threadID?, text, agentID?, notify?, maxReplyChars?, everyMs? }
 *   - threadID: reuse a thread; otherwise the job creates one.
 *   - everyMs:  recurring — schedule the next run after this one succeeds.
 *   - dailyAt: recurring on a wall clock ("09:05"); `days` limits it to
 *     certain weekdays, so "weekdays at 9:05" does not fire on a Saturday.
 */
import type { Database } from "bun:sqlite";
import type { ServerFrameBody } from "@agni/protocol";
import { runTaskTurn, isThreadActive, type TaskTurnSettings } from "../agent/task-loop";
import { canonicalAgentID, getPersona, resolvePersona, type ResolvedPersona } from "../agent/personas";
import { DEFAULT_VISIBILITY, MISSING_AGENT_VISIBILITY, RESULT_MAX_CHARS, redactResultForCaller } from "../agent/visibility";
import { rootGuardrail } from "../agent/guardrails";
import { asksWhenClean } from "../policy/metadata";
import { readCapabilities } from "../policy/narrowing";
import { readTaint, unknownTaint } from "../policy/context";
import { saveTaskTaint, taskTaint } from "../policy/carry";
import { denialScope } from "../policy/denials";
import type { TaintSource } from "../policy/types";
import type { Router } from "../models/router";
import { getThread } from "../stores/threads";
import { ensureDMChannel } from "../stores/channels";
import { backgroundSession, ensureConversation, getConversation, type ConversationRow } from "../stores/conversations";
import { appendJobResult, enqueueJob, findQueuedJobByPayloadKey, parseJobPayload, type JobRow } from "../stores/jobs";
import {
  claimResultDelivery,
  getTask,
  isDelegationCancelled,
  setDelegationArtifact,
  setDelegationState,
  setDelegationThread,
  taskInfo,
  trackRunningDelegation,
  briefChainID,
  briefRoot,
} from "../stores/tasks";
import { saveArtifact } from "../stores/artifacts";
import { scheduleTagger } from "./tagger";
import { nextDailyRun, nextIntervalRun } from "./schedule";
import { peerEnvelope } from "../agent/peer-message";
import type { PeerIntent } from "@agni/protocol";
import { JobGiveUp, type JobContext, type JobRunner } from "./runner";
import { nowISO } from "../util/ids";

/** How long a wake first waits when the parent's thread is busy; doubles per deferral. */
const WAKE_RETRY_MS = 1_500;
const WAKE_RETRY_MAX_MS = 60_000;
/** M36: a wake that has waited this many times gives up (about half an hour). */
export const MAX_WAKE_DEFERRALS = 40;
/** Tools whose effect a retry would repeat even though they are not approval-gated. */
const NON_IDEMPOTENT_TOOLS = new Set(["mail_send", "run_privileged", "delegate_task"]);
/** Daily-cap notices already sent, `${agentID}:${day}`. */
const capNotified = new Set<string>();

export interface TurnJobPayload {
  chainID?: string;
  threadID?: string;
  text: string;
  agentID?: string;
  /** Raise a notify frame when the turn ends. Default true. */
  notify?: boolean;
  everyMs?: number;
  /**
   * Recurring on a local wall clock, "09:05". With `days` it fires only on
   * those weekdays (0 = Sunday … 6 = Saturday).
   */
  dailyAt?: string;
  days?: number[];
  /** When true (default), bounded durable facts ride in the prompt prefix. */
  facts?: boolean;
  /** The delegation task row this job fulfils (DEL-001). */
  delegationTaskID?: string;
  /**
   * DEL-006: this job is a wake — a parent agent being told that a
   * delegated task finished. `wakeKey` coalesces several completions for
   * the same parent thread into one wake turn.
   */
  wake?: {
    taskID: string;
    agentID: string;
    threadID: string;
    channelID: string | null;
    summary: string;
    redacted: boolean;
  };
  wakeKey?: string;
  /** M36: how many times this wake has waited for a busy parent. */
  deferrals?: number;
  /** H23: delegation depth of this turn; 1 = root, each delegate_task hop adds one. */
  depth?: number;
  /** The completions a coalesced wake carries. */
  results?: Array<{
    taskID: string;
    agentID: string;
    summary: string;
    redacted: boolean;
    /** What that task's run read from outside text (S2-06). Empty for a task that read nothing. */
    taint?: unknown;
  }>;
  /** What the run that queued this job had read from outside text, for a delegated child (S2-06). */
  taint?: unknown;
  /** What the run that queued this job could call; a delegated child may call only these (S2-06). Missing or unreadable: the inert tools only. */
  capabilities?: unknown;
  /** The request this job belongs to: set on a delegated child, a wake and a resumed task so a refusal earlier in the chain still holds. */
  rootTurnID?: string;
  rootJob?: string | null;
  /** The clock a delegated child is measured on: its parent's. A job without one starts a clock of its own. */
  clockKey?: string;
  /** The run a delegation counts against (see `delegate_task`'s cap on running delegations). */
  rootKey?: string;
  /** The channel the turn's result belongs to. */
  channelID?: string;
  /** How the request is written to the durable log. */
  inputRole?: "user" | "system";
  peer?: { from: string; intent: PeerIntent; task?: string };
}

export interface TurnJobDeps {
  db: Database;
  router: Router;
  settings: TaskTurnSettings;
  emit: (frame: ServerFrameBody) => void;
}

export function registerTurnJob(runner: JobRunner, deps: TurnJobDeps): void {
  runner.register("turn", async (job: JobRow, ctx: JobContext) => {
    const payload = parseJobPayload<TurnJobPayload>(job);

    // DEL-006: a wake turn tells the parent agent that a delegated task
    // finished. If the parent's thread is busy, the wake waits for it rather
    // than racing it — the parent is mid-thought, not gone.
    if (payload.wakeKey && payload.results?.length) {
      const parentThreadID = payload.threadID?.trim();
      if (parentThreadID && isThreadActive(parentThreadID)) {
        // M36: reschedule this same row with a growing delay, never a new row.
        const deferrals = (payload.deferrals ?? 0) + 1;
        if (deferrals > MAX_WAKE_DEFERRALS) {
          throw new JobGiveUp(`the parent thread stayed busy through ${MAX_WAKE_DEFERRALS} deferrals; the result is on the task row`);
        }
        deps.db.run("UPDATE jobs SET payload = ?, updated_at = ? WHERE id = ?", [
          JSON.stringify({ ...payload, deferrals }),
          nowISO(),
          job.id,
        ]);
        const delay = Math.min(WAKE_RETRY_MS * 2 ** (deferrals - 1), WAKE_RETRY_MAX_MS);
        return { result: "deferred: the parent thread is busy", nextRunAt: new Date(Date.now() + delay).toISOString() };
      }
      // S1-21: a result the parent already read through delegate_wait or
      // task_status was reported in that turn. Announcing it again would make
      // the owner hear the same answer twice.
      const unread = parentThreadID ? payload.results.filter((item) => !parentAlreadyRead(deps.db, parentThreadID, item.taskID)) : payload.results;
      if (unread.length === 0) return { result: "skipped: the parent already read this result" };
      payload.results = unread;
      payload.text = buildWakeText(unread);
    }

    const text = payload.text?.trim();
    if (!text) throw new Error("turn job payload has no text");
    const delegationTaskID = payload.delegationTaskID?.trim() || null;
    if (delegationTaskID) {
      // A cancelled task must not run, even if its job was already claimed.
      if (isDelegationCancelled(deps.db, delegationTaskID)) return { result: "cancelled" };
      setDelegationState(deps.db, delegationTaskID, "running");
      announceTask(deps, delegationTaskID);
    }

    // The bot the runner resolved and checked against the pause switch: what was checked is what runs. The payload
    // is not read for it again, so a spelling the first lookup tolerated cannot land on a different bot the second time.
    const persona = ctx.agentID === null ? undefined : resolvePersona(deps.db, ctx.agentID);
    if (!persona) throw new Error("turn job has no bot to run as");
    const capped = payload.wakeKey ? null : dailyCapReached(deps, persona);
    if (capped) {
      if (delegationTaskID) setDelegationState(deps.db, delegationTaskID, "failed", capped);
      throw new JobGiveUp(capped, true);
    }

    let threadID = payload.threadID?.trim();
    let conversation: ConversationRow | undefined;
    if (threadID) {
      const existing = getThread(deps.db, threadID);
      if (!existing) throw new Error(`thread ${threadID} no longer exists`);
      // A recurring job keeps the block it created: one routine is one
      // conversation with the agent (blueprint §process lifecycle).
      conversation = existing.conversation_id ? (getConversation(deps.db, existing.conversation_id) ?? undefined) : undefined;
    } else {
      // Background results need a home, and the home is the conversation:
      // a new session block inside it, so the user sees the result where
      // they already chat with the agent. It never takes over the active
      // chat block, and recurring runs keep landing in the same one.
      const cnv = ensureConversation(deps.db, persona.id);
      threadID = backgroundSession(deps.db, cnv, payload.text.trim().replace(/\s+/g, " ").slice(0, 60)).id;
      conversation = getConversation(deps.db, cnv.id) ?? undefined;
      deps.db.run("UPDATE jobs SET payload = ?, updated_at = ? WHERE id = ?", [
        JSON.stringify({ ...payload, threadID }),
        new Date().toISOString(),
        job.id,
      ]);
    }
    // The specialist's own thread: the answer, and any later resume, belong
    // to the same conversation.
    if (delegationTaskID) setDelegationThread(deps.db, delegationTaskID, threadID);

    const startedAt = nowISO();
    let result: Awaited<ReturnType<typeof runTurn>>;
    // The task has a record of what it read from the moment it starts, and keeps it whatever happens next.
    if (delegationTaskID) saveTaskTaint(deps.db, delegationTaskID, startTaint(payload));
    try {
      result = await runTurn(deps, payload, persona, threadID, conversation, text, job.attempts > 1, job.id, job.run_at);
    } catch (error) {
      // S1-12: a cancelled task ends here, whatever the aborted turn threw.
      if (delegationTaskID && isDelegationCancelled(deps.db, delegationTaskID)) return { result: "cancelled" };
      throw giveUpIfSideEffects(deps.db, threadID, startedAt, error instanceof Error ? error.message : String(error)) ?? error;
    } finally {
      // Whatever the run did, its task has a record; one that never got one reads as tainted. (What the run read is
      // saved as it is read, so a run that failed keeps it.)
      if (delegationTaskID && deps.db.query<{ taint: string | null }, [string]>("SELECT taint FROM tasks WHERE id = ?").get(delegationTaskID)?.taint == null) {
        saveTaskTaint(deps.db, delegationTaskID, [unknownTaint("a task that ended with no record of what it read")]);
      }
    }

    // S1-12: the owner cancelled while the child ran. The cancelled state, not
    // this turn's outcome, is the task's truth: no result, no wake, no notify.
    if (delegationTaskID && isDelegationCancelled(deps.db, delegationTaskID)) return { result: "cancelled" };
    // What this task's run read from outside text stays with the task, for the bot that reads its result.
    if (delegationTaskID) saveTaskTaint(deps.db, delegationTaskID, result.taint);

    // S1-13: a scheduled run whose gated action was denied or never approved did
    // not do that work. Never record it as done, whatever the model then said.
    const blocked = payload.wakeKey || delegationTaskID ? null : blockedByApproval(deps.db, threadID, startedAt);
    // A run that ended normally after a later gated call was allowed did the work another
    // way (awk denied, then an approved write did it): done, with a note to check the result.
    let deniedNote = "";
    if (blocked && result.stopReason !== "needs_input") {
      if (!(blocked.workedAround && result.stopReason === "end")) throw new JobGiveUp(`not done: ${blocked.reason}`);
      deniedNote = ` (a denied step was skipped; check the result: ${blocked.tools.join(", ")})`;
    }

    if (result.stopReason === "needs_input") {
      // DEL-006: the task asked the owner a question and is waiting. This is
      // not a failure and not a completion: the answer resumes it.
      return { result: "waiting for the owner" };
    }

    if (result.endedBy === "wall_time") {
      // The time limit is the owner's number, and a retry keeps the clock of the first try, so it would be stopped again.
      // The stop message already told the owner why, so the runner does not add a notice of its own.
      const message = "stopped: the time limit for this task ran out";
      if (delegationTaskID) setDelegationState(deps.db, delegationTaskID, "failed", message);
      throw new JobGiveUp(`not done: ${message}`, true);
    }
    if (result.stopReason !== "end") {
      // runTaskTurn already reported the failure as frames; a non-end stop
      // is a failed job so the runner retries it honestly.
      if (delegationTaskID) setDelegationState(deps.db, delegationTaskID, "failed", `turn ended with ${result.stopReason}`);
      const message = `turn ended with ${result.stopReason}${result.text ? " (partial output kept)" : ""}`;
      // H20: a retry re-runs every tool, so a turn that already acted is not retried.
      throw giveUpIfSideEffects(deps.db, threadID, startedAt, message) ?? new Error(message);
    }

    // TAG-001: a background turn is also material worth tagging. A peer-influenced
    // turn is not: its input never becomes a durable fact.
    if (!payload.peer && payload.inputRole !== "system") {
      scheduleTagger(deps.db, { agentID: persona.id, ...(payload.channelID ? { channelID: payload.channelID } : {}) });
    }

    const reply = firstLine(result.text);
    if (delegationTaskID && !isDelegationCancelled(deps.db, delegationTaskID)) {
      // DEL-004: the full result is an artifact in the specialist's
      // workspace; the task row keeps a short summary, and only the summary
      // enters the caller's context.
      const full = result.text.trim();
      // The artifact is saved first so the summary can point at it.
      let artifactID: string | undefined;
      try {
        const artifact = saveArtifact(deps.db, {
          taskID: delegationTaskID,
          agentID: persona.id,
          kind: "result",
          content: full,
        });
        setDelegationArtifact(deps.db, delegationTaskID, artifact.id);
        artifactID = artifact.id;
      } catch {
        // A result too large to store is still a summary.
      }
      const summary = summarizeResult(full, artifactID);
      setDelegationState(deps.db, delegationTaskID, "done", summary);
      announceTask(deps, delegationTaskID);
      wakeParent(deps, delegationTaskID, summary, Math.max(1, (payload.depth ?? 2) - 1));
    }
    if (payload.notify !== false) {
      deps.emit({ type: "notify", title: `${persona.name} · ${truncate(text, 60)}`, body: reply, sound: false });
    }

    const outcome: { result: string; nextRunAt?: string } = { result: `thread ${threadID}: ${reply}${deniedNote}` };
    if (payload.dailyAt) {
      // A clock, not an interval: the next run is the next wall-clock moment
      // the schedule names, on the days it names.
      outcome.nextRunAt = nextDailyRun(payload.dailyAt, payload.days).toISOString();
    } else if (payload.everyMs && payload.everyMs > 0) {
      outcome.nextRunAt = nextIntervalRun(job.run_at, payload.everyMs).toISOString();
    }
    return outcome;
  }, { nextRun: nextScheduledRun });
}

/** M38: where a recurring turn goes after a failed run. Wakes and one-shots have none. */
function nextScheduledRun(job: JobRow): string | null {
  const payload = parseJobPayload<TurnJobPayload>(job);
  if (payload.dailyAt) return nextDailyRun(payload.dailyAt, payload.days).toISOString();
  if (payload.everyMs && payload.everyMs > 0) return nextIntervalRun(job.run_at, payload.everyMs).toISOString();
  return null;
}

/**
 * H20: a give-up error when this run already completed (or started and lost
 * track of) a side-effecting tool call. Calls refused before running do not count.
 */
function giveUpIfSideEffects(db: Database, threadID: string, since: string, message: string): JobGiveUp | null {
  const calls = db
    .query<{ tool_name: string; args: string }, [string, string]>(
      `SELECT tool_name, args FROM tool_calls
       WHERE thread_id = ? AND created_at >= ?
         AND (error IS NULL OR error NOT IN ('approval_rejected', 'approval_expired', 'tool_not_allowed', 'domain_not_allowed'))`,
    )
    .all(threadID, since);
  const acted = calls.find((call) => {
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(call.args) as Record<string, unknown>; } catch { /* treat as no args */ }
    return NON_IDEMPOTENT_TOOLS.has(call.tool_name) || asksWhenClean(call.tool_name, args);
  });
  return acted ? new JobGiveUp(`${message}; not retried because it already ran ${acted.tool_name}`) : null;
}

/**
 * Did the parent thread already read this task's result? `delegate_wait`,
 * `task_status` and `delegate_task` in wait mode all hand the terminal result
 * back inside the parent's own turn. The first two name the task in their
 * arguments; `delegate_task` creates it, so its result names it. The state
 * comes from the result, which the loop may have wrapped as
 * `{ truncated, result }` when it was long.
 */
export function parentAlreadyRead(db: Database, parentThreadID: string, taskID: string): boolean {
  const rows = db
    .query<{ tool_name: string; args: string; result: string | null }, [string]>(
      `SELECT tool_name, args, result FROM tool_calls
       WHERE thread_id = ? AND tool_name IN ('delegate_wait', 'task_status', 'delegate_task') AND ok = 1
       ORDER BY created_at DESC LIMIT 200`,
    )
    .all(parentThreadID);
  return rows.some((row) => {
    const asked = parseObject(row.args);
    const parsed = parseObject(row.result);
    const view = parsed && typeof parsed.result === "object" && parsed.truncated === true ? parseObject(parsed.result) : parsed;
    if (row.tool_name === "delegate_task") {
      // Only waiting returns the result; a call that just queued the work read nothing.
      if (asked?.mode !== "wait" || (view ? view.taskID : /"taskID":"([^"]+)"/.exec(row.result ?? "")?.[1]) !== taskID) return false;
    } else if (asked?.taskID !== taskID) {
      return false;
    }
    // A result cut mid-text no longer parses; its state is still in the part that was kept.
    const state = view ? view.state : /"state":"(\w+)"/.exec(row.result ?? "")?.[1];
    return state === "done" || state === "failed";
  });
}

function parseObject(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string") return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

interface ApprovalBlock {
  /** Why the run was blocked, in words for the job's result. */
  reason: string;
  /** The tools whose calls were refused. */
  tools: string[];
  /** A later call that itself needed approval succeeded: the work may have been done another way. */
  workedAround: boolean;
}

/**
 * S1-13: why a background run could not do its work for want of approval, or
 * null. Reads the gated calls the loop refused this run: the owner denied them
 * (the card's decision is "reject"), or nobody decided before the turn ended or
 * the card expired (`approval_expired`).
 */
function blockedByApproval(db: Database, threadID: string, since: string): ApprovalBlock | null {
  const rows = db
    .query<{ rowid: number; created_at: string; tool_name: string; decision: string | null; error: string }, [string, string]>(
      `SELECT tc.rowid AS rowid, tc.created_at, tc.tool_name, a.decision, tc.error FROM tool_calls tc
       LEFT JOIN approvals a ON a.turn_id = tc.turn_id AND a.call_id = tc.call_id
       WHERE tc.thread_id = ? AND tc.created_at >= ? AND tc.error IN ('approval_rejected', 'approval_expired')
       ORDER BY tc.created_at, tc.rowid`,
    )
    .all(threadID, since);
  const row = rows[0];
  if (!row) return null;
  const reason = row.decision === "reject" ? `the owner denied approval for ${row.tool_name}, so it did not run`
    : row.error === "approval_expired" ? `approval for ${row.tool_name} expired, nobody answered, so it did not run`
    : `approval for ${row.tool_name} was not given before the run ended, so it did not run`;
  const last = rows[rows.length - 1]!;
  // A later call counts only if it has its own approval record: a card the owner
  // answered once or always, or a standing rule that answered it. Deciding that by
  // asking the policy now would let a free write of a new file count, because the
  // file exists by then.
  const after = db
    .query<{ tool_name: string }, [string, string, number]>(
      `SELECT tc.tool_name FROM tool_calls tc
       JOIN approvals a ON a.turn_id = tc.turn_id AND a.call_id = tc.call_id
       WHERE tc.thread_id = ? AND tc.created_at >= ? AND tc.rowid > ?
         AND tc.ok = 1 AND tc.error IS NULL AND tc.result IS NOT NULL
         AND a.status = 'decided' AND (a.decision IN ('once', 'always') OR a.rule_id IS NOT NULL)`,
    )
    .all(threadID, last.created_at, last.rowid);
  return {
    reason,
    tools: [...new Set(rows.map((denied) => denied.tool_name))],
    workedAround: after.length > 0,
  };
}

/** The owner's own channel with this agent: where a background reply belongs. */
function agentChannelID(db: Database, agentID: string): string {
  return canonicalAgentID(agentID) === "ea" ? "main" : ensureDMChannel(db, agentID).id;
}

/** Background turns started today by this agent (wakes excluded: they follow a counted delegation). */
export function backgroundTurnsToday(db: Database, agentID: string): number {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  return db
    .query<{ n: number }, [string, string]>(
      `SELECT COUNT(*) AS n FROM turns
       WHERE agent_id = ? AND started_at >= ?
         AND thread_id IN (SELECT json_extract(payload, '$.threadID') FROM jobs
                           WHERE kind = 'turn' AND json_extract(payload, '$.wakeKey') IS NULL)`,
    )
    .get(agentID, dayStart.toISOString())?.n ?? 0;
}

/** Cost backstop: the reason a bot past its daily background-turn cap must stop, or null. Notifies once a day. */
function dailyCapReached(deps: TurnJobDeps, persona: ResolvedPersona): string | null {
  const cap = Number(process.env.AGNI_MAX_BG_TURNS_PER_DAY || 200);
  if (!Number.isFinite(cap) || cap <= 0) return null;
  if (backgroundTurnsToday(deps.db, persona.id) < cap) return null;
  const key = `${persona.id}:${new Date().toDateString()}`;
  if (!capNotified.has(key)) {
    capNotified.add(key);
    deps.emit({
      type: "notify",
      title: `${persona.name} · background work paused`,
      body: `${persona.name} reached ${cap} background turns today; further background turns are skipped until tomorrow.`,
      sound: false,
    });
  }
  return `daily background-turn cap reached (${cap})`;
}

function firstLine(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return truncate(line, 180) || "(no output)";
}

/**
 * The short summary that belongs in the caller's context. The full result
 * lives in an artifact (DEL-004); the summary is what wakes the parent.
 */
export function summarizeResult(text: string, artifactID?: string, maxChars = RESULT_MAX_CHARS): string {
  const cleaned = tidyText(text);
  if (!cleaned) return "(no output)";
  if (cleaned.length <= maxChars) return cleaned;
  // A cut result says where the whole of it is, inside the same limit.
  // The cut leaves room for the ellipsis and, when there is one, the pointer.
  if (!artifactID) return cutAt(cleaned, maxChars - 1);
  const pointer = `full result: read_artifact ${artifactID}`;
  return `${cutAt(cleaned, maxChars - pointer.length - 2)} ${pointer}`;
}

/** Trim the text and tidy its spacing, keeping line breaks: lists, code and tables stay readable. */
function tidyText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+$/gm, "")
    .replace(/([^\s])[^\S\n]{2,}/g, "$1 ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Cut to at most `max` characters before the ellipsis, at a space or line break when one is near. */
function cutAt(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const at = Math.max(head.lastIndexOf(" "), head.lastIndexOf("\n"));
  return `${at > max * 0.8 ? head.slice(0, at) : head}…`;
}

/** The note the parent agent reads when a delegated task finishes. */
export function buildWakeText(results: Array<{ taskID: string; agentID: string; summary: string; redacted: boolean }>): string {
  const lines = results.map((result) => {
    if (result.redacted) {
      return `- Task ${result.taskID} (${result.agentID}) finished. Its result is private to that agent; open its chat to read it.`;
    }
    return `- Task ${result.taskID} (${result.agentID}) finished: ${peerEnvelope({ from: result.agentID, intent: "result", task: result.taskID }, result.summary)}`;
  });
  return [
    "A delegated task finished. Tell the owner what came of it, in one or two sentences.",
    "If the work is not finished, keep going in the background instead of waiting.",
    "",
    ...lines,
  ].join("\n");
}

/** What a delegated task starts with: what its sender read, or unknown when the job does not say. */
function startTaint(payload: TurnJobPayload): TaintSource[] {
  return payload.taint === undefined ? [unknownTaint("a task whose sender did not say what it had read")] : readTaint(payload.taint);
}

/** A wake is told about finished tasks; if one of them read outside text, so has the bot that reads it. */
function wakeTaint(db: Database, results: TurnJobPayload["results"]): TaintSource[] {
  const out: TaintSource[] = [];
  for (const item of results ?? []) {
    // A result with no taint record reads as tainted.
    if (readTaint(item.taint).length === 0) continue;
    const name = resolvePersona(db, item.agentID)?.name ?? item.agentID;
    out.push({ kind: "peer", label: name.slice(0, 60), tool: "wake", at: nowISO() });
  }
  return out;
}

function buildWakeLogText(results: Array<{ taskID: string; agentID: string; summary: string; redacted: boolean }>): string {
  const lines = results.map((result) => result.redacted
    ? `- Task ${result.taskID} (${result.agentID}) finished. Its result is private to that agent; open its chat to read it.`
    : `- Task ${result.taskID} (${result.agentID}) finished: ${result.summary}`);
  return [
    "A delegated task finished. Tell the owner what came of it, in one or two sentences.",
    "If the work is not finished, keep going in the background instead of waiting.",
    "",
    ...lines,
  ].join("\n");
}

/**
 * Wake the parent agent, once (DEL-006).
 *
 * The claim and the enqueue happen in one transaction, so a crash cannot
 * leave a task claimed but never woken. Several completions for the same
 * parent thread are coalesced into one wake turn.
 */
function wakeParent(deps: TurnJobDeps, taskID: string, summary: string, parentDepth: number): void {
  const task = getTask(deps.db, taskID);
  if (!task) return;
  const parentThreadID = task.parent_thread_id;
  const parentAgentID = task.parent_agent_id;
  if (!parentThreadID || !parentAgentID) return; // nobody to wake
  const owner = task.owner_agent_id ?? "";
  const visibility = owner ? resolvePersona(deps.db, owner)?.visibility ?? MISSING_AGENT_VISIBILITY : DEFAULT_VISIBILITY;
  const visible = redactResultForCaller(summary, owner, parentAgentID, visibility);
  // One wake per parent thread and per request: results of different requests never share a wake, so a wake belongs
  // to one root (what was refused there holds in it) and has the one clock of its own.
  const root = briefRoot(task.brief);
  const wakeKey = `wake:${parentThreadID}:${root ? denialScope(root) : "unrooted"}`;
  const item = {
    taskID: task.id,
    agentID: owner,
    summary: visible.text ?? "",
    redacted: visible.redacted,
    taint: taskTaint(deps.db, task.id),
  };
  claimResultDelivery(deps.db, task.id, () => {
    const existing = findQueuedJobByPayloadKey(deps.db, "turn", wakeKey);
    if (existing) {
      appendJobResult(deps.db, existing.id, item);
      return;
    }
    enqueueJob(deps.db, {
      kind: "turn",
      payload: {
        agentID: parentAgentID,
        threadID: parentThreadID,
        channelID: task.parent_channel_id,
        notify: false,
        inputRole: "system",
        wakeKey,
        depth: parentDepth,
        chainID: briefChainID(task.brief),
        // The wake is part of the request the task came from: what the owner refused there is refused here (S2-07).
        ...briefRoot(task.brief),
        results: [item],
      },
    });
  });
}

function truncate(text: string, max: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

/** DEL-006: tell the clients the task moved. */
function announceTask(deps: TurnJobDeps, taskID: string): void {
  const task = getTask(deps.db, taskID);
  if (!task) return;
  deps.emit({ type: "task.updated", task: taskInfo(task) });
}

/**
 * Run the job's prompt in the task lane: the Plan → Act → Observe loop with
 * tools, the same runner chat uses.
 */
async function runTurn(
  deps: TurnJobDeps,
  payload: TurnJobPayload,
  persona: ResolvedPersona,
  threadID: string,
  conversation: ConversationRow | undefined,
  text: string,
  retry = false,
  jobID?: string,
  jobSlot?: string,
): Promise<{ turnID: string; text: string; stopReason: string; taint: TaintSource[]; endedBy?: "wall_time" }> {
  const controller = new AbortController();
  const delegationTaskID = payload.delegationTaskID?.trim() || null;
  const task = delegationTaskID ? getTask(deps.db, delegationTaskID) : null;
  // S1-12: cancelling the task aborts this turn instead of waiting for it to end.
  const untrack = delegationTaskID ? trackRunningDelegation(deps.db, delegationTaskID, controller) : () => undefined;
  // S1-23: a background reply is posted to the owner's chat with the agent. A
  // delegated child keeps its answer in its own thread; the parent is woken for it.
  const channelID = payload.channelID || (delegationTaskID || payload.peer ? undefined : agentChannelID(deps.db, persona.id));
  try {
    const result = await runTaskTurn(deps.db, deps.router, deps.settings, {
      threadID,
      text,
      persona,
      emit: deps.emit,
      signal: controller.signal,
      conversationID: conversation?.id,
      carrySummary: conversation?.summary ?? null,
      // H23: the depth travels in the payload, so a delegated job does not restart at 1.
      guardrail: { ...rootGuardrail(persona.id, payload.chainID), depth: Math.max(1, Math.trunc(payload.depth ?? 1)) },
      ...(payload.wakeKey ? { wake: true } : {}),
      policy: {
        // The brief's taint rides down; a wake starts with the taint of the results it is told about.
        // undefined says the sender did not say what it had read (a bot that starts from it is tainted); a list, even empty, says it did.
        ...(payload.taint !== undefined || payload.wakeKey ? { taint: [...(payload.taint !== undefined ? readTaint(payload.taint) : []), ...wakeTaint(deps.db, payload.results)] } : {}),
        ...(payload.rootTurnID ? { rootTurnID: payload.rootTurnID, rootJob: payload.rootJob ?? null } : {}),
        // A delegated child is on its parent's clock; a wake, a resumed task and any other job start their own, and a retry keeps its first.
        ...(payload.clockKey ? { clockKey: payload.clockKey } : {}),
        ...(retry ? { keepClock: true } : {}),
        ...(jobSlot ? { jobSlot } : {}),
        jobID: jobID ?? null,
        capabilities: readCapabilities(payload.capabilities),
      },
      facts: payload.facts,
      ...(channelID ? { channelID } : {}),
      ...(payload.inputRole ? { inputRole: payload.inputRole } : {}),
      ...(retry ? { reuseInput: true } : {}),
      ...(payload.peer ? { peer: payload.peer } : {}),
      ...(payload.wakeKey && payload.results ? { inputText: buildWakeLogText(payload.results) } : {}),
      ...(delegationTaskID && task
        ? {
            delegation: {
              taskID: delegationTaskID,
              ownerAgentID: persona.id,
              parentAgentID: task.parent_agent_id,
              parentChannelID: task.parent_channel_id,
            },
          }
        : {}),
    });
    return { turnID: result.turnID, text: result.text, stopReason: result.stopReason, taint: result.taint, ...(result.endedBy ? { endedBy: result.endedBy } : {}) };
  } finally {
    untrack();
  }
}
