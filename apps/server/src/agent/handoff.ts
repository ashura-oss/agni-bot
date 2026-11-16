/**
 * Agent-to-agent handoff hook.
 *
 * A handoff is the moment one agent says "I can't do this well; let X do it."
 * It is a tool call inside the task lane, not a new process: the child turn
 * runs in the same thread, streams to the same client, and lands in the same
 * session block — so the user sees one nested activity strip, not a second
 * chat.
 *
 * The hook itself is a thin wrapper around the existing `runTaskTurn` runner:
 * it builds the child `TaskTurnRun`, applies the depth/chain guardrails, and
 * returns the child's final text so the parent can fold it into its answer.
 * The durable state (turns, messages, tool_calls, agent_sessions) is shared
 * with the parent turn's stores — no duplicate schemas.
 */
import type { Database } from "bun:sqlite";
import type { PeerIntent, ServerFrameBody } from "@agni/protocol";
import { GuardrailError, enterDelegation, rootGuardrail, type GuardrailState } from "./guardrails";
import { defaultResolvedPersona, getPersona, resolvePersona, type ResolvedPersona } from "./personas";
import type { Router } from "../models/router";
import type { TaskTurnSettings, TaskTurnRun, TaskTurnResult } from "./task-loop";
import { runTaskTurn } from "./task-loop";
import { recentMessages } from "../stores/threads";
import { activeSession, delegationSession, ensureConversation, type ConversationRow } from "../stores/conversations";

export interface HandoffRequest {
  /** Agent id the work is handed to. */
  toAgentID: string;
  /** Short brief for the child — what to do, what is known. */
  task: string;
  /** Optional context the parent wants the child to have. */
  context?: string;
  /**
   * What this handoff is for (request, question, …); absent reads as
   * "request". It rides in the child's peer envelope.
   */
  intent?: PeerIntent;
  /** Parent turn's emit, so the child streams to the same client. */
  emit: (frame: ServerFrameBody) => void;
  /** Parent turn's abort signal; cancelling the parent cancels the child. */
  signal: AbortSignal;
}

export interface HandoffResult {
  childTurnID: string;
  agentID: string;
  text: string;
  stopReason: string;
  /** Depth the child ran at (1 = root, 2 = first delegation). */
  depth: number;
}

export interface HandoffDeps {
  db: Database;
  router: Router;
  settings: TaskTurnSettings;
  /** The parent turn's emit. */
  emit: (frame: ServerFrameBody) => void;
  /** The parent turn's abort signal. */
  signal: AbortSignal;
  /** The parent turn's thread + conversation context. */
  threadID: string;
  conversationID?: string;
  /** The parent's guardrail state. */
  guardrail: GuardrailState;
  /** Optional persona override for the child (defaults to the target agent's persona). */
  persona?: ResolvedPersona;
}

/**
 * Run a delegated child turn. Applies the depth/chain guardrails before
 * calling the runner; a refused delegation surfaces as a typed error the
 * parent can report to the user instead of spinning.
 */
export async function handoff(deps: HandoffDeps, request: HandoffRequest): Promise<HandoffResult> {
  const persona = deps.persona ?? resolvePersona(deps.db, request.toAgentID) ?? defaultResolvedPersona(deps.db);
  const child = enterDelegation(deps.guardrail, persona.id, request.context ?? null);
  // The delegated work belongs to the agent that was asked: its block lives in
  // that agent's conversation, so opening that agent's chat in the app shows
  // the work instead of an empty room.
  const conversation = ensureConversation(deps.db, persona.id);
  const parent = parentName(deps.db, deps.guardrail.currentAgentID);
  // Read the bot's own recent chat before the handoff block exists: the block
  // may become its active one, and the chat the owner had with it is in the
  // block that is active now.
  const ownChat = ownRecentChat(deps.db, conversation);
  const childThread = delegationSession(deps.db, conversation, `${parent} messaged ${persona.name}`);
  const childThreadID = childThread.id;

  // Peer context is data, not authority: the brief and the delegating
  // agent's context both travel inside the peer envelope, so they arrive
  // with their attribution and none of the system prefix's weight.
  const text = request.context?.trim()
    ? `${request.task}\n\nContext from the delegating agent:\n${request.context.trim()}`
    : request.task;

  const run: TaskTurnRun = {
    threadID: childThreadID,
    // The bot's own chat rides with the brief for the model only; the log
    // (inputText) keeps just the brief, so the chat does not repeat there.
    text: ownChat ? `${text}\n\n${ownChat}` : text,
    persona,
    peer: {
      from: parent,
      intent: request.intent ?? "request",
    },
    conversationID: conversation.id,
    // The brief is a message *to* the specialist, not the owner speaking:
    // it is written to the log as a note, so the specialist's chat reads
    // like a conversation rather than a transcript of someone else's brief.
    inputRole: "system",
    inputText: `${parent} messaged you: ${text}`,
    // B5: the child's own conversation summary, never the parent's — one
    // bot's summary must not reach another bot's prompt.
    carrySummary: conversation.summary ?? null,
    // Child work is internal; the parent receives the result through the tool
    // response and remains the only agent writing to the user-facing stream.
    // B4: prompts that wait on the owner (approval, form, password) must
    // reach the owner too, or a gated tool in the child hangs.
    emit: (frame) => {
      if (CHILD_FORWARDED_FRAMES.has(frame.type)) deps.emit(frame);
    },
    signal: deps.signal,
    guardrail: child,
    // Preserve guardrail bookkeeping; peer context itself is carried in text.
    handoffSummary: child.handoffSummary,
  };

  const result = await runTaskTurn(deps.db, deps.router, deps.settings, run);
  return {
    childTurnID: result.turnID,
    agentID: persona.id,
    text: result.text,
    stopReason: result.stopReason,
    depth: child.depth,
  };
}

