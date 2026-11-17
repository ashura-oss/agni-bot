import type { Database } from "bun:sqlite";
import type { ServerFrameBody } from "@agni/protocol";
import type { Router } from "../models/router";
import { runTaskTurn, type TaskTurnSettings } from "../agent/task-loop";
import { canonicalAgentID, resolvePersona, type ResolvedPersona } from "../agent/personas";
import { rootGuardrail } from "../agent/guardrails";
import { backgroundSession, ensureConversation, getConversation } from "../stores/conversations";
import { appendChannelMessage, ensureDMChannel } from "../stores/channels";
import { getThread } from "../stores/threads";
import { getJob, setJobEnabled } from "../stores/jobs";
import { newID, nowISO } from "../util/ids";
import { runPreflight } from "./preflight";
import { buildRoutinePrompt, parseRoutineState, stripRoutineState } from "./prompt";
import { getRoutine, recordRun, updateRoutineState } from "../stores/routines";
import { ROUTINE_LIMITS, type Routine, type RoutineRun } from "./types";

// No read_file/grep/glob: an unattended run must not read files or
// search the mailbox for something to exfiltrate (bug.md C1, M16).
export const ROUTINE_TOOL_ALLOWLIST = [
  "memory_search", "transcript_search", "links_search", "tasks_list",
  "web_search", "web_fetch", "mail_read", "recall_fact",
  "skills_list", "skills_load", "skills_resource",
];

/** Mailbox and calendar reads only for a routine with no web egress: what it reads has nowhere to go. */
export function routineTools(routine: Pick<Routine, "allowedDomains">): string[] {
  return routine.allowedDomains.length === 0 ? [...ROUTINE_TOOL_ALLOWLIST, "mail_search", "calendar_list"] : ROUTINE_TOOL_ALLOWLIST;
}

export interface RoutineRunDeps {
  db: Database;
  router: Router;
  settings: TaskTurnSettings;
  emit: (frame: ServerFrameBody) => void;
}

function startRun(routineID: string): RoutineRun {
  return {
    id: newID("run"), routineID, startedAt: nowISO(), finishedAt: null,
    outcome: "failed", tokens: 0, summary: null, toolTrace: null, error: null,
  };
}

function record(deps: RoutineRunDeps, run: RoutineRun): RoutineRun {
  run.finishedAt = nowISO();
  recordRun(deps.db, run);
  return run;
}

function updateStreak(deps: RoutineRunDeps, routine: Routine, succeeded: boolean): number {
  // Re-read: pause, resume or run-now may have changed the streak mid-run.
  const current = getRoutine(deps.db, routine.id);
  if (!current) return 0;
  const successStreak = succeeded ? current.successStreak + 1 : 0;
  const failureStreak = succeeded ? 0 : current.failureStreak + 1;
  updateRoutineState(deps.db, routine.id, { successStreak, failureStreak });
  return failureStreak;
}

function maybePause(deps: RoutineRunDeps, routine: Routine, failureStreak: number): void {
  if (failureStreak < ROUTINE_LIMITS.autoPauseAfterFailures) return;
  // Notify only on the enabled -> paused transition, not on every failure while paused.
  const wasEnabled = getJob(deps.db, routine.jobID)?.enabled === 1;
  setJobEnabled(deps.db, routine.jobID, false);
  if (!wasEnabled) return;
  deps.emit({ type: "notify", title: `Routine ${routine.name} paused`, body: `Routine ${routine.name} paused after ${ROUTINE_LIMITS.autoPauseAfterFailures} failures`, sound: false, ...(routine.threadID ? { threadID: routine.threadID } : {}) });
}

