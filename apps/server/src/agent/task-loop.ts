import { linkAttachments, messageAttachments, withAttachmentContent } from "../attachments/store";
/** Bounded Plan → Act → Observe runner for the task lane: every chat turn and
 * every background job runs here. */
import type { Database } from "bun:sqlite";
import type { PeerIntent, ServerFrameBody, StopReason } from "@agni/protocol";
import { peerEnvelope, stripPeerTags } from "./peer-message";
import { ApprovalBroker, waitForApprovalDecision } from "./approval-broker";
import { gateToolCall } from "./tool-gate";
import { abortReasonOf } from "./abort-reason";
import { markRun, saveTaskTaint, type Carried } from "../policy/carry";
import { createRunContext, isTainted, packTaint, readTaint, unknownTaint } from "../policy/context";
import { narrowCapabilities } from "../policy/narrowing";
import { ownerWordsOf, recordOwnerWords } from "../policy/owner-words";
import { decide } from "../policy/engine";
import { budgetRunKey } from "../policy/budget";
import { budgetStopFromRefusal, budgetStopMessage, pauseStopMessage, wallTimeStopMessage } from "../policy/budget-messages";
import { policyHooks } from "../policy/hooks";
import { policyFor, taintFrom } from "../policy/metadata";
import type { Principal, RunContext, RunStop, TaintSource } from "../policy/types";
import type { ToolMeta } from "../policy/tool-meta";
import { redact } from "../util/redact";
import { groupTaint } from "./group";
import { ABORTED_MID_CALL, closeRequest, isClosureNote, toolErrorCode } from "./closure";
import { FormBroker } from "./form-broker";
import type { Persona, ResolvedPersona } from "./personas";
import type { ChatMessage, ToolCall } from "../models/client";
import { RouteRefusedError, Router, RouterBusyError, RouterError } from "../models/router";
import { appendMessage, createTurn, finishTurn, recentMessages, titleThreadFromFirstMessage, touchThread } from "../stores/threads";
import { newID, nowISO } from "../util/ids";
import { buildTaskToolRegistry, deferredToolHints, deferredTools, registerLoadTools, taskToolSpecs } from "../tools/task-registry";
import { teamRoster } from "./personas";
import { deriveAnchor } from "../context/compiler";
import { LONG_TOOL_RESULT_JSON_CHARS } from "../tools/artifact-tool";
import { criticReview } from "./critic";
import { SCRATCH_TOOLS } from "../tools/scratch-tool";
import { registerTurnTools } from "../tools/turn-tools";
import { recallFact } from "../tools/facts";
import { asksAboutPast, ownerLedger, retrieveFacts, rewriteForRetrieval, previousBlockTail, TURN_EMBED_TIMEOUT_MS } from "./retrieval";
import type { MemoryHit } from "../stores/agent-memories";
import { embedderConfig, type EmbedderConfig } from "./embeddings";
import { isSmallTalk } from "./gate";
import { buildDelegationPrefix } from "./prompts";
import { getThread } from "../stores/threads";
import { listSummaries } from "../stores/summaries";
import { appendChannelMessage, getChannelSummary } from "../stores/channels";
import { compactChannelHistory } from "./compactor";
import { GuardrailError, MAX_DEPTH, checkWallTime, enterDelegation, rootGuardrail, stepGuardrail, type GuardrailState } from "./guardrails";
import type { MailAccountResolver } from "../plugins/credentials";
import { mcpApprovalNote } from "../plugins/mcp";
import { domainAllowed } from "../routines/egress";
import { log } from "../log";
import { TurnTimer } from "./turn-timer";
import { holdForOwner, startClock, startJobClock } from "./run-clock";
import { expireApprovalForCall, expirePendingForTurn, ownerWaitMsFor } from "./pending-cards";

export interface TaskTurnSettings {
  firstTokenTimeoutMs: number;
  turnTimeoutMs: number;
  /**
   * Mailboxes the owner connected in Settings → Plugins. The mail tools read
   * them from there, so a connected mailbox is actually usable.
   */
  mailAccounts?: MailAccountResolver;
  /** plugins.json, for the Calendar and Drive OAuth tokens. */
  pluginsPath?: string;
  /**
   * ASM-004: the confidence floor for automatic retrieval. Below it,
   * nothing is injected.
   */
  minRecallScore?: number;
  /** The longest an approval card or owner question is waited on (default 10 minutes). */
  ownerWaitMs?: number;
}
export interface TaskTurnRun {
  attachmentIDs?: string[];
  turnID?: string;
  threadID: string;
  text: string;
  persona: ResolvedPersona;
  emit: (frame: ServerFrameBody) => void;
  signal: AbortSignal;
  /** Conversation model (v2): the conversation the turn belongs to. */
  conversationID?: string;
  /** Carried summary of the session blocks that closed before this one. */
  carrySummary?: string | null;
  /** Agent-to-agent: summary the delegating agent passed in. */
  handoffSummary?: string | null;
  /**
   * The peer who wrote this request, when it did not come from the owner.
   * The model text is then wrapped in the server-built envelope, so peer
   * text travels as attributed data, not authority. The durable log row
   * keeps the plain text either way.
   */
  peer?: { from: string; intent: PeerIntent; task?: string };
  /** Agent-to-agent: root turn/depth guardrail state. */
  guardrail?: GuardrailState;
  /** When false, bounded durable facts are not injected into the prefix. */
  facts?: boolean;
  /** The durable channel that owns this turn, when using the channel model. */
  channelID?: string;
  /**
   * Phase 4: a group-channel turn. The block (recent room messages, already
   * filtered by visibility) opens the model input; the durable log keeps the
   * owner's plain text. The group's shared summary is not used and the room
   * is not compacted, so no bot's words reach another bot unfiltered.
   */
  groupContext?: string;
  /**
   * How the request is written to the durable log. A delegated brief is a
   * system note ("Vision messaged you: …"), not the owner speaking.
   */
  inputRole?: "user" | "system";
  /**
   * Log the request as a system row so the owner's history does not show it.
   * Only the log row changes: the turn's role, and how it is trusted, do not
   * (see `untrustedInput` for that).
   */
  hideInput?: boolean;
  /**
   * The input carries data the owner did not write (a routine's saved state,
   * results fetched on an earlier run). The turn is gated like peer input:
   * tools that peer input may not use are refused, posts are marked
   * peer-influenced, nothing is compacted from it, and nothing streams (a
   * routine's reply ends with its saved-state block, which an open chat must
   * not show). Unlike peer input it may use `queryText` for the topic anchor
   * and retrieval.
   */
  untrustedInput?: boolean;
  /** With `untrustedInput`: the part of the input that is the owner's own words, the only text that may shape the anchor and retrieval. */
  queryText?: string;
  /** A retried job: reuse the input row it already wrote instead of appending it again (H20). */
  reuseInput?: boolean;
  /** The text written to the durable log (defaults to the request text). */
  inputText?: string;
  /**
   * DEL-006: this turn is a delegated task. The task can ask the owner a
   * question and wait for the answer, so the turn knows which task it is and
   * where the question should be asked.
   */
  delegation?: {
    taskID: string;
    /** The agent doing the work. */
    ownerAgentID: string;
    /** The agent that delegated, and gets the answer. */
    parentAgentID: string | null;
    /** The channel the owner is watching. */
    parentChannelID: string | null;
  };
  /** This turn tells a parent bot that work it delegated has finished (a wake). */
  wake?: boolean;
  /**
   * Where the run sits in the policy's picture: what the work that started it handed it (`Carried`, `policy/carry.ts`): the outside
   * text it starts with, the root it belongs to (so an owner's "no" earlier in the chain still holds), the tools it is cut down to,
   * and whether it is the owner's own work. Server-set.
   */
  policy?: Partial<Carried> & {
    /** The job's `run_at` when this try started: it names the run's clock when the run has none yet (a retry keeps the one its job records). */
    jobSlot?: string;
    jobID?: string | null;
  };
  /** Restrict task tools to this list, intersected with the persona's tools. */
  toolAllowlist?: string[];
  /** Optional output-token budget for bounded background work such as routines. */
  maxTokens?: number;
  /** Optional domain allowlist for web tools. */
  allowedDomains?: string[];
}
export interface TaskTurnResult {
  turnID: string; text: string; stopReason: StopReason;
  /** The outside text this run read, for the bot that handed it the work. */
  taint: TaintSource[];
  /** Set when the root job's time limit ended the run: retrying it would only start a fresh clock. */
  endedBy?: "wall_time";
}

/**
 * No per-turn tool-call or output-token budget (owner decision, 2026-10-27). A
 * turn is bounded by the turn timeout, the chain step guardrail, the loop
 * guards (duplicates, no progress, off-road), and two per-step limits: at
 * most 25 tool calls from one model response, and an output-token ceiling on
 * every model call.
 */
const MAX_PROMPT_CHARS = 40_000;
const MAX_TOOL_RESULT_CHARS = 4_000;
/**
 * Tools whose whole point is a long text: a delegated result, a handoff
 * answer, an artifact page. Their strings pass up to 4,000 characters intact
 * and the result as a whole gets room for the fields around that text.
 */
const LONG_RESULT_TOOLS: ReadonlySet<string> = new Set(["read_artifact", "task_status", "delegate_wait", "delegate_task", "handoff"]);
const LONG_RESULT_TEXT_CHARS = 4_000;
const MAX_LONG_TOOL_RESULT_CHARS = LONG_TOOL_RESULT_JSON_CHARS;
const MAX_HISTORY_MESSAGES = 16;
/** The owner's own messages are kept longer than tool output; a longer one is cut with a notice. */
const MAX_USER_MESSAGE_CHARS = 48_000;
/** Tool calls run from one model response; the rest are skipped, each with a result. */
const MAX_TOOL_CALLS_PER_RESPONSE = 25;
/** Output tokens asked of the model on every chat step, unless AGNI_MAX_OUTPUT_TOKENS says otherwise. */
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;

function maxOutputTokens(): number {
  const configured = Number(process.env.AGNI_MAX_OUTPUT_TOKENS);
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_OUTPUT_TOKENS;
}

