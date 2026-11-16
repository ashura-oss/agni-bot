/**
 * The durable transcript behind `conversation.history`: the thread messages
 * across session blocks, merged with the channel messages the app renders.
 */
import type { Database } from "bun:sqlite";
import type { AttachmentInfo } from "@agni/protocol";
import { attachmentInfo } from "../attachments/store";
import { canonicalAgentID } from "../agent/personas";
import { conversationTranscript, getConversation } from "../stores/conversations";

export interface HistoryMessage {
  id: string;
  role: string;
  text: string;
  createdAt: string;
  turnID?: string;
  sessionID?: string;
  senderName?: string;
  senderColor?: string;
  uiHint?: string;
  attachments?: AttachmentInfo[];
  toAgentId?: string;
  /** How the turn behind an assistant message ended; absent while it runs and for other roles. */
  stopReason?: string;
}

/**
 * How each of these turns ended, in one query per few hundred. A turn that is
 * still running has no stop reason yet and is left out.
 */
export function stopReasonsByTurn(db: Database, turnIDs: Iterable<string>): Map<string, string> {
  const ids = [...new Set(turnIDs)];
  const reasons = new Map<string, string>();
  for (let start = 0; start < ids.length; start += 400) {
    const chunk = ids.slice(start, start + 400);
    const rows = db
      .query<{ id: string; stop_reason: string }, string[]>(
        `SELECT id, stop_reason FROM turns WHERE stop_reason IS NOT NULL AND id IN (${chunk.map(() => "?").join(",")})`,
      )
      .all(...chunk);
    for (const row of rows) reasons.set(row.id, row.stop_reason);
  }
  return reasons;
}

/** Two copies of one message (thread row and channel row) closer than this are one message. */
const DUPLICATE_WINDOW_MS = 30_000;

interface AttachmentRow {
  id: string; device_id: string; name: string; mime_type: string; size: number;
  kind: AttachmentInfo["kind"]; path: string; extracted_text: string | null;
}

/** Attachments for many messages in a few queries, not one per message. */
function attachmentsByMessage(db: Database, messageIDs: string[]): Map<string, AttachmentInfo[]> {
  const byMessage = new Map<string, AttachmentInfo[]>();
  for (let start = 0; start < messageIDs.length; start += 400) {
    const chunk = messageIDs.slice(start, start + 400);
    const rows = db
      .query<AttachmentRow & { message_id: string }, string[]>(
        `SELECT a.*, m.message_id FROM message_attachments m JOIN attachments a ON a.id = m.attachment_id
         WHERE m.message_id IN (${chunk.map(() => "?").join(",")}) ORDER BY m.message_id, m.position`,
      )
      .all(...chunk);
    for (const row of rows) {
      const list = byMessage.get(row.message_id) ?? [];
      list.push(attachmentInfo(row));
      byMessage.set(row.message_id, list);
    }
  }
  return byMessage;
}

interface ChannelRow {
  id: string; text: string; created_at: string; turn_id: string | null;
  from_id: string; from_type: string; sender_name: string | null; sender_color: string | null;
  device_name: string | null; ui_hint: string | null; sender_onboarded: number | null;
  to_agent_id: string | null;
}

/**
 * The newest `limit` messages of a conversation, oldest first. The limit is
 * applied in SQL on both sources, so a long history costs one bounded read.
 */
