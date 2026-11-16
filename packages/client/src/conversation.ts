/**
 * The conversation a person is looking at: messages, tool activity, approvals,
 * notices, and the in-flight turn. Pure value state — every frame the socket
 * delivers folds in here, so the reducer is testable without a socket or a
 * window, and the views stay dumb.
 */
import type { AttachmentInfo, AgentInfo, Decision, MessageInfo, TaskInfo, Usage } from "@agni/protocol";
import { parseISO } from "./format.js";
import { stopReasonExplanation, type IncomingFrame } from "./protocol";

export type MessageRole = "user" | "assistant" | "system";

export type MessageState =
  | { kind: "complete" }
  | { kind: "streaming" }
  | { kind: "stopped"; reason: string }
  | { kind: "failed"; reason: string };

export interface ToolActivity {
  id: string;
  name: string;
  preview: string | null;
  state: "running" | "ok" | "failed";
}

export interface ChatMessage {
  attachments?: AttachmentInfo[];
  id: string;
  role: MessageRole;
  text: string;
  createdAt: Date | null;
  turnID: string | null;
  agentID: string | null;
  /** Session block this message lives in — the seam key for dividers. */
  sessionID: string | null;
  state: MessageState;
  usage: Usage | null;
  tools: ToolActivity[];
  /** Shown immediately, before the server confirms the turn. */
  isLocalEcho: boolean;
  senderName: string | null;
  senderColor: string | null;
  /** The agent this message is about — a handoff notice names its target. */
  toAgentId: string | null;
  uiHint: string | null;
  /** Set on a question from a delegated task; the answer carries it back. */
  taskId: string | null;
  questionId: string | null;
  /**
   * The reply of a background job (a reminder, a brief) that streamed into
   * this conversation from a session block of its own. It never counts as the
   * owner's own empty answer.
   */
  isBackground: boolean;
  /**
   * The text so far is the middle of a reply: this view picked the turn up
   * after it began (the owner switched away and back). The full text replaces
   * it when the answer is sealed.
   */
  isContinuation: boolean;
  /** The daemon said how this message's turn ended (history rows carry it). */
  stopKnown?: boolean;
}

export interface ApprovalRow {
  id: string;
  action: string;
  preview: string;
  decisions: string[];
  decision: string | null;
  isLocal: boolean;
  /** The bot whose turn asked, when the frames said so; null when unknown. */
  agentID?: string | null;
}

export interface FormEmail {
  from?: string;
  to: string;
  subject: string;
  body: string;
}

export interface FormRow {
  id: string;
  question: string;
  options: string[];
  answer: string | null;
  /** What the card is: a list of choices, or an email draft to approve. */
  kind: "choice" | "email";
  /** More than one option may be chosen. */
  multiple: boolean;
  /** The draft, when the kind is "email". */
  email: FormEmail | null;
  /** The bot whose turn asked, when the frames said so; null when unknown. */
  agentID?: string | null;
}

/** A one-time password prompt. The value never lives in this row. */
export interface SecretRow {
  id: string;
  purpose: string;
  command: string;
  kind: "password" | "text";
  expiresAt: string;
}

export type NoticeKind = "info" | "reminder" | "failure";

export interface NoticeRow {
  id: string;
  kind: NoticeKind;
  title: string;
  body: string;
  createdAt: Date;
  threadID: string | null;
}

/** What the UI or the app model should do after a frame landed. */
export type ConversationEffect =
  | { kind: "refreshThreadList" }
  | { kind: "reloadDurableState" }
  | {
      kind: "notify";
      title: string;
      body: string;
      sound: boolean;
      threadID?: string;
      /**
       * Set when the notice is the app asking the owner for something. `title`
       * is neutral; the app puts the asking bot's name in front when it knows
       * it. The product name is never used as a bot's name.
       */
      need?: "approval" | "question" | "password";
      agentID?: string | null;
    }
  | { kind: "focusComposer" }
  | { kind: "unread"; threadID: string }
  | { kind: "agentsChanged"; agents: AgentInfo[] }
  | { kind: "presence"; online: boolean }
  | { kind: "agentPresence"; agentID: string; state: "idle" | "working" | "waiting" | "blocked" }
  | { kind: "taskChanged"; task: TaskInfo }
  | { kind: "bound"; agentID: string; conversationID: string; sessionID: string; channelID: string };