/**
 * The assistant runs *inside* the app, but it is not the app's developer.
 *
 * The failure this catches: the owner asks for something the tools cannot do
 * ("a widget", "a fire board", "Slack"), and the model decides to go read the
 * app's own source to find out how to build it. Fifteen `cat` calls later it
 * reports a limit failure, and the owner learns nothing except that something
 * took too long.
 *
 * Looking at the workspace is on-road when the owner asked for code, and for
 * the coding specialist. Otherwise a turn that only *looks* is off-road, and
 * the honest answer is either "do it with the tools you have" or "say plainly
 * that you have none".
 */
const WORKSPACE_TOOLS = new Set(["bash", "read_file", "grep", "glob", "skills_list", "skills_load", "skills_resource"]);
/**
 * Tools that look at the app's own state rather than at the owner's world.
 * They are not progress: a turn that calls these and nothing else is still
 * looking, not doing.
 */
const INSIDE_TOOLS = new Set(["job_list", "recall_fact", "memory_search", "links_search", "tasks_list"]);
/** Workspace-only steps before the turn is told to act — or to say it cannot. */
const OFF_ROAD_NUDGE_AT = 2;
const OFF_ROAD_STOP_AT = 5;
/**
 * Paths that mean "the app's own source or state" rather than the owner's
 * own files. The shell tool's working directory is the app's checkout, so a
 * relative path is the app by definition — these are the cases that name it
 * without an absolute path.
 */
const APP_SOURCE_MARKERS = [
  "apps/", "packages/", "tools/", "docs/", "data/", "scripts/", "src/", "tests/", ".github/",
  ".agni", "AGENTS.md", "README.md", "package.json", "bun.lock", "tsconfig", "sqlite",
  "agents.json", "plugins.json", "providers.json", ".env",
];
/** A request that is about changing the code — then reading the code is the work. */
const CODE_REQUEST = /\b(refactor|implement|pull request|commit|unit test|compile|debug|stack ?trace|the code ?base|the repo(?:sitory)?|read the code|fix the bug|patch (?:it|the|this)|write a script|change the code)\b/i;
/** A request that is about *reading* files — then reading them is the work. */
const FILE_REQUEST = /\b(read|open|show|summari[sz]e|compare|explain|grep|search|list)\b[^.?!]{0,40}\b(file|files|doc|docs|documentation|code|repo|log|logs|config|readme|changelog)\b/i;

/** A final answer longer than this is split for the channel. */
const LONG_ANSWER_CHARS = 1_200;

const activeThreads = new Set<string>();

/**
 * The tail of the block before this one, verbatim (ROL-006).
 */
function openedTail(db: Database, threadID: string): string[] {
  const raw = getThread(db, threadID)?.opened_tail;
  if (!raw) return [];
  return raw.split("\n").filter((line) => line.trim().length > 0);
}

/** The embedder for this turn: none for small talk, and a short timeout. */
export function turnEmbedder(text: string, config = embedderConfig()): EmbedderConfig | null {
  if (!config || isSmallTalk(text)) return null;
  return { ...config, timeoutMs: Math.min(config.timeoutMs, TURN_EMBED_TIMEOUT_MS) };
}

/**
 * Recalled memories for the prompt: skip what the pinned facts already say,
 * and tag each with its id and date so the model can `expand` it.
 */
export function recallLines(hits: MemoryHit[], pinnedIDs: Set<string>): string[] {
  return hits
    .filter((hit) => !pinnedIDs.has(hit.row.id))
    .map((hit) => `[memory ${hit.row.id}, ${hit.row.updated_at.slice(0, 10)}] ${hit.row.content}`);
}

/**
 * Split a long answer for the channel: the first paragraph becomes a
 * progress bubble, the rest stays the answer. The words are the model's —
 * only the presentation changes.
 */
export function splitForChannel(text: string): Array<{ text: string; hint: "progress" | "normal" }> {
  const paragraphs = text.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  if (paragraphs.length < 2) return [{ text, hint: "normal" }];
  const first = paragraphs[0]!;
  const rest = paragraphs.slice(1).join("\n\n");
  if (first.length > LONG_ANSWER_CHARS) return [{ text, hint: "normal" }];
  return [{ text: first, hint: "progress" }, { text: rest, hint: "normal" }];
}

/** Is a turn running in this thread right now? A wake waits for it. */
export function isThreadActive(threadID: string): boolean {
  return activeThreads.has(threadID);
}

/** The turn running in a thread, so an interrupt can stop it. */
const runningTurns = new Map<string, { turnID: string; controller: AbortController; cancelReason?: string }>();
/** The cancel reason of a turn the owner's next message took over from: that request is not closed, the message continues it. */
const SUPERSEDED = "the owner sent a new message";

/**
 * Stop the turn running in a thread. The owner interrupting with a new
 * message is the common case: the old turn is cancelled and the new one
 * takes over, instead of the new message bouncing off a busy thread.
 */
export function cancelThreadTurn(threadID: string, reason = "interrupted"): boolean {
  const running = runningTurns.get(threadID);
  if (!running) return false;
  running.cancelReason = reason;
  try {
    running.controller.abort();
  } catch {
    // Aborting twice is not an error worth raising.
  }
  return true;
}