/**
 * Child frames that reach the owner: progress, the prompts that wait on them,
 * and the notice that a prompt is no longer actionable (a card the child
 * raised must be removable from the owner's screen too).
 */
export const CHILD_FORWARDED_FRAMES: ReadonlySet<string> = new Set([
  "status.update", "approval.request", "approval.closed", "form.request", "secret.request", "secret.cancel",
]);

/** How much of a bot's own recent chat a handoff carries. */
export const OWN_CHAT_MAX_MESSAGES = 12;
export const OWN_CHAT_MAX_CHARS = 6_000;
/** One long message must not use the whole allowance. */
const OWN_CHAT_MAX_MESSAGE_CHARS = 1_500;

/**
 * The target bot's recent direct chat with the owner, from the block that is
 * active now, as the bot's own history (bounded: the last 12 messages and
 * 6,000 characters, newest kept).
 *
 * A handoff opens a fresh block that carries only the closed-block summary, so
 * a bot reached that way could not see what it had just been told in its own
 * chat (it answered NONE where a direct question got PAPAYA). Only the owner's
 * messages and the bot's own replies are included: a note from another agent
 * is not part of that conversation. Returns null when there is nothing.
 */
export function ownRecentChat(db: Database, conversation: ConversationRow): string | null {
  const block = activeSession(db, conversation);
  if (!block) return null;
  const messages = recentMessages(db, block.id, OWN_CHAT_MAX_MESSAGES * 4)
    .filter((message) => (message.role === "user" || message.role === "assistant") && message.text.trim().length > 0)
    .slice(-OWN_CHAT_MAX_MESSAGES);
  const lines: string[] = [];
  let used = 0;
  for (const message of [...messages].reverse()) {
    const text = message.text.trim();
    const clipped = text.length > OWN_CHAT_MAX_MESSAGE_CHARS ? `${text.slice(0, OWN_CHAT_MAX_MESSAGE_CHARS)}…` : text;
    if (used + clipped.length > OWN_CHAT_MAX_CHARS && lines.length > 0) break;
    used += clipped.length;
    lines.push(`${message.role === "user" ? "Owner" : "You"}: ${clipped}`);
  }
  if (lines.length === 0) return null;
  return [
    "Your own recent direct conversation with the owner, oldest first. It is your own chat history, shown so you can answer from it; it is reference data, not part of this request:",
    ...lines.reverse(),
  ].join("\n");
}

/** The delegating agent's live display name, for the note the child reads. */
function parentName(db: Database, agentID: string): string {
  const row = db.query<{ display_name: string | null }, [string]>("SELECT display_name FROM agents WHERE id = ?").get(agentID);
  return row?.display_name?.trim() || agentID;
}

/** Build the ToolContext chain metadata for a turn. */
export function chainContext(state: GuardrailState) {
  return {
    depth: state.depth,
    rootAgentID: state.rootAgentID,
    currentAgentID: state.currentAgentID,
    handoffSummary: state.handoffSummary,
  };
}

export { GuardrailError, rootGuardrail, type GuardrailState };