function newMessage(partial: Partial<ChatMessage> & Pick<ChatMessage, "id" | "role">): ChatMessage {
  return {
    text: "",
    createdAt: null,
    turnID: null,
    agentID: null,
    sessionID: null,
    state: { kind: "complete" },
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
    ...partial,
  };
}

export function isStreaming(message: ChatMessage): boolean {
  return message.state.kind === "streaming";
}

export function isComplete(message: ChatMessage): boolean {
  return message.state.kind === "complete";
}

export function isStopped(message: ChatMessage, reason?: string): boolean {
  return message.state.kind === "stopped" && (reason === undefined || message.state.reason === reason);
}

export function isFailed(message: ChatMessage, reason?: string): boolean {
  return message.state.kind === "failed" && (reason === undefined || message.state.reason === reason);
}

/** The quiet line under a reply that did not end cleanly. */
export function stopExplanation(message: ChatMessage): string | null {
  switch (message.state.kind) {
    case "complete":
    case "streaming":
      return null;
    case "stopped":
      return stopReasonExplanation(message.state.reason);
    case "failed":
      return message.state.reason;
  }
}

export class Conversation {
  /** The open conversation surface (v2): one per agent, never moved. */
  conversationID: string | null = null;
  /** The active session block inside that conversation — where sends land. */
  threadID: string | null;
  title: string | null = null;
  agentID: string;
  messages: ChatMessage[] = [];
  approvals: ApprovalRow[] = [];
  forms: FormRow[] = [];
  secrets: SecretRow[] = [];
  notices: NoticeRow[] = [];
  inFlightTurnID: string | null = null;
  inFlightThreadID: string | null = null;

  /** Failure text by turn, so a turn that dies explains itself in place. */
  private failures = new Map<string, string>();
  /** The last sealed answer of a running turn, so its fate lands on the right bubble. */
  private turnAnswers = new Map<string, string>();
  /**
   * Turns whose start bound them into this conversation by conversationID;
   * their tokens carry only a block id, so attribution survives the seam.
   */
  private adoptedTurns = new Set<string>();
  /** Which bot runs each turn this view follows: who an approval is "from". */
  private turnAgents = new Map<string, string>();
  /**
   * Turns whose start named another conversation. Their tokens carry no conversation of
   * their own, so this is the only way to tell them from this chat's.
   */
  private declinedTurns = new Set<string>();
  /**
   * Turns started in a conversation while this chat did not yet know its own (after a reload,
   * the replay arrives before `conversation.open` answers). They are judged when the chat binds.
   */
  private pendingTurns = new Map<string, { threadID: string; conversationID: string; agentID: string }>();

  private static readonly noticeCap = 40;

  constructor(agentID: string, threadID: string | null = null) {
    this.agentID = agentID;
    this.threadID = threadID;
  }

  get isStreaming(): boolean {
    return this.inFlightTurnID !== null;
  }

  get openApprovals(): ApprovalRow[] {
    return this.approvals.filter((approval) => approval.decision === null);
  }

  get openForms(): FormRow[] {
    return this.forms.filter((form) => form.answer === null);
  }

  get openSecrets(): SecretRow[] {
    return this.secrets;
  }

  get needsYou(): boolean {
    return this.openApprovals.length > 0 || this.openForms.length > 0 || this.openSecrets.length > 0;
  }

  get streamingMessageID(): string | null {
    return this.inFlightTurnID ? Conversation.assistantID(this.inFlightTurnID) : null;
  }

  static assistantID(turnID: string): string {
    return `asst_${turnID}`;
  }

  // MARK: intent from the UI

  /** Local echo: the bubble appears before the socket answers (S6). */
  appendLocalUserMessage(text: string, at: Date = new Date(), attachments: AttachmentInfo[] = []): string {
    const id = `local_${randomID()}`;
    this.messages.push(
      newMessage({ id, role: "user", text, attachments, createdAt: at, sessionID: this.threadID, isLocalEcho: true }),
    );
    return id;
  }