export function buildConversationHistory(db: Database, conversationID: string, limit: number): HistoryMessage[] {
  const conversation = getConversation(db, conversationID)!;
  // System-role thread rows are what the server told a turn (job instructions,
  // wake text), not the owner's conversation. The channel's own system notices
  // (an interrupted reply, a delegation note) are shown, and come in below.
  const threadRows = conversationTranscript(db, conversationID, limit, { excludeSystem: true });
  // `agni` is the legacy id for the same assistant as `ea`; both read and
  // write the main channel, so normalize before choosing the surface.
  const channelID = canonicalAgentID(conversation.agent_id) === "ea" ? "main" : `dm:${conversation.agent_id}`;
  const channelRows = db.query<ChannelRow, [string, number]>(`SELECT * FROM (
      SELECT cm.id, cm.text, cm.created_at, cm.turn_id, cm.from_id, cm.from_type,
        a.display_name AS sender_name, a.avatar_color AS sender_color, d.name AS device_name, cm.ui_hint,
        a.onboarded AS sender_onboarded, cm.to_agent_id, cm.rowid AS rid
      FROM channel_messages cm
      LEFT JOIN agents a ON a.id = cm.from_id
      LEFT JOIN devices d ON d.id = cm.from_id
      WHERE cm.channel_id = ? AND cm.internal = 0 ORDER BY cm.created_at DESC, cm.rowid DESC LIMIT ?
    ) ORDER BY created_at, rid`).all(channelID, limit);

  const attachments = attachmentsByMessage(db, [...threadRows.map((row) => row.id), ...channelRows.map((row) => row.id)]);
  const stopReasons = stopReasonsByTurn(db, [...threadRows, ...channelRows].flatMap((row) => {
    const turnID = "turnID" in row ? row.turnID : row.turn_id;
    return turnID ? [turnID] : [];
  }));
  const attachmentsOf = (id: string): AttachmentInfo[] => attachments.get(id) ?? [];

  const messages: HistoryMessage[] = threadRows.map((message) => ({
    id: message.id,
    role: message.role,
    text: message.text,
    attachments: attachmentsOf(message.id),
    createdAt: message.created_at,
    sessionID: message.sessionID,
    ...(message.role === "assistant" && message.turnID && stopReasons.has(message.turnID) ? { stopReason: stopReasons.get(message.turnID)! } : {}),
  }));
  // A message stored on both the thread and the channel is one message. Two rows are the same message when
  // they agree on role, attachments and text AND pair up one-to-one: a thread row is paired with at most one
  // channel row, the one from the same turn when both name it, else the nearest in time. Text alone never
  // decides, so a question asked twice stays two messages.
  const keyOf = (role: string, text: string, files: AttachmentInfo[]): string => `${role}\u0000${files.map((file) => file.id).join(",")}\u0000${text}`;
  const seen = new Map<string, number[]>();
  const turnOfThreadRow = threadRows.map((row) => row.turnID ?? null);
  const paired = new Set<number>();
  messages.forEach((message, index) => {
    const key = keyOf(message.role, message.text, message.attachments ?? []);
    seen.set(key, [...(seen.get(key) ?? []), index]);
  });

  for (const row of channelRows) {
    // Role comes from `from_type`, not from comparing `from_id` to "user":
    // a client message stores the *device* id, which made reloaded user
    // messages render as agent messages named after the device.
    const role = row.from_type === "user" ? "user" : row.from_type === "system" ? "system" : "assistant";
    // The name prompt is settled once the agent has a name: the field must
    // not come back every time the thread is loaded.
    const uiHint =
      row.ui_hint === "onboarding_name_prompt" && row.sender_onboarded === 1
        ? "onboarding_completed"
        : row.ui_hint ?? undefined;
    const files = attachmentsOf(row.id);
    const messageData: HistoryMessage = {
      attachments: files,
      id: row.id, role, text: row.text, createdAt: row.created_at, turnID: row.turn_id ?? undefined,
      senderName: role === "user"
        ? row.device_name ?? "You"
        : row.sender_name ?? row.from_id,
      senderColor: row.sender_color ?? undefined, uiHint,
      // A handoff notice names the agent it is about, so the client can
      // make that name a link to that agent's chat.
      ...(row.to_agent_id ? { toAgentId: row.to_agent_id } : {}),
      ...(role === "assistant" && row.turn_id && stopReasons.has(row.turn_id) ? { stopReason: stopReasons.get(row.turn_id)! } : {}),
    };
    const key = keyOf(role, row.text, files);
    const candidates = (seen.get(key) ?? []).filter((index) => index < threadRows.length && !paired.has(index));
    let best: { index: number; sameTurn: boolean; gap: number } | undefined;
    for (const index of candidates) {
      const gap = Math.abs(Date.parse(messages[index]!.createdAt) - Date.parse(row.created_at));
      if (!(gap < DUPLICATE_WINDOW_MS)) continue;
      // Two rows that both name a turn and name different ones are two messages, however close and alike.
      const threadTurn = turnOfThreadRow[index];
      if (row.turn_id !== null && threadTurn !== null && threadTurn !== undefined && threadTurn !== row.turn_id) continue;
      const sameTurn = row.turn_id !== null && threadTurn === row.turn_id;
      if (!best || (sameTurn && !best.sameTurn) || (sameTurn === best.sameTurn && gap < best.gap)) best = { index, sameTurn, gap };
    }
    if (best) {
      paired.add(best.index);
      messages[best.index] = { ...messages[best.index]!, ...messageData };
    } else {
      messages.push(messageData);
      seen.set(key, [...(seen.get(key) ?? []), messages.length - 1]);
    }
  }
  // Oldest first; rows with the same time keep the order they were read in.
  messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  // Both sources were limited; after merging, keep the newest `limit`.
  return messages.length > limit ? messages.slice(messages.length - limit) : messages;
}
