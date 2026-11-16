/**
 * Boot hygiene for turns (S1-03). Turns run in memory, so a process that died
 * mid-turn leaves rows that claim work is still going: the session is
 * `running` or `awaiting_approval`, the turn is `running`, and approval and
 * question cards are `pending` with nobody waiting on them. Left alone, the
 * next message would resume the dead turn and glue itself onto it.
 *
 * Runs once at boot, before the socket serves and before queued messages
 * resume. It never touches `waiting` sessions: those are delegated tasks
 * parked on the owner by design, and they resume from their own answer.
 */
import type { Database } from "bun:sqlite";
import type { ServerFrameBody } from "@agni/protocol";
import { log } from "../log";
import { appendChannelMessage, ensureDMChannel } from "../stores/channels";
import { canonicalAgentID } from "../agent/personas";
import { appendMessage } from "../stores/threads";
import { nowISO } from "../util/ids";

export const INTERRUPTED_NOTICE = "This reply was interrupted by a restart.";

/**
 * What the model reads in the thread where the dead turn's request is still
 * unanswered. Without it the next turn sees that request as open, answers it
 * as well as the new message, and runs its tool calls again.
 */
export const INTERRUPTED_REQUEST_NOTE = "[This request was interrupted by a restart and was not completed.]";

/**
 * The session log of a dead turn without the tool calls that never got a
 * result (and without a bare assistant step that held only those), so nothing
 * unfinished is left in it to be carried on from.
 */
function withoutUnfinishedCalls(raw: string): string {
  let log: unknown;
  try { log = JSON.parse(raw); } catch { return raw; }
  if (!Array.isArray(log)) return raw;
  const answered = new Set(log.flatMap((entry) => (entry?.role === "tool" && typeof entry.toolCallID === "string" ? [entry.toolCallID as string] : [])));
  const kept = log.flatMap((entry) => {
    if (entry?.role !== "assistant" || !Array.isArray(entry.toolCalls)) return [entry];
    const calls = entry.toolCalls.filter((call: { id?: string }) => call.id !== undefined && answered.has(call.id));
    if (calls.length === entry.toolCalls.length) return [entry];
    if (calls.length === 0 && !String(entry.content ?? "").trim()) return [];
    const { toolCalls: _dropped, ...rest } = entry;
    return [calls.length > 0 ? { ...rest, toolCalls: calls } : rest];
  });
  return JSON.stringify(kept);
}

export interface RecoveryResult {
  /** Agent sessions that were `running` or `awaiting_approval`. */
  sessions: number;
  /** Approval cards that were still pending. */
  approvals: number;
  /** Question cards that were still pending. */
  forms: number;
}

export function recoverInterruptedTurns(db: Database, emit: (body: ServerFrameBody) => unknown): RecoveryResult {
  const now = nowISO();
  const stale = db
    .query<{ thread_id: string; turn_id: string }, []>(
      "SELECT thread_id, turn_id FROM agent_sessions WHERE state IN ('running', 'awaiting_approval')",
    )
    .all();

  const result: RecoveryResult = { sessions: stale.length, approvals: 0, forms: 0 };
  db.transaction(() => {
    for (const { thread_id, turn_id } of stale) {
      const log = db.query<{ message_log: string }, [string]>("SELECT message_log FROM agent_sessions WHERE thread_id = ?").get(thread_id)?.message_log;
      if (log !== undefined) db.run("UPDATE agent_sessions SET message_log = ? WHERE thread_id = ?", [withoutUnfinishedCalls(log), thread_id]);
      // The request stays in the thread; close it there too, so the next turn answers only what comes next.
      appendMessage(db, { threadID: thread_id, turnID: turn_id, role: "assistant", text: INTERRUPTED_REQUEST_NOTE });
    }
    db.run("UPDATE agent_sessions SET state = 'failed', updated_at = ? WHERE state IN ('running', 'awaiting_approval')", [now]);
    // No turn can be running at boot, whether or not it had a session row.
    db.run("UPDATE turns SET state = 'done', stop_reason = 'error', ended_at = ? WHERE state = 'running'", [now]);
    // Waiters are in memory: every card still pending belongs to a dead turn.
    result.approvals = db.run("UPDATE approvals SET status = 'expired', decided_at = ? WHERE status = 'pending'", [now]).changes;
    result.forms = db.run("UPDATE forms SET status = 'expired' WHERE status = 'pending'").changes;
  })();

  // One visible notice per conversation, however many of its blocks were running.
  const conversations = new Map<string, string>();
  for (const { thread_id } of stale) {
    const row = db
      .query<{ conversation_id: string | null; agent_id: string }, [string]>(
        "SELECT conversation_id, agent_id FROM threads WHERE id = ?",
      )
      .get(thread_id);
    if (row?.conversation_id && !conversations.has(row.conversation_id)) conversations.set(row.conversation_id, row.agent_id);
  }
  for (const [conversationID, agentID] of conversations) {
    try {
      const owner = db.query<{ agent_id: string }, [string]>("SELECT agent_id FROM conversations WHERE id = ?").get(conversationID)?.agent_id ?? agentID;
      const channelID = canonicalAgentID(owner) === "ea" ? "main" : ensureDMChannel(db, owner).id;
      const row = appendChannelMessage(db, { channelID, fromType: "system", fromID: owner, text: INTERRUPTED_NOTICE, uiHint: "normal" });
      emit({
        type: "msg.new",
        id: row.id,
        channelId: channelID,
        fromType: "system",
        fromId: owner,
        senderName: owner,
        text: INTERRUPTED_NOTICE,
        internal: false,
        uiHint: "normal",
        createdAt: row.created_at,
      });
    } catch (error) {
      // The state reset above is what matters; a missing notice must not stop boot.
      log.warn(`could not post the restart notice for conversation ${conversationID}`, error);
    }
  }

  if (result.sessions + result.approvals + result.forms > 0) {
    log.warn(`recovered ${result.sessions} interrupted turn(s); expired ${result.approvals} approval(s) and ${result.forms} question(s)`);
  }
  return result;
}