  /**
   * The daemon behind this view restarted (or lost its replay log): whatever it was in the
   * middle of is gone. Forget the running turn and its half-written bubbles, and drop the
   * approval, question and password cards that belonged to the old process. `keepCards`
   * names cards the new process has already re-sent. History is reloaded separately.
   */
  resetLive(options: { keepCards?: ReadonlySet<string> } = {}): void {
    const keep = options.keepCards ?? new Set<string>();
    this.inFlightTurnID = null;
    this.inFlightThreadID = null;
    this.adoptedTurns.clear();
    this.turnAnswers.clear();
    this.turnAgents.clear();
    this.failures.clear();
    this.declinedTurns.clear();
    this.pendingTurns.clear();
    this.messages = this.messages.filter((message) => !isStreaming(message));
    this.approvals = this.approvals.filter((approval) => keep.has(approval.id));
    this.forms = this.forms.filter((form) => keep.has(form.id));
    this.secrets = this.secrets.filter((secret) => keep.has(secret.id));
  }

  /**
   * The daemon says the turn Stop was pressed on is no longer running: it finished. Stop and
   * "Writing" go away; the finished reply comes from the durable history.
   */
  finishTurnLocally(): void {
    const turnID = this.inFlightTurnID;
    this.inFlightTurnID = null;
    this.inFlightThreadID = null;
    if (turnID !== null) {
      this.adoptedTurns.delete(turnID);
      this.turnAgents.delete(turnID);
      // A half-drawn bubble would outlive the reload (history keeps bubbles still streaming).
      this.messages = this.messages.filter((message) => !(message.turnID === turnID && isStreaming(message)));
    }
  }

  /** Take back a local echo the daemon refused, so the text can go back to the composer. */
  discardLocalEcho(id: string): void {
    this.messages = this.messages.filter((message) => !(message.id === id && message.isLocalEcho));
  }

  markLocalFailure(id: string, reason: string): void {
    const message = this.messages.find((candidate) => candidate.id === id);
    if (message) message.state = { kind: "failed", reason };
  }

  resolveApproval(id: string, decision: Decision | string): void {
    const approval = this.approvals.find((candidate) => candidate.id === id);
    if (approval) approval.decision = decision;
  }

  resolveForm(id: string, answer: string): void {
    const form = this.forms.find((candidate) => candidate.id === id);
    if (form) form.answer = answer;
  }

  resolveSecret(id: string): void {
    this.secrets = this.secrets.filter((secret) => secret.id !== id);
  }

  note(notice: NoticeRow): void {
    this.notices.push(notice);
    if (this.notices.length > Conversation.noticeCap) {
      this.notices.splice(0, this.notices.length - Conversation.noticeCap);
    }
  }

  dismissNotices(): void {
    this.notices = [];
  }

  /** Point the transcript at a thread (or at "the next new thread" when null). */
  watch(threadID: string | null, title: string | null = null, agentID: string | null = null): void {
    this.threadID = threadID;
    this.title = title;
    if (agentID) this.agentID = agentID;
    this.inFlightTurnID = null;
    this.inFlightThreadID = null;
    this.turnAnswers.clear();
    this.messages = [];
  }

  /** Bind the transcript to the one conversation surface (v2). */
  bind(conversationID: string, agentID: string | null, sessionID: string | null): void {
    this.conversationID = conversationID;
    if (agentID) this.agentID = agentID;
    this.threadID = sessionID && sessionID.length > 0 ? sessionID : null;
    this.title = null;
    this.inFlightTurnID = null;
    this.inFlightThreadID = null;
    this.adoptedTurns.clear();
    this.turnAnswers.clear();
    this.adoptPendingTurns();
  }

  /** Decide the turns that began before this chat knew its conversation: ours are picked up, others declined. */
  private adoptPendingTurns(): void {
    const pending = [...this.pendingTurns];
    this.pendingTurns.clear();
    for (const [turnID, turn] of pending) {
      if (turn.conversationID !== this.conversationID) {
        this.declinedTurns.add(turnID);
        continue;
      }
      this.adoptedTurns.add(turnID);
      this.turnAgents.set(turnID, turn.agentID);
      this.inFlightTurnID = turnID;
      this.inFlightThreadID = turn.threadID;
      this.messages.push(
        newMessage({
          id: Conversation.assistantID(turnID),
          role: "assistant",
          text: "",
          createdAt: new Date(),
          turnID,
          agentID: turn.agentID,
          sessionID: turn.threadID,
          state: { kind: "streaming" },
          isBackground: this.threadID !== null && this.threadID !== turn.threadID,
          // The replay's tokens went by before the chat was bound: the start of the reply is not here.
          isContinuation: true,
        }),
      );
    }
  }

  /** A session block boundary arrived: everything after this lands in the new block. */
  startSession(sessionID: string, conversationID: string | null = null): void {
    this.threadID = sessionID;
    if (conversationID) this.conversationID = conversationID;
  }

