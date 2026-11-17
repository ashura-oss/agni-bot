/**
 * Which turns this browser saw end badly. History rows do not say how their
 * turn ended, so without this a "Response didn't finish" mark vanishes on
 * reload. It is a small local memory, not a record: the daemon is the source
 * of truth, and an entry only re-draws a marker.
 */
import type { ChatMessage } from "@agni/client";

const KEY = "dev.agni.stops";
const LIMIT = 300;

export function loadStops(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [turnID, reason] of Object.entries(parsed)) if (typeof reason === "string") out[turnID] = reason;
    return out;
  } catch {
    return {};
  }
}

export function rememberStop(turnID: string, reason: string): void {
  try {
    const stops = loadStops();
    delete stops[turnID];
    stops[turnID] = reason;
    const keys = Object.keys(stops);
    for (const key of keys.slice(0, Math.max(0, keys.length - LIMIT))) delete stops[key];
    localStorage.setItem(KEY, JSON.stringify(stops));
  } catch {
    // Storage blocked or full: the marker is a nicety, not a record.
  }
}

/**
 * A reply stopped before it said anything leaves no row in the daemon's
 * history, so there is no message for `Conversation.restoreStops` to re-mark.
 * Its question is there, though, carrying the same turn id. Put an empty
 * stopped reply under each such question, so "No reply — stopped" survives a
 * reload. A turn that has an answer, or that this chat does not hold, adds
 * nothing. Pure: it returns a new list.
 */
export function insertStoppedTurns(messages: readonly ChatMessage[], stops: Readonly<Record<string, string>>): ChatMessage[] {
  const answered = new Set<string>();
  for (const message of messages) if (message.role === "assistant" && message.turnID) answered.add(message.turnID);
  const out: ChatMessage[] = [];
  for (const message of messages) {
    out.push(message);
    const turnID = message.turnID;
    const reason = turnID ? stops[turnID] : undefined;
    if (message.role !== "user" || !turnID || reason === undefined || reason === "end" || reason === "needs_input" || answered.has(turnID)) continue;
    answered.add(turnID);
    out.push({
      id: `stopped_${turnID}`,
      role: "assistant",
      text: "",
      createdAt: message.createdAt,
      turnID,
      agentID: message.agentID,
      sessionID: message.sessionID,
      state: { kind: "stopped", reason },
      usage: null,
      tools: [],
      isLocalEcho: false,
      senderName: null,
      senderColor: null,
      toAgentId: null,
      uiHint: null,
      taskId: null,
      questionId: null,
      isBackground: false,
      isContinuation: false,
      stopKnown: true,
    });
  }
  return out;
}