/** Wait (briefly) for a thread to be free again. */
async function waitForThreadIdle(threadID: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (activeThreads.has(threadID) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Tools that write user-scope memory (DEL-007 read-only agents cannot use them). */
const MEMORY_WRITE_TOOLS = new Set(["remember_fact", "memory_write", "forget_fact"]);

export async function runTaskTurn(db: Database, router: Router, settings: TaskTurnSettings, run: TaskTurnRun): Promise<TaskTurnResult> {
  const { threadID } = run;
  if (activeThreads.has(threadID)) {
    // The owner interrupted: the running turn stops and this one takes
    // over. Waiting for the old turn to unwind keeps the two from writing
    // into the same block at the same time.
    cancelThreadTurn(threadID, SUPERSEDED);
    await waitForThreadIdle(threadID);
    if (activeThreads.has(threadID)) {
      throw new Error("a task turn is already active or awaiting approval for this thread");
    }
  }
  // H19: claim the thread before any await so a second caller cannot slip in.
  activeThreads.add(threadID);
  try {
    return await runTaskTurnLocked(db, router, settings, run);
  } finally {
    activeThreads.delete(threadID);
  }
}

async function runTaskTurnLocked(db: Database, router: Router, settings: TaskTurnSettings, run: TaskTurnRun): Promise<TaskTurnResult> {
  const { threadID, persona } = run;
  const now = nowISO();
  const existing = db.query("SELECT turn_id, state, message_log, summary, step_count, token_count, taint FROM agent_sessions WHERE thread_id = ?").get(threadID) as { turn_id: string; state: string; message_log: string; summary: string | null; step_count: number; token_count: number; taint: string | null } | null;
  // A session parked on a question is resumed, not restarted: the answer
  // continues the same conversation.
  const recovering =
    existing?.state === "running" || existing?.state === "awaiting_approval" || existing?.state === "waiting";
  // A resumed session runs under the caller's turn ID: that is the ID the
  // owner's Stop is registered under. Without one (a job), the old ID stays.
  const turnID = run.turnID ?? (recovering ? existing.turn_id : newID("trn"));
  let messages: ChatMessage[];
  let stepCount = recovering ? existing.step_count : 0;
  let tokenCount = recovering ? existing.token_count : 0;
  if (recovering) {
    messages = parseSessionMessages(existing.message_log);
    // The dead turn's cards are dead too: expire them and tell clients, before
    // recovery rejects the calls that were waiting on them.
    expirePendingForTurn(db, existing.turn_id, "expired", run.emit);
    // The dead turn's tool calls and approvals are filed under its own ID.
    recoverToolResults(db, existing.turn_id, messages);
    if (turnID !== existing.turn_id) {
      createTurn(db, { id: turnID, threadID, agentID: persona.id });
      db.run("UPDATE turns SET state = 'done', stop_reason = 'error', ended_at = ? WHERE id = ? AND state = 'running'", [nowISO(), existing.turn_id]);
    }
  } else {
    createTurn(db, { id: turnID, threadID, agentID: persona.id });
    messages = recentMessages(db, threadID, MAX_HISTORY_MESSAGES)
      // A closure note is stored as a system row (the owner's history leaves it out) but the model reads it as its own words.
      .filter((message) => message.role === "user" || message.role === "assistant" || isClosureNote(message.role, message.text, message.kind))
      .map((message) => ({ role: (message.role === "system" ? "assistant" : message.role) as "user" | "assistant", content: message.text, attachmentIDs: messageAttachments(db, message.id).map((file) => file.id) }));
  }
  const inputRole = run.inputRole ?? "user";
  const inputText = run.inputText ?? run.text;
  // The failed attempt may have left its own assistant output after the input (e.g. "This turn failed"),
  // so the input row is the last `inputRole` row, provided everything after it is that same turn's.
  const tail = run.reuseInput && !recovering ? recentMessages(db, threadID, 8) : [];
  const at = tail.findLastIndex((message) => message.role === inputRole);
  const previous = at >= 0 && tail.slice(at).every((message) => message.turn_id === tail[at]!.turn_id) ? tail[at] : undefined;
  const reused = previous?.role === inputRole && previous.text === inputText;
  // The reused row and its turn's output are history; the model gets the input below instead.
  if (reused) messages.splice(Math.max(0, messages.length - tail.slice(at).filter((m) => m.role === "user" || m.role === "assistant").length));
  const inputMessage = reused ? previous : appendMessage(db, { threadID, turnID, role: run.hideInput ? "system" : inputRole, text: inputText });
  if (!reused && run.attachmentIDs?.length) linkAttachments(db, inputMessage.id, run.attachmentIDs);
  titleThreadFromFirstMessage(db, threadID, run.text);
  // Peer-originated input (a brief, a handoff, a completion wake) must not shape
  // the system prefix. The topic anchor and the retrieval rewrite therefore read
  // only the history from before this input, and never the input's own text.
  const peerSourced = Boolean(run.peer) || run.inputRole === "system" || Boolean(run.delegation);
  // Tool gating, post marking and compaction treat untrusted input like peer input.
  const peerInput = peerSourced || Boolean(run.untrustedInput);
  // The text that may shape the anchor and retrieval: none for peer input, only the owner's own part for untrusted input.
  const queryText: string | null = peerSourced ? null : run.untrustedInput ? (run.queryText ?? null) : run.text;
  const priorHistory = messages.slice();
  // The model sees peer-written text inside the envelope; the durable log
  // row (above) keeps the plain text so the UI stays readable.
  messages.push({
    role: "user",
    content: run.peer
      ? peerEnvelope(run.peer, run.text)
      : run.groupContext ? `${run.groupContext}\n\nThe owner now says:\n${run.text}` : run.text,
    attachmentIDs: run.attachmentIDs,
  });
  run.emit({
    type: "turn.start",
    turnID,
    threadID,
    agentID: persona.id,
    ...(run.conversationID ? { conversationID: run.conversationID } : {}),
  });
  // PR 6: the owner can see what the agent is doing without asking.
  run.emit({ type: "agent.presence", agentId: persona.id, state: "working" });

  let summary: string | null = existing?.summary ?? null;
  const registry = buildTaskToolRegistry(db, settings.mailAccounts, settings.pluginsPath);
  const mcpNames = registry.list().map((tool) => tool.name).filter((name) => name.startsWith("mcp_"));
  // DEL-007: a read-only agent still reads user memory but cannot write it.
  const memoryTools = persona.memoryScope === "read"
    ? persona.tools.filter((tool) => !MEMORY_WRITE_TOOLS.has(tool)).flatMap((tool) => (tool === "mcp_*" ? mcpNames : [tool]))
    : persona.tools.flatMap((tool) => (tool === "mcp_*" ? mcpNames : [tool]));
  // Universal tools: `say` gives every agent a way to post progress as
  // separate messages; `run_privileged` is only meaningful next to `bash`.
  // `ask` puts a question to the owner — every agent may do that. A draft
  // only makes sense to an agent that can send the mail.
  const ownTools = run.toolAllowlist
    ? [...new Set(run.toolAllowlist.filter((name) => memoryTools.includes(name)))]
    : [...new Set([
      ...memoryTools,
      "say",
      "ask",
      ...(memoryTools.includes("bash") ? ["run_privileged"] : []),
      ...(memoryTools.includes("mail_send") ? ["draft_email"] : []),
    ])];
  // S2-06: a bot another bot started (a handoff, a delegated task) may call only what its own persona, the grant and
  // its parent could call. The parent's set rides in `run.policy.capabilities`; none readable means the inert tools only.
  const startedByBot = Boolean(run.peer || run.delegation);
  // A job a narrowed run scheduled fires with the tools of the run that asked: it is cut down by the same rule, each time it fires.
  const narrowedRun = startedByBot || run.policy?.narrowed === true;
  const parentCapabilities = run.policy?.capabilities ?? undefined;
  // A routine's domain list, or the one a run handed down (a handoff's child, a job a run with a list scheduled).
  const allowedDomains = run.allowedDomains ?? run.policy?.allowedDomains;
  const narrowedTools = narrowedRun ? [...narrowCapabilities(ownTools, parentCapabilities)] : ownTools;
  const effectiveTools = run.toolAllowlist
    ? narrowedTools
    // A delegated task's bots share its scratchpad: the task's own notes, not the parent's reach. Kept only when the parent could be read.
    : [...new Set([...(run.delegation && parentCapabilities !== undefined ? SCRATCH_TOOLS : []), ...narrowedTools])];
  // Most turns have no generated-token ceiling. Scheduled routines may set an
  // explicit per-run cap so their own cost bound survives the shared loop.
  const tokenLimit = run.maxTokens === undefined ? null : Math.max(1, run.maxTokens);
  // Agent-to-agent guardrails: root turn is depth 1; a delegated child turn
  // inherits the parent's state via run.guardrail. Facts ride in the prefix.
  let guardrail = run.guardrail ?? rootGuardrail(persona.id);
  // Sorted so an update to one fact does not reshuffle the cached prefix.
  const factRows = run.facts === false ? [] : recallFact(db, { limit: 6, callerAgentID: persona.id }).facts;
  const facts = factRows.map((row) => row.fact).sort();
  const channelSummary = run.channelID && run.groupContext === undefined ? getChannelSummary(db, run.channelID)?.summary : null;
  // ASM-002: a short, always-present note of the current topic. It holds the
  // latest question, so the compiler places it after the per-block slots.
  const anchor = deriveAnchor({
    carrySummary: [run.carrySummary, channelSummary].filter(Boolean).join("\n\n") || null,
    history: priorHistory,
    userText: queryText ?? "",
  });
  // ASM-003/004/006: what this turn needs, retrieved rather than carried.
  // The query is rewritten when the message points back, the search is
  // hybrid, and when nothing good enough comes back the tail of the
  // previous block is used instead of a wider, worse search.
  const rewritten = rewriteForRetrieval(queryText ?? "", { anchor, history: priorHistory });
  // Peer input never drives retrieval: a search on a brief's own words could
  // pull stored peer text back into the system prefix as recall.
  const retrieved = queryText === null ? null : await retrieveFacts(db, {
    query: rewritten.query,
    callerAgentID: persona.id,
    limit: 6,
    minScore: settings.minRecallScore,
    embedder: turnEmbedder(queryText ?? ""),
  });
  const recall = recallLines(retrieved?.hits ?? [], new Set(factRows.map((row) => row.id)));
  const previousTail = openedTail(db, threadID);
  // A block that opened with the old tail already carries those turns.
  if ((!retrieved || retrieved.belowThreshold) && previousTail.length === 0) {
    recall.push(...previousBlockTail(db, { conversationID: run.conversationID ?? null, threadID }));
  }
  const broker = new ApprovalBroker({
    db,
    emit: (frame) => run.emit(frame as ServerFrameBody),
    waitForDecision: (requestID, signal) => waitForApprovalDecision(db, requestID, signal),
    // An MCP connector's own claim about a tool rides with the card as information.
    approvalNote: mcpApprovalNote,
  });
  const controller = new AbortController();
  let timedOut = false;
  // The time limit's clock: a delegated child is measured on its parent's; any other run starts one of its own: one for each
  // scheduled run of a job (its retry keeps the first try's start, so it does not get a new 30 minutes), else this turn's.
  let clockKey = run.policy?.clockKey;
  if (clockKey === undefined) {
    if (run.policy?.jobID) {
      clockKey = startJobClock(db, run.policy.jobID, run.policy.jobSlot ?? new Date().toISOString());
    } else {
      clockKey = turnID;
      startClock(db, clockKey);
    }
  }
  // The turn's clock stops while a call waits on the owner (an approval card
  // or a question), and so does the run's time limit (the wait is written down
  // against its clock). It is created here so the form broker can hold it, and
  // started below once the prompt is built.
  const timer = new TurnTimer(settings.turnTimeoutMs, () => { timedOut = true; controller.abort(); });
  const holdForOwnerWait = (): (() => void) => holdForOwner(db, clockKey, timer);
  const formBroker = new FormBroker({
    db,
    emit: (body) => run.emit(body),
    hold: holdForOwnerWait,
    ownerWaitMs: settings.ownerWaitMs,
  });
  db.run(
    `INSERT INTO agent_sessions (thread_id, turn_id, state, message_log, summary, step_count, token_count, max_steps, max_tokens, created_at, updated_at)
     VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET turn_id=excluded.turn_id, state='running', message_log=excluded.message_log,
       summary=excluded.summary, step_count=excluded.step_count, token_count=excluded.token_count,
       max_steps=excluded.max_steps, max_tokens=excluded.max_tokens, updated_at=excluded.updated_at`,
    // 0 = no limit; the columns predate removing the budgets.
    [threadID, turnID, redact(JSON.stringify(messages)), summary, stepCount, tokenCount, 0, 0, now, now],
  );

  runningTurns.set(threadID, { turnID, controller });
  let needsInput = false;
  registerTurnTools(registry, {
    db, router, settings, emit: run.emit, signal: controller.signal, threadID, turnID,
    channelID: run.channelID, conversationID: run.conversationID, persona, guardrail, formBroker,
    review: criticReview(db, router, settings.firstTokenTimeoutMs, persona),
    delegation: run.delegation,
    onNeedsInput: () => { needsInput = true; },
  });
  // Large toolsets send core schemas only; the rest are listed by name and
  // loaded on demand. Computed after per-turn registration so those tools have descriptions.
  const deferred = deferredTools(registry, effectiveTools);
  const loadedTools = new Set<string>();
  if (deferred.length > 0) registerLoadTools(registry, deferred, loadedTools);
  const callableTools = deferred.length > 0 ? [...effectiveTools, "load_tools"] : effectiveTools;
  // S2-03: who is running and what outside text it has read. Every tool call is judged against it.
  const principal = principalOf(run);
  const ownersChatTurn = principal.kind === "owner" && (run.policy?.jobID ?? null) === null;
  const runCtx = createRunContext({
    db, bot: persona.id, botName: persona.name, threadID, turnID,
    jobID: run.policy?.jobID ?? null,
    // A delegated child shares its parent's root (which may be a chat turn, not a job); any other job is its own root.
    rootJob: run.policy?.rootTurnID ? (run.policy.rootJob ?? null) : (run.policy?.jobID ?? null),
    rootTurnID: run.policy?.rootTurnID ?? turnID,
    ...(run.policy?.denialRoot ? { denialRoot: run.policy.denialRoot } : {}),
    clockKey,
    principal,
    capabilities: callableTools,
    ...(narrowedRun ? { narrowed: true } : {}),
    ...(run.policy?.ownerOnly !== undefined ? { ownerOnly: run.policy.ownerOnly } : {}),
    registry,
    isUnloaded: (name) => deferred.includes(name) && !loadedTools.has(name),
    // The owner's own words, for "send only where the owner said": what the owner typed in this thread (kept in its
    // own table), this message when the owner sent it, and the owner's part of a routine. Never the thread's rows or a
    // session's log: a peer's brief, a routine's prompt, a group block, a wake and the model's own words are in those.
    ownerText: [
      ...(principal.kind === "owner" || principal.kind === "job" || principal.kind === "wake" ? ownerWordsOf(db, threadID) : []),
      ...(principal.kind === "owner" ? [run.text] : []),
      ...(run.queryText ? [run.queryText] : []),
    ],
    unattended: Boolean(run.untrustedInput) && !peerSourced,
    allowedDomains,
    taint: [
      ...(run.policy?.taint ?? []),
      // A run another bot started is tainted unless the sender said it had read nothing outside (an empty list).
      ...(principal.kind === "peer" && run.policy?.taint === undefined ? [unknownTaint(`a brief from ${run.peer?.from ?? "another bot"}, which did not say what it had read`)] : []),
      // A session that comes back from a restart, or from a question it asked the owner, has read what it had read, or something unknown
      // if nothing was saved. That includes the history source: a resumed session may have been started by a job or a wake, and the
      // owner's answer does not say who started it, so the run stays marked.
      ...(recovering ? restoredTaint(existing?.taint ?? null) : []),
      // A new run in a thread reads what the runs before it wrote there. If the last of them had read outside text (or left no readable
      // record of it), the history holds words written under that text's influence. The owner's own chat turn is exempt: the owner is
      // there to see what is said, and what they ask for is their own. Every other run (a job's fire, a wake, a bot's brief) is not, and
      // that includes a fire of a job the owner made: it runs as the owner, but the owner is not there when it fires.
      ...(!recovering && !ownersChatTurn ? historyTaint(existing) : []),
      ...(principal.kind === "routine" ? [{ kind: "routine" as const, label: "saved routine state", at: nowISO() }] : []),
      ...(run.attachmentIDs?.length ? [{ kind: "attachment" as const, label: attachmentLabel(db, inputMessage.id), at: nowISO() }] : []),
      ...(run.groupContext !== undefined && run.channelID ? groupTaint(db, run.channelID, persona.id) : []),
    ],
  });
  // What this run reads is saved with its session (and its task) the moment it is read: a restart or a crash cannot lose it.
  // The owner's own chat turn is not marked by the history, but the record it leaves is: the words that made it tainted are still in the
  // thread, and the next run that is not the owner's own turn (a job's fire) reads this record. A clean turn must not wash it off.
  const carriedHistory = ownersChatTurn && !recovering ? historyTaint(existing) : [];
  const saveTaint = (sources: readonly TaintSource[]): void => {
    try {
      const record = carriedHistory.length > 0 && !sources.some((source) => source.kind === "history") ? [...sources, ...carriedHistory] : sources;
      db.run("UPDATE agent_sessions SET taint = ? WHERE thread_id = ? AND turn_id = ?", [JSON.stringify(record), threadID, turnID]);
      if (run.delegation?.taskID) saveTaskTaint(db, run.delegation.taskID, sources);
    } catch (error) {
      log.warn(`turn ${turnID}: could not save what the run has read: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  saveTaint(runCtx.taint.sources);
  runCtx.onTaint = saveTaint;
  if (principal.kind === "owner") recordOwnerWords(db, threadID, run.text);
  const delegationPrefix = buildDelegationPrefix({
    persona,
    facts,
    // carrySummary is the conversation's own summary. Peer context travels in
    // the user message inside the envelope, never through this prefix.
    carrySummary: [run.carrySummary, channelSummary].filter(Boolean).join("\n\n") || null,
    depth: guardrail.depth,
    maxDepth: MAX_DEPTH,
    toolHints: deferredToolHints(registry, deferred),
    anchor,
    // ASM-004: what this turn needs, retrieved rather than carried.
    recall,
    // ROL-006: the new block opens with the last turns of the old one, so
    // the boundary does not lose the stretch the summary has not caught up
    // with.
    previousTail,
    // CMP-001: the day and epoch summaries, when this conversation has them.
    // Epoch summaries only when the owner asks about the past: they are the
    // widest view, and most turns do not need it.
    rollups: run.conversationID
      ? [
        ...(queryText !== null && asksAboutPast(queryText)
          ? listSummaries(db, { conversationID: run.conversationID, level: "epoch", limit: 2 }).map((summary) => summary.text)
          : []),
        ...listSummaries(db, { conversationID: run.conversationID, level: "day", limit: 3 }).map((summary) => summary.text),
      ]
      : [],
    ledger: ownerLedger(db),
    // Only an agent that can actually hand off needs to know the roster.
    team: persona.tools.includes("handoff") ? teamRoster(db, { exclude: persona.id }) : [],
  });
  timer.start();
  const abort = (): void => controller.abort();
  run.signal.addEventListener("abort", abort, { once: true });
  // The last thing the agent said, for the turn result. Each utterance has
  // already been published as its own message.
  let answerText = "";
  let stopReason: StopReason = "end";
  // The policy ended the run: the owner's switch, the spend caps, or too many tries at something refused.
  let runStop: RunStop | null = null;
  let cancelReason: string | undefined;
  // Every step's usage is summed: each step re-sends the prompt, and the ledger must show what the turn cost.
  let usage: TurnUsage | undefined;
  // Duplicate-step guard: toolName + args signature -> last step it ran on.
  // Exact repeats within the same turn are skipped so the model can't spin.
  const recentCalls = new Map<string, number>();
  const DUPLICATE_WINDOW = 3;
  // If the model keeps taking steps that achieve nothing, stop.
  const MAX_NONTEXT_STEPS = 10;
  let consecutiveNonTextSteps = 0;
  // Workspace-only steps in a turn, and whether the turn ever did anything
  // for the owner. Reading the app's source is not progress.
  let offRoadSteps = 0;
  let offRoadNudged = false;
  let acted = false;
  // PR 6: did the agent narrate with `say` during this turn?
  let saidSomething = false;
  const offRoadGuard = !persona.id.startsWith("coder") && !CODE_REQUEST.test(run.text) && !FILE_REQUEST.test(run.text);
  let activeStepText = "";
  // An answer cut at the output ceiling is continued; the pieces so far, and how often.
  let cutOffText = "";
  let continuations = 0;
  const MAX_CONTINUATIONS = 2;
  const CONTINUE_AFTER_CUT = "Your last reply was cut off at the output limit. Continue exactly where it stopped, without repeating anything.";
  // Every step streams live. A step that ends in tool calls was narration,
  // which stays in the model's context: `reset` clears it from the bubble.
  const emitToken = (delta: string, reset?: true): void => {
    if (!peerInput) run.emit({ type: "token", turnID, threadID, delta, ...(reset ? { reset } : {}) });
  };
  const publish = (text: string, uiHint: "normal" | "progress" = "normal"): void => {
    if (text.trim().length === 0) return;
    const displayText = stripPeerTags(text);
    appendMessage(db, { threadID, turnID, role: "assistant", text: displayText });
    if (!run.channelID) return;
    const row = appendChannelMessage(db, {
      channelID: run.channelID, fromType: "agent", fromID: persona.id, text: displayText, turnID, uiHint, peerInfluenced: peerInput,
    });
    // A bot that reads this room carries what this run read (S2-06).
    if (isTainted(runCtx)) db.run("UPDATE channel_messages SET tainted = 1 WHERE id = ?", [row.id]);
    const agent = db.query<{ display_name: string; avatar_color: string }, [string]>(
      "SELECT display_name, avatar_color FROM agents WHERE id = ?",
    ).get(persona.id);
    run.emit({
      type: "msg.new", id: row.id, channelId: run.channelID, fromType: "agent", fromId: persona.id,
      senderName: agent?.display_name ?? persona.name, senderColor: agent?.avatar_color,
      text: displayText, internal: false, uiHint, createdAt: row.created_at,
    });
  };
  try {
    while (true) {
      if (controller.signal.aborted) { stopReason = timedOut ? "timeout" : "cancelled"; break; }
      // The owner's switch and the spend caps hold at every step, before another model call is paid for.
      const halted = haltedBeforeStep(runCtx);
      if (halted) { runStop = halted; break; }
      // Root turn/depth guardrail: refuse a chain that has spun past its budget
      // before spending another model call on it.
      guardrail = stepGuardrail(guardrail, guardrail.depth > 1);
      ({ messages, summary } = compact(messages, summary));
      persistSession(db, threadID, turnID, "running", messages, summary, stepCount, tokenCount);
      const requestMessages: ChatMessage[] = [
        { role: "system", content: delegationPrefix },
        ...(summary ? [{ role: "system" as const, content: `Conversation summary (untrusted context): ${summary}` }] : []),
        ...messages,
      ];
      activeStepText = "";
      // Allowlist order is kept so the tool prefix stays stable across steps.
      const tools = taskToolSpecs(registry, callableTools.filter((name) => !deferred.includes(name) || loadedTools.has(name)), "static");
      const stepMessages = await withAttachmentContent(db, requestMessages);
      const routeStep = (maxTokens: number | undefined) => router.route({
        // Who this call is for, so the ledger counts it once under the right bot, job and root.
        purpose: "chat", kind: "turn", agentID: persona.id,
        ...(runCtx.jobID ? { jobID: runCtx.jobID } : {}),
        ...(runCtx.rootJob ? { rootJobID: runCtx.rootJob } : {}),
        messages: stepMessages,
        signal: controller.signal,
        firstTokenTimeoutMs: settings.firstTokenTimeoutMs,
        tools,
        toolChoice: tools.length ? "auto" : "none",
        preferredModel: persona.model,
        ...(maxTokens === undefined ? {} : { maxTokens }),
        onDelta: (delta: string) => {
          activeStepText += delta;
          emitToken(delta);
        },
      });
      // Every step has an output ceiling, so one runaway response cannot run on unbounded.
      // A budgeted turn gets the same ceiling, or what is left of its budget if that is less.
      const stepMaxTokens = tokenLimit === null ? maxOutputTokens() : Math.max(1, Math.min(maxOutputTokens(), tokenLimit - tokenCount));
      let result: Awaited<ReturnType<typeof routeStep>>;
      try {
        result = await routeStep(stepMaxTokens);
      } catch (error) {
        // A model whose own output limit is lower than ours says so with a 400
        // naming max_tokens. That step runs once more without the ceiling.
        if (!rejectsMaxTokens(error) || controller.signal.aborted) throw error;
        log.warn(`turn ${turnID}: a provider rejected max_tokens=${stepMaxTokens}; retrying the step without it`);
        activeStepText = "";
        result = await routeStep(undefined);
      }
      const streamedText = activeStepText;
      activeStepText = "";
      // Counted for the record (the debugger shows it), not enforced.
      tokenCount += result.outputTokens ?? estimateTokens(result.text + JSON.stringify(result.toolCalls ?? []));
      usage = addUsage(usage, result);
      if (tokenLimit !== null && tokenCount >= tokenLimit) {
        stopReason = "budget";
        answerText = "This run reached its output-token limit before it could finish.";
        messages.push({ role: "assistant", content: answerText });
        publish(answerText);
        break;
      }
      if (!result.toolCalls?.length && result.finishReason === "length") {
        // Cut at the output ceiling: not a finished answer. Carry on where it stopped, a couple of times at most.
        cutOffText += result.text;
        messages.push(assistantMessage(result.text, result.reasoning));
        if (continuations < MAX_CONTINUATIONS) {
          continuations += 1;
          messages.push({ role: "user", content: CONTINUE_AFTER_CUT });
          continue;
        }
        stopReason = "budget";
        answerText = `${cutOffText}

[The reply was cut off at the output limit and is not complete.]`;
        publish(answerText);
        break;
      }
      if (!result.toolCalls?.length) {
        answerText = cutOffText + result.text;
        messages.push(assistantMessage(result.text, result.reasoning));
        consecutiveNonTextSteps = 0;
        publish(answerText);
        break;
      }

      if (streamedText) emitToken("", true);
      messages.push({ role: "assistant", content: result.text, toolCalls: result.toolCalls, ...(result.reasoning ? { reasoning: result.reasoning } : {}), ...(result.responseItems ? { responseItems: result.responseItems } : {}) });
      // The narration that introduced these tools is not a message. The model
      // keeps it, the owner sees the tools' activity and the `say` updates.
      persistSession(db, threadID, turnID, "running", messages, summary, stepCount, tokenCount);
      let stepProgressed = false;
      const toolHooks: ToolHooks = {
        hold: holdForOwnerWait,
        // A chat turn waits 10 minutes for the owner; a job or routine nobody is watching waits 30.
        ownerWaitMs: settings.ownerWaitMs ?? ownerWaitMsFor(Boolean(run.policy?.jobID) || runCtx.unattended),
        unattended: Boolean(run.untrustedInput) && !peerSourced,
        run: runCtx,
        peerInput,
        allowedDomains,
      };
      // Several read-only lookups in one step start together; the loop below
      // still consumes them in order, so guards and message order are unchanged.
      // Only the first calls of a response run; the rest are answered, not started.
      const started = startParallelReads(result.toolCalls.slice(0, MAX_TOOL_CALLS_PER_RESPONSE), recentCalls, stepCount, DUPLICATE_WINDOW,
        // The same engine answers here as in `executeTool`: a call that would need the owner, or is refused, is not started early.
        (call) => decide(runCtx, { tool: call.function.name, args: callArguments(call.function.arguments), callID: call.id }, { record: false }).action !== "run",
        (call) => executeTool(db, threadID, turnID, call, registry, broker, controller.signal, run.emit, () => undefined, persona, guardrail, toolHooks));
      for (const [position, call] of result.toolCalls.entries()) {
        // Stop (or the turn timeout) ends the step: every call still owed a
        // result gets one, and none of them runs or raises an approval card.
        if (controller.signal.aborted) {
          messages.push({ role: "tool", toolCallID: call.id, content: JSON.stringify({ skipped: true, reason: "cancelled" }) });
          continue;
        }
        if (runStop) {
          // The policy ended the run on an earlier call of this step; the rest are answered, not run.
          messages.push({ role: "tool", toolCallID: call.id, content: JSON.stringify({ skipped: true, reason: runStop.message }) });
          continue;
        }
        if (position >= MAX_TOOL_CALLS_PER_RESPONSE) {
          messages.push({
            role: "tool", toolCallID: call.id,
            content: JSON.stringify({ skipped: true, reason: `Not run: the per-response cap is ${MAX_TOOL_CALLS_PER_RESPONSE} tool calls, and this was call ${position + 1}. Make fewer calls per step.` }),
          });
          continue;
        }
        stepCount += 1;
        // Is this step the model going off road — reading the app's own
        // source instead of doing the work? Counted before the duplicate
        // guard, so repeating the same `cat` counts as wandering too, and
        // counted across the turn, so interleaving lookups does not hide it.
        const looking = offRoadGuard && readsAppSource(call.function.name, callArguments(call.function.arguments));
        if (looking) offRoadSteps += 1;
        const signature = callSignature(call);
        const lastSeen = recentCalls.get(signature);
        if (lastSeen !== undefined && stepCount - lastSeen <= DUPLICATE_WINDOW) {
          const skipped = JSON.stringify({ skipped: true, reason: `Duplicate ${call.function.name} call already tried in this turn.` });
          // The nudge rides along even on a skipped repeat: that is exactly
          // the moment the model needs to be told to stop and act.
          let content = skipped;
          if (looking && offRoadSteps === OFF_ROAD_NUDGE_AT && !offRoadNudged && !acted) {
            offRoadNudged = true;
            content = withNote(skipped, offRoadNote(persona.tools));
          }
          messages.push({ role: "tool", toolCallID: call.id, content });
          continue;
        }
        recentCalls.set(signature, stepCount);
        const callResult = await (started.get(call.id) ?? executeTool(db, threadID, turnID, call, registry, broker, controller.signal, run.emit, (state) => persistSession(db, threadID, turnID, state, messages, summary, stepCount, tokenCount), persona, guardrail, toolHooks));
        if (callResult.stop) runStop = callResult.stop;
        let content = callResult.content;
        if (looking && offRoadSteps === OFF_ROAD_NUDGE_AT && !offRoadNudged && !acted) {
          offRoadNudged = true;
          content = withNote(content, offRoadNote(persona.tools));
        }
        messages.push({ role: "tool", toolCallID: call.id, content });
        if (call.function.name === "say") saidSomething = true;
        const ok = toolSucceeded(callResult.content);
        if (ok) stepProgressed = true;
        // A tool that reaches the owner's world counts as work: mail, tasks,
        // the clock, the web, memory. Reading the app's own state does not.
        if (ok && !WORKSPACE_TOOLS.has(call.function.name) && !INSIDE_TOOLS.has(call.function.name)) acted = true;
        persistSession(db, threadID, turnID, callResult.awaiting ? "awaiting_approval" : "running", messages, summary, stepCount, tokenCount);
        if (callResult.awaiting) {
          // Approval denial is returned as a tool error and the model may explain it.
          persistSession(db, threadID, turnID, "running", messages, summary, stepCount, tokenCount);
        }
        // DEL-006: the task asked the owner a question. The turn stops here
        // and resumes with the answer — it does not keep working on a guess.
        if (needsInput) {
          stopReason = "needs_input";
          break;
        }
      }
      // The question was asked; the turn ends here, waiting for the answer.
      if (needsInput) {
        stopReason = "needs_input";
        break;
      }
      if (runStop) break;
      // Stopped mid-step: the top of the loop names the stop reason.
      if (controller.signal.aborted) continue;
      // A step that only calls tools is normal — some models narrate nothing
      // until they have an answer. A step that calls tools and achieves
      // nothing is flailing, and that is what the guard is for.
      consecutiveNonTextSteps = stepProgressed ? 0 : consecutiveNonTextSteps + 1;
      if (consecutiveNonTextSteps > MAX_NONTEXT_STEPS) {
        const text = "I couldn't make progress on this — please rephrase or continue in a new message.";
        answerText = text;
        emitToken(text);
        messages.push({ role: "assistant", content: text });
        publish(text);
        break;
      }
      // The turn is reading the app's own source instead of doing the work.
      // Say so plainly, and say what it can actually do.
      if (offRoadSteps >= OFF_ROAD_STOP_AT && !acted) {
        const text = offRoadMessage();
        answerText = text;
        emitToken(text);
        messages.push({ role: "assistant", content: text });
        publish(text);
        break;
      }
    }
    // Prune old duplicate signatures so the map doesn't grow unboundedly.
    for (const [sig, step] of recentCalls) {
      if (stepCount - step > DUPLICATE_WINDOW) recentCalls.delete(sig);
    }
  } catch (error) {
    const refusal = error instanceof RouteRefusedError ? stopFromRefusal(error, runCtx, persona.name) : null;
    if (refusal) {
      // The router's own gate said no before any request went out (a spend cap, or the owner's switch). That is
      // the owner's decision showing up late, not a failure: it is told like any other stop, below.
      log.warn(`turn ${turnID} stopped by the model-call gate (${(error as RouteRefusedError).reason})`);
      runStop = refusal;
    } else if (error instanceof GuardrailError) {
      // A depth/chain ceiling is an honest stop, not a crash. The failure
      // travels in `turn.end`; the owner gets a plain sentence, the log the detail.
      stopReason = "error";
      log.warn(`turn ${turnID} stopped by a guardrail (${error.code}): ${error.message}`);
      answerText = error.code === "depth_ceiling"
        ? "I stopped: this chain of work is already as deep as it is allowed to go."
        : "I stopped: this chain of work hit its step limit.";
      messages.push({ role: "assistant", content: answerText });
      publish(answerText);
    } else {
      stopReason = controller.signal.aborted ? (timedOut ? "timeout" : "cancelled") : "error";
      if (stopReason === "cancelled") {
        // The owner stopped the turn on purpose. Keep whatever streamed so
        // the transcript ends where the work did, and let `turn.end` explain
        // it — an error frame would make the client show a failure instead.
        if (activeStepText) {
          answerText = activeStepText;
          messages.push({ role: "assistant", content: activeStepText });
          publish(activeStepText);
          activeStepText = "";
        }
      } else {
        const message = error instanceof Error ? error.message : String(error);
        log.error(`turn ${turnID} ended ${stopReason}: ${message}`);
        if (activeStepText) {
          // Keep the streamed fragment in durable history, but leave the turn
          // marked failed so the UI never presents an interrupted task as done.
          answerText = activeStepText;
          messages.push({ role: "assistant", content: activeStepText });
          publish(activeStepText);
        } else if (!answerText && stopReason === "error") {
          // A turn that failed with nothing to say still owes the user a trace:
          // they asked something, and silence reads as "still thinking".
          answerText = failureSentence(error);
          messages.push({ role: "assistant", content: answerText });
          publish(answerText);
        }
      }
    }
  } finally {
    timer.clear();
    run.signal.removeEventListener("abort", abort);
    if (runningTurns.get(threadID)?.turnID === turnID) {
      cancelReason = runningTurns.get(threadID)?.cancelReason;
      runningTurns.delete(threadID);
    }
  }

  if (runStop && stopReason === "end") {
    // Not an error and not the owner's Stop: the policy ended the run, and the owner is told why in plain words.
    stopReason = runStop.cause === "budget" ? "budget" : runStop.cause === "pause" ? "cancelled" : runStop.cause === "wall_time" ? "timeout" : "error";
    answerText = runStop.message;
    messages.push({ role: "assistant", content: answerText });
    publish(answerText);
    // A spend stop also tells clients which run it was, so the owner can raise the limit or Continue once.
    if (runStop.budget) {
      const { scope, reason, spentUsd, capUsd } = runStop.budget;
      run.emit({
        type: "spend.stopped", runKey: runStop.budget.runKey ?? `agent:${persona.id}`, agentId: persona.id,
        scope, reason, spentUsd, capUsd, message: runStop.message,
      });
    }
  }
  if (run.channelID && run.groupContext === undefined) compactChannelHistory(db, router, run.channelID, persona.id, peerInput).catch((error) => log.warn("channel compaction failed", error));
  // Cards this turn raised and nobody answered are dead now: expire them so a
  // late click does nothing and a reconnect does not draw them again.
  expirePendingForTurn(db, turnID, stopReason === "cancelled" ? "cancelled" : "expired", run.emit);
  // The turn's stop reason is the protocol's word ("timeout"); `endedBy` says it was the run's time limit and not a slow model.
  finishTurn(db, { id: turnID, stopReason, ...usage, ...(runStop?.cause === "wall_time" ? { endedBy: "wall_time" } : {}) });
  // A request the owner stopped is closed for the model too; one their next message took over from is not.
  if (stopReason === "cancelled" && cancelReason !== SUPERSEDED) {
    // Only an explicit Stop is the owner's; an abort nobody labelled is "interrupted", never "Stop".
    const why = abortReasonOf(run.signal);
    const ownerStopped = why === "owner_stop" || cancelReason === "the owner asked to stop";
    if (why !== "timeout") {
      closeRequest(db, { threadID, turnID, reason: why === "paused" || why === "agent_off" ? why : why === "device_revoked" ? "revoked" : ownerStopped ? "stopped" : "interrupted" });
    }
  }
  touchThread(db, threadID);
  // A turn waiting for the owner's answer is not a failed turn: the session
  // is parked, and the resume picks it up.
  const sessionState = stopReason === "end" ? "done" : stopReason === "needs_input" ? "waiting" : "failed";
  persistSession(db, threadID, turnID, sessionState, messages, summary, stepCount, tokenCount);
  run.emit({ type: "turn.end", turnID, threadID, stopReason, ...(usage ? { usage } : {}), ...(run.conversationID ? { conversationID: run.conversationID } : {}) });
  // PR 6: waiting for the owner is not the same as working.
  run.emit({
    type: "agent.presence",
    agentId: persona.id,
    state: stopReason === "needs_input" ? "waiting" : "idle",
    ...(run.delegation?.taskID ? { taskId: run.delegation.taskID } : {}),
  });
  return { turnID, text: answerText, stopReason, taint: packTaint(runCtx), ...(runStop?.cause === "wall_time" ? { endedBy: "wall_time" as const } : {}) };
}

/** Did every provider turn the step down because of the max_tokens we sent? */
function rejectsMaxTokens(error: unknown): boolean {
  return error instanceof RouterError && error.code === "provider_failed" && /HTTP 400/.test(error.message) && /max_(?:completion_)?tokens/i.test(error.message);
}

type TurnUsage = { provider: string; model: string; inputTokens?: number; outputTokens?: number; latencyMs: number };

/** Add one step's usage to the turn's running total. The provider and model are the latest step's. */
function addUsage(total: TurnUsage | undefined, step: TurnUsage): TurnUsage {
  const sum = (a?: number, b?: number): number | undefined => (a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0));
  return {
    provider: step.provider,
    model: step.model,
    inputTokens: sum(total?.inputTokens, step.inputTokens),
    outputTokens: sum(total?.outputTokens, step.outputTokens),
    latencyMs: (total?.latencyMs ?? 0) + step.latencyMs,
  };
}

/** The owner-facing sentence for a turn that failed; the detail is in the log. */
function failureSentence(error: unknown): string {
  if (error instanceof RouterBusyError) return "I'm handling too many requests right now. Please try again in a moment.";
  if (error instanceof RouterError && error.code === "no_provider") return "I can't answer because no model provider is set up.";
  if (error instanceof RouterError) return "I couldn't reach a model to finish this. Please try again.";
  return "Something went wrong on my side, so I stopped. Please try again.";
}

/**
 * What makes two tool calls "the same" for the duplicate guard: the tool and
 * its arguments, with key order, JSON whitespace and padding around strings
 * ignored, so a retry in disguise is still a retry.
 */
export function callSignature(call: ToolCall): string {
  const canonical = (value: unknown): unknown => {
    if (typeof value === "string") return value.trim();
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, item]) => [key, canonical(item)]));
    }
    return value;
  };
  let args = call.function.arguments.trim();
  try { args = JSON.stringify(canonical(JSON.parse(call.function.arguments))); } catch { /* not JSON: compare the text as it is */ }
  return `${call.function.name}:${args}`;
}

/** False when the tool reported an error; a result that is not JSON still counts. */
function toolSucceeded(content: string): boolean {
  try {
    return typeof (JSON.parse(content) as { error?: unknown }).error !== "string";
  } catch {
    return true;
  }
}

/** The tool call's arguments, parsed leniently. */
function callArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Where the turn runs, for telling the checkout from the owner's own files. */
interface PathEnv { cwd: string; platform: NodeJS.Platform }

/** An absolute path on any system: posix, `~`, a drive (`C:\` or `C:/`), or a UNC share. */
function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("~") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/** Does this text name the checkout? Separators are interchangeable, and case is ignored on Windows. */
function namesCheckout(text: string, env: PathEnv): boolean {
  const fold = (value: string): string => {
    const slashed = value.replace(/\\/g, "/");
    return env.platform === "win32" ? slashed.toLowerCase() : slashed;
  };
  const root = fold(env.cwd);
  if (root.length <= 1) return false;
  const roots = [root];
  // Git Bash writes C:/x as /c/x.
  const drive = /^([a-z]):\//.exec(root);
  if (env.platform === "win32" && drive) roots.push(`/${drive[1]}/${root.slice(3)}`);
  const folded = fold(text);
  return roots.some((candidate) => folded.includes(candidate));
}

/**
 * Does this step look at the app's own source or state rather than at the
 * owner's files?
 *
 * The shell tool runs in the app's checkout, so a command that only names
 * relative paths is reading the app — even when it never says "apps/". Only
 * an absolute path outside the checkout is the owner's own.
 */
export function readsAppSource(
  toolName: string,
  args: Record<string, unknown>,
  env: PathEnv = { cwd: process.cwd(), platform: process.platform },
): boolean {
  if (!WORKSPACE_TOOLS.has(toolName)) return false;
  const target = toolName === "bash" ? String(args.command ?? "") : String(args.path ?? "");
  if (!target) return false;
  if (APP_SOURCE_MARKERS.some((marker) => target.includes(marker))) return true;
  if (namesCheckout(target, env)) return true;
  if (toolName !== "bash") {
    // read_file / grep / glob: a relative path is the checkout; "~" and an
    // absolute path are the owner's.
    return !isAbsolutePath(target);
  }
  // A command that names only relative paths reads the checkout.
  const absolute = target.match(/(?:^|[\s"'=])(?:\/[^\s"';|&]+|[A-Za-z]:[\\/][^\s"';|&]*|\\\\[^\s"';|&]+)/g) ?? [];
  if (absolute.length === 0) return !/(?:^|\s)~\//.test(target);
  return absolute.some((path) => namesCheckout(path, env));
}

/**
 * The tools this agent can act with — what it is told it has. The list is
 * complete: a truncated list hides exactly the tool that would have done the
 * job.
 */
function actionTools(tools: string[]): string[] {
  return tools.filter((tool) => !WORKSPACE_TOOLS.has(tool));
}

/** The note that tells a wandering turn to act — or to admit it cannot. */
function offRoadNote(tools: string[]): string {
  return [
    "Stop reading the app's source. You are the owner's assistant, not a developer of this app: reading the code " +
    "does not change what you can do, and it does not get the work done.",
    "Do the work with the tools you have, or say plainly that the request needs a capability you do not have, and name what you can do instead.",
    `Tools you have: ${actionTools(tools).join(", ") || "(none)"}.`,
  ].join(" ");}

/** The honest ending for a turn that spent itself reading the source. */
function offRoadMessage(): string {
  return [
    "I can't change how the app itself works — I'm the assistant running inside it, and reading its source doesn't " +
    "let me add features.",
    "I can still help with mail, tasks, memory, search, files, and research.",
    "If your request needs a change to the app, it has to come from a developer.",
  ].join(" ");
}

/** Attach a note to a tool result without losing what the tool said. */
function withNote(content: string, note: string): string {
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed === "object" && parsed !== null) {
      return JSON.stringify({ ...(parsed as Record<string, unknown>), note });
    }
  } catch {
    // A result that is not JSON still gets the note in front of it.
  }
  return `${note}\n${content}`;
}

/** Free, read-only tools whose calls in one step may run at the same time. */
export const PARALLEL_READ_TOOLS = new Set([
  "memory_search", "transcript_search", "recall_fact", "expand", "links_search", "tasks_list", "job_list",
  "web_fetch", "web_search", "read_file", "grep", "glob", "delegate_wait", "task_status", "scratch_read",
]);

/**
 * Start a step's calls concurrently when there are several and every one is a
 * free read. A call the duplicate guard will skip is not started. Anything
 * else returns an empty map and the step runs in series as before.
 */
export function startParallelReads<T>(
  calls: ToolCall[], recentCalls: ReadonlyMap<string, number>, stepCount: number, window: number,
  gated: (call: ToolCall) => boolean, run: (call: ToolCall) => Promise<T>,
): Map<string, Promise<T>> {
  const started = new Map<string, Promise<T>>();
  if (calls.length < 2 || !calls.every((call) => PARALLEL_READ_TOOLS.has(call.function.name) && !gated(call))) return started;
  const seen = new Map(recentCalls);
  calls.forEach((call, index) => {
    const signature = callSignature(call);
    const step = stepCount + index + 1;
    const last = seen.get(signature);
    if (last !== undefined && step - last <= window) return;
    seen.set(signature, step);
    started.set(call.id, run(call));
  });
  return started;
}

/** What a tool call needs from the turn around it. */
interface ToolHooks {
  /** Stop the turn's clock while the call waits on the owner; the result ends the wait. */
  hold: () => () => void;
  /** The longest the owner is waited for before the card expires. */
  ownerWaitMs: number;
  /** An unattended routine run: refusals that blame "another agent's message" say what this is instead. */
  unattended?: boolean;
  /** Who is running and what outside text it has read. Every call is judged against it. */
  run: RunContext;
  /** The turn began from text the owner did not write (kept for the display rules and the tools' own refusals). */
  peerInput: boolean;
  /** A routine's domain list for web tools. */
  allowedDomains?: string[];
}

/** The error the loop raises when the abort or the call's own time limit cuts a tool call in the middle. */
class AbortedMidCall extends Error {
  constructor() { super("tool timed out or was cancelled"); }
}

interface ToolOutcome {
  content: string;
  awaiting: boolean;
  /** The policy ended the whole run on this call. */
  stop?: RunStop;
}

async function executeTool(
  db: Database, threadID: string, turnID: string, call: ToolCall,
  registry: ReturnType<typeof buildTaskToolRegistry>, broker: ApprovalBroker, signal: AbortSignal,
  emit: (frame: ServerFrameBody) => void,
  setState: (state: string) => void,
  persona: Persona, guardrail: GuardrailState, hooks: ToolHooks,
): Promise<ToolOutcome> {
  const tool = registry.get(call.function.name);
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(call.function.arguments) as Record<string, unknown>; } catch { /* handled below */ }
  const existing = db.query("SELECT result, ok, error FROM tool_calls WHERE turn_id = ? AND call_id = ? ORDER BY created_at DESC LIMIT 1").get(turnID, call.id) as { result: string | null; ok: number; error: string | null } | null;
  if (existing) {
    if (existing.result !== null) return { content: existing.result, awaiting: false };
    return { content: JSON.stringify({ error: "This tool call was interrupted before completion and was not repeated." }), awaiting: false };
  }
  const rowID = newID("tcl");
  const startedAt = Date.now();
  db.run("INSERT INTO tool_calls (id, thread_id, turn_id, call_id, tool_name, args, result, ok, error, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, 0, NULL, ?)", [rowID, threadID, turnID, call.id, call.function.name, redact(JSON.stringify(args)), nowISO()]);
  // Surface the tool call as an activity strip so the UI can render nested
  // work (delegated turns, deep research) without guessing from tokens.
  emit({ type: "tool.start", callID: call.id, name: call.function.name, preview: redact(describePreview(call.function.name, args)) });
  const storeResult = (content: string, ok: boolean, error: string | null): void => {
    db.run("UPDATE tool_calls SET result = ?, ok = ?, error = ?, duration_ms = ? WHERE id = ?", [redact(content), ok ? 1 : 0, error, Date.now() - startedAt, rowID]);
  };
  // One gate for every call: capability, schema, resources, budget, what the run has read, stored rules, the owner.
  const gate = await gateToolCall(
    { db, broker, emit, setState, hold: hooks.hold, ownerWaitMs: hooks.ownerWaitMs },
    hooks.run, { tool: call.function.name, args, callID: call.id }, signal,
  );
  if (!gate.go || !tool) {
    const content = gate.go ? JSON.stringify({ error: `Tool is not available to this persona: ${call.function.name}` }) : gate.content;
    storeResult(content, false, gate.go ? "tool_not_allowed" : gate.code);
    emit({ type: "tool.end", callID: call.id, ok: false, preview: gate.go ? "not available" : gate.preview });
    return gate.go ? { content, awaiting: false } : { content, awaiting: gate.awaiting, ...(gate.stop ? { stop: gate.stop } : {}) };
  }
  // `run_privileged` waits on the owner inside the call (a password prompt or
  // the system dialog), so the turn's clock stops for it as it does for an
  // approval card, and no longer than the owner-wait ceiling. The call's own
  // timeout still bounds the command.
  let releaseOwnerWait: (() => void) | undefined;
  let ownerWaitCeiling: ReturnType<typeof setTimeout> | undefined;
  if (call.function.name === "run_privileged") {
    releaseOwnerWait = hooks.hold();
    ownerWaitCeiling = setTimeout(releaseOwnerWait, hooks.ownerWaitMs);
  }
  try {
    const parsed = JSON.parse(call.function.arguments) as unknown;
    const timeout = AbortSignal.timeout(tool.timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    const allowedDomains = hooks.allowedDomains;
    const result = await Promise.race([
      tool.handler(parsed as never, {
        threadID,
        turnID,
        signal: combined,
        peerInput: hooks.peerInput,
        run: hooks.run,
        ownerApproved: gate.approvedBy === "owner",
        chain: {
          depth: guardrail.depth,
          rootAgentID: guardrail.rootAgentID,
          currentAgentID: guardrail.currentAgentID,
          handoffSummary: guardrail.handoffSummary,
        },
        hostAllowed: allowedDomains ? (url: URL) => domainAllowed(url.toString(), allowedDomains) : undefined,
      }),
      new Promise<never>((_, reject) => combined.addEventListener("abort", () => reject(new AbortedMidCall()), { once: true })),
    ]);
    let safeResult = result;
    if (hooks.unattended) safeResult = unattendedWording(result);
    if (allowedDomains && call.function.name === "web_search" && typeof result === "object" && result !== null && Array.isArray((result as { results?: unknown }).results)) {
      safeResult = { ...(result as Record<string, unknown>), results: (result as { results: unknown[] }).results.filter((item) => {
        if (typeof item !== "object" || item === null || typeof (item as { url?: unknown }).url !== "string") return false;
        return domainAllowed((item as { url: string }).url, allowedDomains);
      }) };
    }
    const content = LONG_RESULT_TOOLS.has(call.function.name)
      ? fitToolResult(safeResult, MAX_LONG_TOOL_RESULT_CHARS, LONG_RESULT_TEXT_CHARS)
      : fitToolResult(safeResult);
    // What the model has just read is outside text if the tool says so: the run is marked from here on.
    noteTaint(hooks.run, tool, args, result);
    storeResult(content, true, null);
    emit({ type: "tool.end", callID: call.id, ok: true, preview: toolPreview(result) });
    return { content, awaiting: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const content = JSON.stringify({ error: truncate(message, 500) });
    // The abort's own error has its own code; a tool's message that equals a loop code is prefixed (see closure.ts).
    // What the tool threw reaches the model; an abort cut it off before anything came back.
    if (!(error instanceof AbortedMidCall)) noteTaint(hooks.run, tool, args, { error: message });
    storeResult(content, false, error instanceof AbortedMidCall ? ABORTED_MID_CALL : toolErrorCode(message));
    emit({ type: "tool.end", callID: call.id, ok: false, preview: truncate(message, 120) });
    return { content, awaiting: false };
  } finally {
    clearTimeout(ownerWaitCeiling);
    releaseOwnerWait?.();
  }
}

/** Mark the run when a tool brought outside text into it, and write the change down. A failed audit row never un-marks the run. */
function noteTaint(run: RunContext, tool: { name: string; meta?: ToolMeta }, args: Record<string, unknown>, result: unknown): void {
  // An error result reaches the model like any other: an outside reader's failure text can carry the page, the mail or the
  // server's own words, so it marks the run too.
  const source = taintFrom(policyFor(tool.name, tool.meta), tool.name, args, result, nowISO());
  if (source) markRun(run, source);
}

/** What a resumed session had read. No record, or one that cannot be read, is tainted. */
function restoredTaint(raw: string | null): TaintSource[] {
  if (raw === null) return readTaint(undefined, "a session restored with no record of what it had read");
  try {
    return readTaint(JSON.parse(raw), "a session restored with no record of what it had read");
  } catch {
    return readTaint(undefined, "a session restored with no record of what it had read");
  }
}

/**
 * What the thread's earlier runs had read, as one source: the thread has a session whose last record of what it read is not empty, or
 * cannot be read (no record, or one that does not parse). A thread with no session yet has no history to be influenced by.
 */
function historyTaint(session: { taint: string | null } | null | undefined): TaintSource[] {
  if (!session) return [];
  if (restoredTaint(session.taint).length === 0) return [];
  return [{ kind: "history", label: "earlier messages in this conversation", at: nowISO() }];
}

/** Who started this run, in the policy's terms. */
function principalOf(run: TaskTurnRun): Principal {
  if (run.peer || run.delegation) return { kind: "peer", ...(run.peer?.from ? { from: run.peer.from } : {}) };
  if (run.untrustedInput) return { kind: "routine" };
  if (run.wake) return { kind: "wake" };
  if (run.inputRole === "system") return { kind: "job" };
  return { kind: "owner" };
}

/** The attached files' names for the card ("notes.pdf"), or a plain phrase when there are none to name. */
function attachmentLabel(db: Database, messageID: string): string {
  const names = messageAttachments(db, messageID).map((file) => file.name).filter(Boolean);
  if (names.length === 0) return "an attached file";
  return truncate(names.slice(0, 3).join(", ") + (names.length > 3 ? `, and ${names.length - 3} more` : ""), 100);
}

/**
 * What the router's gate refusing a call means for the run: a spend stop or a pause, in the owner's words. Other
 * refusals (a call with no bot named, a gate that failed) are bugs or breakage and stay ordinary errors.
 */
function stopFromRefusal(error: RouteRefusedError, run: RunContext, botName: string): RunStop | null {
  const budget = budgetStopFromRefusal(error);
  if (budget) {
    const runKey = budgetRunKey({
      agentID: run.bot,
      ...(run.jobID ? { jobID: run.jobID } : {}),
      ...(run.rootJob ? { rootJobID: run.rootJob } : {}),
    }, run.services.db);
    const detail = { ...budget, ...(runKey !== undefined ? { runKey } : {}) };
    return { cause: "budget", message: budgetStopMessage(botName, detail), budget: detail };
  }
  if (error.reason === "paused") {
    const paused = policyHooks.isRunPaused(run);
    return { cause: "pause", message: paused?.message ?? pauseStopMessage(botName, { scope: "all" }) };
  }
  return null;
}

/** The owner's switch, a spend cap or the root job's time limit, checked before the next model call. */
function haltedBeforeStep(run: RunContext): RunStop | null {
  const paused = policyHooks.isRunPaused(run);
  if (paused) return { cause: "pause", message: paused.message };
  const budget = policyHooks.checkBudget(run);
  if (!budget.ok) return { cause: "budget", message: budget.message, ...(budget.detail ? { budget: budget.detail } : {}) };
  // One clock for the run and everything it delegated, without the time the owner spent deciding (S2-09).
  const wall = checkWallTime(run.services.db, run.clockKey);
  if (!wall.ok) return { cause: "wall_time", message: wallTimeStopMessage(run.services.botName, { wallMs: wall.wallMs, unknown: wall.reason === "unknown" }) };
  return null;
}

/**
 * The tools refuse peer-influenced turns with words about "another agent's message". An unattended
 * routine run is refused for the same reason but is not that, so the refusal says what it is.
 */
function unattendedWording(result: unknown): unknown {
  if (typeof result !== "object" || result === null || typeof (result as { error?: unknown }).error !== "string") return result;
  const error = (result as { error: string }).error;
  const reworded = error.replace("this turn started from another agent's message", "this is an unattended routine run");
  return reworded === error ? result : { ...(result as Record<string, unknown>), error: reworded };
}

function parseSessionMessages(raw: string): ChatMessage[] {
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is ChatMessage => typeof item === "object" && item !== null &&
      ["system", "user", "assistant", "tool"].includes(String((item as { role?: unknown }).role)) &&
      typeof (item as { content?: unknown }).content === "string");
  } catch { return []; }
}
function recoverToolResults(db: Database, turnID: string, messages: ChatMessage[]): void {
  for (const assistant of messages) {
    if (assistant.role !== "assistant") continue;
    for (const call of assistant.toolCalls ?? []) {
      if (messages.some((message) => message.role === "tool" && message.toolCallID === call.id)) continue;
      const row = db.query("SELECT id, result FROM tool_calls WHERE turn_id=? AND call_id=? ORDER BY created_at DESC LIMIT 1").get(turnID, call.id) as { id: string; result: string | null } | null;
      if (row?.result !== null && row?.result !== undefined) {
        messages.push({ role: "tool", toolCallID: call.id, content: row.result });
        continue;
      }
      const content = JSON.stringify({ error: "The previous process stopped before this tool result was saved. The action was not repeated; please retry if it is still needed." });
      if (row) db.run("UPDATE tool_calls SET result=?, ok=0, error='interrupted_before_result' WHERE id=? AND result IS NULL", [content, row.id]);
      db.run("UPDATE approvals SET status='decided', decision='reject', decided_at=? WHERE turn_id=? AND call_id=? AND status='pending'", [nowISO(), turnID, call.id]);
      messages.push({ role: "tool", toolCallID: call.id, content });
    }
  }
}
/**
 * An assistant entry for the session log. `reasoning` rides along when the
 * provider streamed it; it is stored, never sent back to the provider, and
 * never shown in the chat — the export is the only reader.
 */
function assistantMessage(content: string, reasoning?: string): ChatMessage {
  return { role: "assistant", content, ...(reasoning ? { reasoning } : {}) };
}

function persistSession(db: Database, threadID: string, turnID: string, state: string, messages: ChatMessage[], summary: string | null, steps: number, tokens: number): void {
  db.run("UPDATE agent_sessions SET state=?, message_log=?, summary=?, step_count=?, token_count=?, updated_at=? WHERE thread_id=? AND turn_id=?", [state, redact(JSON.stringify(messages)), summary, steps, tokens, nowISO(), threadID, turnID]);
}

/** The note a cut user message ends with. Matched on the way back in, so a cut message is not cut twice. */
const USER_CUT_NOTE = /\n\n\[Note: this message was cut to fit: kept \d+ of \d+ characters\. Tell the owner the rest was not read\.\]$/;

/** The owner's message, cut at the limit with a plain note of how much was kept. */
function clipUserMessage(content: string): string {
  if (content.length <= MAX_USER_MESSAGE_CHARS) return content;
  // Already cut (the note adds a little): leave it. A long message that only imitates the note is still cut.
  if (content.length <= MAX_USER_MESSAGE_CHARS + 300 && USER_CUT_NOTE.test(content)) return content;
  return `${content.slice(0, MAX_USER_MESSAGE_CHARS)}\n\n[Note: this message was cut to fit: kept ${MAX_USER_MESSAGE_CHARS} of ${content.length} characters. Tell the owner the rest was not read.]`;
}

export function compact(messages: ChatMessage[], previousSummary: string | null): { messages: ChatMessage[]; summary: string | null } {
  let normalized = messages.map((message) => ({
    ...message,
    content: message.role === "user" ? clipUserMessage(message.content) : truncate(message.content, message.role === "tool" ? MAX_LONG_TOOL_RESULT_CHARS : 12_000),
    ...(message.toolCalls ? { toolCalls: message.toolCalls.map((call) => call.function.arguments.length > 8_000
      ? { ...call, function: { ...call.function, arguments: "{}" } } : call) } : {}),
  }));
  const size = (): number => normalized.reduce((total, message) => total + message.content.length + JSON.stringify(message.toolCalls ?? []).length, 0);
  if (size() <= MAX_PROMPT_CHARS) return { messages: normalized, summary: previousSummary };
  // The request this turn is answering stays verbatim, never in the
  // "untrusted" summary. Everything else may be folded into the summary, but
  // only whole steps: a tool result always goes with the assistant message
  // that called it.
  const current = normalized.findLastIndex((message) => message.role === "user");
  const pinned = current >= 0 ? normalized[current] : undefined;
  const folded: typeof normalized = [];
  // Keep the last few messages, starting at a step boundary.
  let cut = Math.max(0, normalized.length - 8);
  while (cut > 0 && normalized[cut]!.role === "tool") cut -= 1;
  if (pinned && cut > current) {
    // The request is older than the kept tail: it rides in front of it.
    folded.push(...normalized.slice(0, cut).filter((message) => message !== pinned));
    normalized = [pinned, ...normalized.slice(cut)];
  } else {
    folded.push(...normalized.slice(0, cut));
    normalized = normalized.slice(cut);
  }
  // Still too big (a long single turn): fold the oldest whole step, keeping the newest.
  while (size() > MAX_PROMPT_CHARS) {
    const first = normalized.findIndex((message) => message !== pinned);
    if (first < 0) break;
    let end = first + 1;
    while (end < normalized.length && normalized[end]!.role === "tool") end += 1;
    if (normalized.slice(end).every((message) => message === pinned)) break;
    folded.push(...normalized.slice(first, end));
    normalized = [...normalized.slice(0, first), ...normalized.slice(end)];
  }
  const dropped = folded.flatMap((message) => {
    if (message.role !== "user" && message.role !== "assistant") return [];
    const calls = message.toolCalls?.length ? `(called ${message.toolCalls.map((call) => call.function.name).join(", ")})` : "";
    const line = [message.content, calls].filter(Boolean).join(" ");
    return line ? [`${message.role}: ${line}`] : [];
  }).join("\n");
  const summary = truncateTail([previousSummary, dropped].filter(Boolean).join("\n"), 8_000);
  return { messages: normalized, summary };
}
/**
 * A tool result that fits the prompt and is still valid JSON: long strings
 * and arrays are cut step by step, and the result is marked truncated.
 */
export function fitToolResult(value: unknown, max = MAX_TOOL_RESULT_CHARS, keepChars = 1_000): string {
  const full = JSON.stringify(value) ?? "null";
  if (full.length <= max) return full;
  for (const [items, chars] of [[20, keepChars], [10, 400], [5, 200], [3, 80]] as const) {
    const text = JSON.stringify({ truncated: true, result: shrinkValue(value, items, chars) });
    if (text.length <= max) return text;
  }
  // shortcut: very wide or deep objects can still overflow; they fall back to a plain cut.
  return truncate(full, max);
}

function shrinkValue(value: unknown, items: number, chars: number): unknown {
  if (typeof value === "string") return value.length > chars ? `${value.slice(0, chars)}…` : value;
  if (Array.isArray(value)) {
    const kept = value.slice(0, items).map((item) => shrinkValue(item, items, chars));
    return value.length > items ? [...kept, `…${value.length - items} more`] : kept;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shrinkValue(item, items, chars)]));
  }
  return value;
}

function estimateTokens(text: string): number { return Math.ceil(text.length / 4); }
/** Keep the newest end: summaries grow by appending. */
function truncateTail(text: string, max: number): string { return text.length > max ? `…${text.slice(text.length - max + 1)}` : text; }
function truncate(text: string, max: number): string { return text.length > max ? `${text.slice(0, max - 1)}…` : text; }

/** Short human preview for a tool.start frame. */
function describePreview(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "handoff": return `hand off to ${String(args.toAgentID ?? "?")}: ${String(args.task ?? "").slice(0, 80)}`;
    case "delegate_task": return `delegate to ${String(args.toAgentID ?? "?")}: ${String(args.goal ?? "").slice(0, 80)}`;
    case "delegate_wait": return `wait for ${String(args.taskID ?? "?")}`;
    case "task_status": return `status of ${String(args.taskID ?? "?")}`;
    case "task_cancel": return `cancel ${String(args.taskID ?? "?")}`;
    case "rename_agent": return `rename to ${String(args.name ?? "?")}`;
    case "bash": return String(args.command ?? "").slice(0, 120);
    case "write_file": return `write ${args.path ?? "?"}`;
    case "read_file": return `read ${args.path ?? "?"}`;
    case "memory_write": return `save memory: ${String(args.text ?? "").slice(0, 60)}`;
    case "remember_fact": return `remember: ${String(args.fact ?? "").slice(0, 60)}`;
    case "recall_fact": return `recall facts${args.query ? `: ${String(args.query).slice(0, 60)}` : ""}`;
    case "link_save": return `save link: ${args.url ?? "?"}`;
    case "web_search": return `search: ${args.query ?? "?"}`;
    case "web_fetch": return `fetch: ${args.url ?? "?"}`;
    default: return `${toolName}(${JSON.stringify(args).slice(0, 80)})`;
  }
}

/** Short preview for a tool.end frame, derived from the result object. */
function toolPreview(result: unknown): string {
  if (result === null || result === undefined) return "done";
  if (typeof result === "string") return truncate(result, 120);
  if (typeof result === "object") {
    const record = result as Record<string, unknown>;
    if (typeof record.text === "string") return truncate(record.text, 120);
    if (typeof record.fact === "string") return truncate(record.fact, 120);
    if (Array.isArray(record.facts)) return `${record.facts.length} fact(s)`;
    if (typeof record.childTurnID === "string") return `delegated to ${record.agentID ?? "?"} (depth ${record.depth ?? "?"})`;
    if (record.deleted === true) return "fact deleted";
  }
  return truncate(JSON.stringify(result), 120);
}