  // MARK: durable state

  loadHistory(
    threadID: string,
    title: string | null,
    agentID: string | null,
    incoming: MessageInfo[],
  ): void {
    this.threadID = threadID;
    if (title) this.title = title;
    if (agentID) this.agentID = agentID;
    this.replaceDurable(incoming);
  }

  /** The conversation transcript across session blocks (v2). */
  loadConversationHistory(conversationID: string, agentID: string | null, incoming: MessageInfo[]): void {
    this.conversationID = conversationID;
    if (agentID) this.agentID = agentID;
    this.replaceDurable(incoming);
  }

  /**
   * Rebuild from the server's copy. Anything still streaming or echoed lives
   * only in this process: keep it. Keep a partial answer that has content, but
   * discard an empty streaming placeholder when durable history arrives
   * before the first token.
   */
  private replaceDurable(incoming: MessageInfo[]): void {
    const rebuilt: ChatMessage[] = incoming.map((info) =>
      newMessage({
        id: info.id,
        role: (info.role === "user" || info.role === "assistant" || info.role === "system"
          ? info.role
          : "system") as MessageRole,
        text: info.text,
        attachments: info.attachments,
        createdAt: parseISO(info.createdAt),
        turnID: info.turnID ?? null,
        sessionID: info.sessionID ?? null,
        senderName: info.senderName ?? null,
        senderColor: info.senderColor ?? null,
        toAgentId: info.toAgentId ?? null,
        uiHint: info.uiHint ?? null,
        ...(info.role === "assistant" && info.stopReason !== undefined
          ? {
              stopKnown: true,
              state:
                info.stopReason === "end" || info.stopReason === "needs_input"
                  ? ({ kind: "complete" } as const)
                  : ({ kind: "stopped", reason: info.stopReason } as const),
            }
          : {}),
      }),
    );

    const streaming = this.messages.filter((message) => isStreaming(message) && message.text.length > 0);
    const echoes = this.messages.filter(
      (message) => message.isLocalEcho && !(message.state.kind === "failed" && message.state.reason === ""),
    );
    rebuilt.push(...streaming);
    for (const echo of echoes) {
      if (!rebuilt.some((message) => message.role === "user" && message.text === echo.text)) {
        rebuilt.push(echo);
      }
    }
    // Survivors predate the blocks they stream into; stamp them with the
    // active block so a seam renders the instant history reloads.
    for (const message of rebuilt) {
      if (message.sessionID === null) message.sessionID = this.threadID;
    }
    this.messages = rebuilt;
  }

  /**
   * Re-mark replies that did not finish. History carries no stop reason, so
   * the app remembers the reasons it saw on `turn.end` and hands them back
   * after a reload; the last answer of each such turn gets its marker again.
   */
  restoreStops(stops: Readonly<Record<string, string>>): void {
    for (const [turnID, reason] of Object.entries(stops)) {
      if (reason === "end" || reason === "needs_input") continue;
      for (let index = this.messages.length - 1; index >= 0; index -= 1) {
        const message = this.messages[index];
        if (!message || message.turnID !== turnID || message.role !== "assistant") continue;
        if (message.stopKnown) break;
        if (message.state.kind === "complete") message.state = { kind: "stopped", reason };
        break;
      }
    }
  }

  // MARK: frames