/** Execute one scheduled routine, keeping its report in the bot's conversation. */
export async function executeRoutine(deps: RoutineRunDeps, routine: Routine, agentID: string = routine.agentID): Promise<RoutineRun> {
  const run = startRun(routine.id);
  let preflight: { changed: boolean; hash: string };
  try {
    preflight = await runPreflight(routine.preflight, deps.db, routine.lastStateHash, deps.settings.mailAccounts);
  } catch (error) {
    run.error = error instanceof Error ? error.message : String(error);
    maybePause(deps, routine, updateStreak(deps, routine, false));
    return record(deps, run);
  }
  if (!preflight.changed) {
    run.outcome = "skipped_no_delta";
    run.tokens = 0;
    return record(deps, run);
  }

  const persona = resolvePersona(deps.db, agentID);
  if (!persona) {
    run.error = `routine agent not found: ${agentID}`;
    maybePause(deps, routine, updateStreak(deps, routine, false));
    return record(deps, run);
  }
  let threadID = routine.threadID;
  let conversation = threadID ? (() => {
    const thread = getThread(deps.db, threadID!);
    return thread?.conversation_id ? getConversation(deps.db, thread.conversation_id) : undefined;
  })() : undefined;
  if (threadID && !getThread(deps.db, threadID)) threadID = null;
  if (!threadID) {
    conversation = ensureConversation(deps.db, persona.id);
    threadID = backgroundSession(deps.db, conversation, routine.name).id;
    updateRoutineState(deps.db, routine.id, { threadID });
  }

  const signal = AbortSignal.timeout(routine.maxExecutionMs);
  try {
    const result = await runTaskTurn(deps.db, deps.router, deps.settings, {
      threadID,
      text: buildRoutinePrompt(routine),
      // The instruction (and the saved state in it) is the daemon's, not something the owner
      // typed: it is logged as a system row, so history never shows it as the owner's
      // message.
      hideInput: true,
      // The saved state in the instruction is data from earlier runs, which can carry text an
      // attacker planted: the turn is gated like peer input, and only the routine's own prompt
      // may shape its topic anchor and retrieval. Nothing streams: the reply ends with the state block.
      untrustedInput: true,
      queryText: routine.prompt,
      persona,
      emit: deps.emit,
      signal,
      conversationID: conversation?.id,
      carrySummary: conversation?.summary ?? null,
      guardrail: rootGuardrail(persona.id),
      toolAllowlist: routineTools(routine),
      maxTokens: routine.maxTokens,
      allowedDomains: routine.allowedDomains,
    });
    // The state block is for the next run, not for the owner: it is cut from the stored
    // reply, the run line and the notification, and read from the full text below.
    const visibleText = stripRoutineState(result.text);
    hideRoutineState(deps.db, result.turnID);
    run.summary = visibleText.slice(0, 200) || null;
    run.tokens = turnTokens(deps.db, result.turnID);
    const toolRows = deps.db.query("SELECT tool_name, args FROM tool_calls WHERE turn_id = ? ORDER BY created_at").all(result.turnID) as Array<{ tool_name: string; args: string }>;
    run.toolTrace = JSON.stringify(toolRows.map((row) => ({ name: row.tool_name, args: safeJson(row.args) })));
    if (signal.aborted || result.stopReason === "timeout" || result.stopReason === "cancelled") {
      run.outcome = "timed_out";
      run.error = "routine execution timed out";
      const failureStreak = updateStreak(deps, routine, false);
      maybePause(deps, routine, failureStreak);
    } else if (result.stopReason !== "end") {
      run.outcome = result.stopReason === "budget" ? "budget_exceeded" : "failed";
      run.error = `task turn ended with ${result.stopReason}`;
      const failureStreak = updateStreak(deps, routine, false);
      maybePause(deps, routine, failureStreak);
    } else {
      const parsed = parseRoutineState(result.text);
      run.outcome = "ran";
      if (!parsed.found) run.error = "Warning: reply did not include a valid stateContext JSON block; previous state was kept.";
      else updateRoutineState(deps.db, routine.id, { stateContext: parsed.value });
      updateRoutineState(deps.db, routine.id, { lastStateHash: preflight.hash });
      updateStreak(deps, routine, true);
    }
    // A routine that has nothing for the owner says so with this marker and stays silent.
    if (/^\s*NOTHING_TO_REPORT\b/.test(result.text)) return record(deps, run);
    if (run.outcome === "ran") postFinalReply(deps, persona, result.turnID);
    deps.emit({ type: "notify", title: `${persona.name} · ${routine.name}`, body: run.summary ?? "Routine completed", sound: false, threadID, agentId: persona.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    run.outcome = signal.aborted ? "timed_out" : /budget/i.test(message) ? "budget_exceeded" : "failed";
    run.error = message;
    maybePause(deps, routine, updateStreak(deps, routine, false));
  }
  return record(deps, run);
}

/**
 * Tokens a turn used. The per-call ledger (S2-10) writes rows with no turn id, and the per-turn ledger row it
 * replaces carried one, so both are read: the ledger rows that name the turn, and the totals the turn row
 * itself keeps when it ends. The larger is the count, so neither shape reads as zero.
 */
function turnTokens(db: Database, turnID: string): number {
  const ledger = db.query<{ tokens: number }, [string]>("SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens FROM usage_ledger WHERE turn_id = ?").get(turnID)?.tokens ?? 0;
  const own = db.query<{ tokens: number }, [string]>("SELECT COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) AS tokens FROM turns WHERE id = ?").get(turnID)?.tokens ?? 0;
  return Math.max(ledger, own);
}

/**
 * The routine's final reply, as the thread keeps it (state block cut), goes to the owner's channel with that
 * bot as a `msg.new`, so it shows without a reload. It is marked peer-influenced: it was written from saved
 * state and pages an outsider can write. The channel is given to the post, not to the turn, so the turn does
 * not stream and does not read the channel's history.
 */
function postFinalReply(deps: RoutineRunDeps, persona: Pick<ResolvedPersona, "id" | "name">, turnID: string): void {
  const last = deps.db.query<{ text: string }, [string]>("SELECT text FROM messages WHERE turn_id = ? AND role = 'assistant' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(turnID);
  const text = last?.text.trim();
  if (!text) return;
  const channelID = canonicalAgentID(persona.id) === "ea" ? "main" : ensureDMChannel(deps.db, persona.id).id;
  const row = appendChannelMessage(deps.db, { channelID, fromType: "agent", fromID: persona.id, text, turnID, uiHint: "normal", peerInfluenced: true });
  const agent = deps.db.query<{ display_name: string | null; avatar_color: string | null }, [string]>("SELECT display_name, avatar_color FROM agents WHERE id = ?").get(persona.id);
  deps.emit({
    type: "msg.new", id: row.id, channelId: channelID, fromType: "agent", fromId: persona.id,
    senderName: agent?.display_name ?? persona.name, ...(agent?.avatar_color ? { senderColor: agent.avatar_color } : {}),
    text, internal: false, uiHint: "normal", createdAt: row.created_at,
  });
}

/**
 * What the turn's last reply looks like once stored: the state block (and its label) is cut so a reload
 * shows only what the routine had to say; a reply that is NOTHING_TO_REPORT is not stored at all; a reply
 * that was nothing but state says the run completed rather than vanishing. Earlier replies are left as written.
 */
export function hideRoutineState(db: Database, turnID: string): void {
  const last = db.query<{ id: string; text: string }, [string]>("SELECT id, text FROM messages WHERE turn_id = ? AND role = 'assistant' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(turnID);
  if (!last) return;
  const visible = stripRoutineState(last.text);
  if (/^\s*NOTHING_TO_REPORT\b/.test(visible)) { db.run("DELETE FROM messages WHERE id = ?", [last.id]); return; }
  if (!visible) { db.run("UPDATE messages SET text = ? WHERE id = ?", [STATE_ONLY_REPLY, last.id]); return; }
  if (visible !== last.text.trim()) db.run("UPDATE messages SET text = ? WHERE id = ?", [visible, last.id]);
}

/** What stays of a last reply that held nothing but the state block. */
const STATE_ONLY_REPLY = "Routine completed; state saved.";

function safeJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return value; }
}