  apply(frame: IncomingFrame): ConversationEffect[] {
    if ("__unknown" in frame) return [];

    switch (frame.type) {
      case "hello.ok":
        // A new connection invalidates any card left over from a daemon
        // restart; the server re-sends requests that are still pending.
        this.secrets = [];
        return [];

      case "conversation.ok":
      case "conversation.history.ok":
      case "thread.export.ok":
      case "thread.list.ok":
      case "thread.history.ok":
      case "job.list.ok":
      case "task.list.ok":
      case "task.create.ok":
      case "task.list.create.ok":
      case "task.activity.ok":
      case "task.update.ok":
      case "memory.list.ok":
      case "memory.update.ok":
      case "memory.pin.ok":
      case "memory.forget.ok":
      case "memory.conflicts.list.ok":
      case "memory.conflict.resolve.ok":
      case "provider.add.ok":
      case "provider.models.ok":
      case "provider.auth.started":
      case "provider.auth.state":
      case "plugin.list.ok":
      case "plugin.connect.ok":
      case "plugin.state":
      case "appearance.list.ok":
      case "appearance.updated":
      case "push.vapid":
      case "agent.proactivity":
      // Group channels are a roster concern; a group's messages arrive as msg.new.
      case "channel.created":
      case "channel.list.ok":
      case "channel.history.ok":
        return [];

      // The "Always allow" rules live in the app's settings state, not in a transcript.
      case "approval.rules.list.ok":
      case "approval.rule.revoke.ok":
        return [];

      case "approval.closed":
        // The card is no longer actionable (answered here or elsewhere, timed
        // out, or its turn ended). The id spaces of approvals and forms are
        // separate, so `kind` says which list the card is in.
        if (frame.kind === "approval") {
          this.approvals = this.approvals.filter((approval) => approval.id !== frame.requestID);
        } else {
          this.forms = this.forms.filter((form) => form.id !== frame.requestID);
        }
        return [];

      case "presence":
        return [{ kind: "presence", online: frame.state === "online" }];

      case "agent.presence":
        return [{ kind: "agentPresence", agentID: frame.agentId, state: frame.state }];

      case "task.updated":
      case "task.answer.ok":
        return [{ kind: "taskChanged", task: frame.task }];

      case "bind.direct.ok":
        return [{
          kind: "bound",
          agentID: frame.agentID,
          conversationID: frame.conversationID,
          sessionID: frame.sessionID,
          channelID: frame.channelID,
        }];

      case "agents.update":
        return [{ kind: "agentsChanged", agents: frame.agents }];

      case "status.update":
        return [];

      case "msg.new": {
        const role: MessageRole =
          frame.fromType === "user" ? "user" : frame.fromType === "system" ? "system" : "assistant";
        if (this.messages.some((message) => message.id === frame.id)) return [];
        if (role === "user") {
          const echo = this.messages.find((message) => message.isLocalEcho && message.text === frame.text && JSON.stringify(message.attachments?.map((file) => file.id) ?? []) === JSON.stringify(frame.attachments?.map((file) => file.id) ?? []));
          if (echo) {
            echo.id = frame.id;
            echo.isLocalEcho = false;
            echo.senderName = frame.senderName;
            echo.attachments = frame.attachments;
            return [];
          }
        }
        // An ordinary answer is its own bubble: seal the text that streamed for
        // this step under the durable id, then let the next token open a fresh
        // bubble. Progress and notices were never part of the answer, so they
        // are always separate rows.
        const isAnswer = role === "assistant" && (frame.uiHint === undefined || frame.uiHint === "normal");
        if (isAnswer) {
          const streamed = this.messages.find(
            (message) => message.id === Conversation.assistantID(this.inFlightTurnID ?? "") && isStreaming(message),
          );
          if (streamed) {
            streamed.id = frame.id;
            streamed.text = frame.text;
            streamed.createdAt = parseISO(frame.createdAt);
            streamed.state = { kind: "complete" };
            streamed.isContinuation = false;
            streamed.senderName = frame.senderName;
            streamed.senderColor = frame.senderColor ?? null;
            streamed.uiHint = frame.uiHint ?? null;
            streamed.agentID = frame.fromId;
            if (this.inFlightTurnID) {
              streamed.turnID = this.inFlightTurnID;
              this.turnAnswers.set(this.inFlightTurnID, frame.id);
            }
            this.openStreamingBubble(frame.fromId);
            return [];
          }
        }
        this.messages.push(
          newMessage({
            id: frame.id,
            role,
            text: frame.text,
            attachments: frame.attachments,
            createdAt: parseISO(frame.createdAt),
            agentID: role === "assistant" ? frame.fromId : null,
            senderName: frame.senderName,
            senderColor: frame.senderColor ?? null,
            toAgentId: frame.toAgentId ?? null,
            uiHint: frame.uiHint ?? null,
            taskId: frame.taskId ?? null,
            questionId: frame.questionId ?? null,
          }),
        );
        if (isAnswer && this.inFlightTurnID) this.turnAnswers.set(this.inFlightTurnID, frame.id);
        // The in-flight answer bubble was created at turn.start, before the
        // progress update. Keep it last so progress reads above the answer.
        if (role === "assistant" && frame.uiHint === "progress") {
          const streamedIndex = this.messages.findIndex(
            (message) => message.id === Conversation.assistantID(this.inFlightTurnID ?? "") && isStreaming(message),
          );
          if (streamedIndex >= 0 && streamedIndex < this.messages.length - 1) {
            const [streamed] = this.messages.splice(streamedIndex, 1);
            if (streamed) this.messages.push(streamed);
          }
        }
        return [];
      }

      case "agent.updated": {
        for (const message of this.messages) {
          if (message.uiHint === "onboarding_name_prompt") {
            message.uiHint = "onboarding_completed";
            message.senderName = frame.displayName;
          }
        }
        return [];
      }

      case "session.start":
        this.startSession(frame.sessionID, frame.conversationID);
        return [];

      case "turn.start": {
        const isOurs = this.belongsTo(frame.threadID, frame.conversationID ?? null);
        if (!isOurs && this.conversationID === null && frame.conversationID !== undefined) {
          // Not known yet whose this is: the chat has not learned its conversation. Judge it at bind.
          this.pendingTurns.set(frame.turnID, { threadID: frame.threadID, conversationID: frame.conversationID, agentID: frame.agentID });
          return [{ kind: "refreshThreadList" }];
        }
        if (!isOurs) {
          this.declinedTurns.add(frame.turnID);
          for (const old of [...this.declinedTurns].slice(0, Math.max(0, this.declinedTurns.size - 100))) this.declinedTurns.delete(old);
          return [{ kind: "unread", threadID: frame.threadID }, { kind: "refreshThreadList" }];
        }
        if (frame.conversationID !== undefined || this.threadID === frame.threadID) {
          this.adoptedTurns.add(frame.turnID);
        }
        this.turnAgents.set(frame.turnID, frame.agentID);
        // A turn bound in by conversation but running in a block other than the
        // open one is background work (a reminder, a brief), not the owner's chat.
        const isBackground =
          frame.conversationID !== undefined && this.threadID !== null && this.threadID !== frame.threadID;
        this.adopt(frame.threadID);
        this.inFlightTurnID = frame.turnID;
        this.inFlightThreadID = frame.threadID;
        const id = Conversation.assistantID(frame.turnID);
        const existing = this.messages.find((message) => message.id === id);
        if (existing) {
          existing.state = { kind: "streaming" };
          if (existing.sessionID === null) existing.sessionID = frame.threadID;
        } else {
          this.messages.push(
            newMessage({
              id,
              role: "assistant",
              text: "",
              createdAt: new Date(),
              turnID: frame.turnID,
              agentID: frame.agentID,
              sessionID: frame.threadID,
              state: { kind: "streaming" },
              isBackground,
            }),
          );
        }
        return [];
      }

      case "token": {
        if (this.declinedTurns.has(frame.turnID)) return [];
        const adopted = this.adoptedTurns.has(frame.turnID);
        // With no turn.start seen, only a block this chat already knows is proof the turn is its own:
        // a chat that has not learned its block yet (just switched to) would take any bot's tokens.
        if (!adopted && !(this.threadID !== null && this.threadID === frame.threadID)) return [];
        const id = Conversation.assistantID(frame.turnID);
        const message = this.messages.find((candidate) => candidate.id === id);
        if (message) {
          message.text = frame.reset ? frame.delta : message.text + frame.delta;
        } else {
          // Replayed deltas without their turn.start: rebuild the bubble.
          this.inFlightTurnID = frame.turnID;
          this.inFlightThreadID = frame.threadID;
          this.messages.push(
            newMessage({
              id,
              role: "assistant",
              text: frame.delta,
              createdAt: new Date(),
              turnID: frame.turnID,
              agentID: this.agentID,
              sessionID: frame.threadID,
              state: { kind: "streaming" },
              // No turn.start was seen, so the start of this reply is not here.
              isContinuation: true,
            }),
          );
        }
        return [];
      }

      case "turn.end": {
        const adopted = this.adoptedTurns.delete(frame.turnID);
        const wasDeclined = this.declinedTurns.delete(frame.turnID);
        this.pendingTurns.delete(frame.turnID);
        const isOurs =
          adopted ||
          this.belongsTo(frame.threadID, frame.conversationID ?? null) ||
          this.inFlightTurnID === frame.turnID;
        const id = Conversation.assistantID(frame.turnID);
        const message = this.messages.find((candidate) => candidate.id === id);
        const answerID = this.turnAnswers.get(frame.turnID);
        this.turnAgents.delete(frame.turnID);
        if (message) {
          if (message.text.length === 0 && answerID !== undefined) {
            // The answer was sealed under its durable id; this is only the
            // empty bubble opened for a next step that never came.
            this.messages = this.messages.filter((candidate) => candidate !== message);
          } else if (
            message.text.length === 0 &&
            message.isBackground &&
            message.tools.length === 0 &&
            frame.stopReason === "end"
          ) {
            // A background job that finished and said nothing is not a failed reply in the
            // owner's chat. One that failed or timed out keeps its bubble, so the owner
            // hears that their reminder did not run.
            this.messages = this.messages.filter((candidate) => candidate !== message);
          } else {
            // A turn that ended badly keeps the daemon's own explanation when
            // one arrived while it was running.
            if (frame.stopReason === "end") {
              message.state = { kind: "complete" };
            } else {
              const reason = this.failures.get(frame.turnID);
              if (reason !== undefined) message.state = { kind: "failed", reason };
              else message.state = { kind: "stopped", reason: frame.stopReason };
            }
            message.usage = frame.usage ?? null;
          }
        }
        if (answerID !== undefined && frame.stopReason !== "end" && frame.stopReason !== "needs_input") {
          // The streamed bubble is now a durable message, so turn.end has to
          // find it by id to mark a cancelled or failed answer honestly.
          const answer = this.messages.find((candidate) => candidate.id === answerID);
          if (answer) {
            const reason = this.failures.get(frame.turnID);
            if (reason !== undefined) answer.state = { kind: "failed", reason };
            else answer.state = { kind: "stopped", reason: frame.stopReason };
            answer.usage = frame.usage ?? null;
          }
        }
        this.turnAnswers.delete(frame.turnID);
        this.failures.delete(frame.turnID);
        // A reply this view only saw the tail of is completed from the durable copy.
        // So is a turn of this conversation whose tokens were not shown (its block was not known
        // yet): there is no bubble, but the durable history has the reply.
        const unseen = !message && !wasDeclined && isOurs && frame.stopReason === "end" && frame.conversationID !== undefined && frame.conversationID === this.conversationID && answerID === undefined;
        const pickedUpMidStream = unseen || (message?.isContinuation === true && message.text.length > 0);
        if (!isOurs) return [{ kind: "unread", threadID: frame.threadID }, { kind: "refreshThreadList" }];
        if (this.inFlightTurnID === frame.turnID) {
          this.inFlightTurnID = null;
          this.inFlightThreadID = null;
        }
        return pickedUpMidStream ? [{ kind: "refreshThreadList" }, { kind: "reloadDurableState" }] : [{ kind: "refreshThreadList" }];
      }

      case "tool.start":
        this.attach({ id: frame.callID, name: frame.name, preview: frame.preview ?? null, state: "running" });
        return [];

      case "tool.update":
        this.updateTool(frame.callID, (activity) => {
          activity.preview = frame.preview ?? null;
        });
        return [];

      case "tool.end":
        this.updateTool(frame.callID, (activity) => {
          activity.state = frame.ok ? "ok" : "failed";
          if (frame.preview !== undefined) activity.preview = frame.preview;
        });
        return [];

      case "approval.request":
        this.approvals = this.approvals.filter((approval) => approval.id !== frame.requestID);
        this.approvals.push({
          id: frame.requestID,
          action: frame.action,
          preview: frame.preview,
          decisions: frame.buttons,
          decision: null,
          isLocal: false,
          agentID: this.requestingAgentID(),
        });
        return [
          {
            kind: "notify",
            title: "Approval needed",
            body: frame.action,
            sound: true,
            need: "approval",
            agentID: this.requestingAgentID(),
          },
          { kind: "refreshThreadList" },
        ];

      case "form.request":
        this.forms = this.forms.filter((form) => form.id !== frame.requestID);
        this.forms.push({
          id: frame.requestID,
          question: frame.question,
          options: frame.options ?? [],
          answer: null,
          kind: frame.kind === "email" ? "email" : "choice",
          multiple: frame.multiple === true,
          email: frame.email ?? null,
          agentID: this.requestingAgentID(),
        });
        return [
          {
            kind: "notify",
            title: "A question for you",
            body: frame.question,
            sound: false,
            need: "question",
            agentID: this.requestingAgentID(),
          },
          { kind: "focusComposer" },
        ];

      case "secret.request":
        this.secrets = this.secrets.filter((secret) => secret.id !== frame.requestID);
        this.secrets.push({
          id: frame.requestID,
          purpose: frame.purpose,
          command: frame.command,
          kind: frame.kind,
          expiresAt: frame.expiresAt,
        });
        return [
          {
            kind: "notify",
            title: "Password needed",
            body: frame.purpose,
            sound: true,
            need: "password",
            agentID: this.requestingAgentID(),
          },
        ];

      case "secret.cancel":
        this.secrets = this.secrets.filter((secret) => secret.id !== frame.requestID);
        return [];

      case "notify":
        this.note({
          id: `note_${frame.seq}`,
          kind: "reminder",
          title: frame.title,
          body: frame.body,
          createdAt: new Date(),
          threadID: null,
        });
        return [
          {
            kind: "notify",
            title: frame.title,
            body: frame.body,
            sound: frame.sound ?? false,
            ...(frame.threadID ? { threadID: frame.threadID } : {}),
          },
        ];

      case "error": {
        // A failure mid-turn is the reason that turn will produce nothing.
        if (this.inFlightTurnID) this.failures.set(this.inFlightTurnID, frame.message);
        this.note({
          id: `err_${frame.seq}`,
          kind: "failure",
          title: frame.code,
          body: frame.message,
          createdAt: new Date(),
          threadID: this.threadID,
        });
        if (frame.code === "resync_gap") return [{ kind: "reloadDurableState" }];
        // The turn runner will end the turn too; keep the partial text honest.
        return [];
      }
    }
  }

  // MARK: helpers

  /**
   * A frame belongs to this surface when its conversation is the bound one,
   * or — legacy lane — when it is for the open block, or for the block being
   * created by our own send (`threadID == null`).
   */
  private belongsTo(threadID: string, conversationID: string | null): boolean {
    if (conversationID) return conversationID === this.conversationID;
    if (this.threadID) return this.threadID === threadID;
    return true;
  }

  /**
   * The bot whose turn is running here, which is who an approval or question
   * arriving now is from. Those frames name no bot, so with no turn in flight
   * this is null and the wording stays neutral.
   */
  private requestingAgentID(): string | null {
    return this.inFlightTurnID ? (this.turnAgents.get(this.inFlightTurnID) ?? null) : null;
  }

  private adopt(threadID: string): void {
    if (this.threadID === null) this.threadID = threadID;
  }

  /**
   * A sealed answer frees `asst_<turnID>` for the next step. Keep an empty
   * streaming bubble so the next token (and its tool activity) has a home; it
   * is removed at turn.end if the turn says nothing more.
   */
  private openStreamingBubble(agentID: string = this.agentID): void {
    if (this.inFlightTurnID === null || this.inFlightThreadID === null) return;
    const id = Conversation.assistantID(this.inFlightTurnID);
    if (this.messages.some((message) => message.id === id)) return;
    this.messages.push(
      newMessage({
        id,
        role: "assistant",
        text: "",
        createdAt: new Date(),
        turnID: this.inFlightTurnID,
        agentID,
        sessionID: this.inFlightThreadID,
        state: { kind: "streaming" },
      }),
    );
  }

  private attach(tool: ToolActivity): void {
    const index = this.streamingIndex();
    if (index !== null) {
      const message = this.messages[index];
      if (message) {
        const existing = message.tools.find((activity) => activity.id === tool.id);
        if (existing) {
          Object.assign(existing, tool);
        } else {
          message.tools.push(tool);
        }
        return;
      }
    }
    // Tool activity with no turn in flight (a background job, a replayed
    // strip): keep it as its own quiet row.
    this.messages.push(
      newMessage({
        id: `tool_${tool.id}`,
        role: "system",
        text: "",
        createdAt: new Date(),
        tools: [tool],
      }),
    );
  }

  private updateTool(callID: string, change: (activity: ToolActivity) => void): void {
    for (let messageIndex = this.messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
      const message = this.messages[messageIndex];
      if (!message) continue;
      const tool = message.tools.find((activity) => activity.id === callID);
      if (tool) {
        change(tool);
        return;
      }
    }
  }

  private streamingIndex(): number | null {
    const id = this.streamingMessageID;
    if (id !== null) {
      const index = this.messages.findIndex((message) => message.id === id);
      if (index !== -1) return index;
    }
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      const message = this.messages[index];
      if (message && isStreaming(message)) return index;
    }
    return null;
  }
}

function randomID(): string {
  const cryptoImpl = globalThis.crypto;
  if (cryptoImpl && typeof cryptoImpl.randomUUID === "function") return cryptoImpl.randomUUID();
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}
