/**
 * The approval card's mechanics. Whether a call needs the owner is the policy
 * engine's decision (`policy/engine.ts`); this file only raises the card the
 * engine asked for, waits for the answer, and writes it down.
 *
 * Approvals are durable: they live in the `approvals` table and are surfaced
 * to the client as `approval.request` frames. The decision is recorded and the
 * loop resumes (or aborts) once the client answers.
 *
 * "Always allow" is a standing rule (`stores/approval-rules.ts`): one bot, one
 * tool, one target, kept until the owner revokes it. The engine looks rules up
 * before it asks; a call a rule let through is still an approval row, so the
 * audit trail shows what ran and which rule allowed it. The card offers
 * "always" only when the engine said the call may be remembered, which it never
 * does for a run that has read outside text.
 */
import type { Database } from "bun:sqlite";
import type { ApprovalSource } from "@agni/protocol";
import { newID, nowISO } from "../util/ids";
import { redact } from "../util/redact";
import { clip, entry, escapeUnsafe, fitEntry } from "./card-text";
import { CardNotShown, describeAction, previewAction } from "./card-preview";
import { saveCardMeta } from "./pending-cards";
import type { ApprovalCard, RiskKind, TaintKind } from "../policy/types";
import { addApprovalRule, approvalTarget } from "../stores/approval-rules";

export { clip };
// The card's heading and body are drawn in `card-preview.ts`; they are re-exported here, where they have always been found.
export { describeAction, previewAction };

export type Decision = "once" | "always" | "reject";

const decisionWaiters = new Map<string, (decision: Decision) => void>();

/** Waiters are process-local; the approval row remains the durable authority. */
export function resolveApprovalWaiter(requestID: string, decision: Decision): void {
  decisionWaiters.get(requestID)?.(decision);
}

export function waitForApprovalDecision(db: Database, requestID: string, signal: AbortSignal): Promise<Decision | null> {
  const row = db.query("SELECT status, decision FROM approvals WHERE id = ?").get(requestID) as { status: string; decision: Decision | null } | null;
  if (!row) return Promise.resolve(null);
  if (row.status === "decided" && row.decision) return Promise.resolve(row.decision);
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    const finish = (decision: Decision | null): void => {
      decisionWaiters.delete(requestID);
      signal.removeEventListener("abort", onAbort);
      resolve(decision);
    };
    const onAbort = (): void => finish(null);
    decisionWaiters.set(requestID, (decision) => finish(decision));
    signal.addEventListener("abort", onAbort, { once: true });
    // Close the update-before-registration race by reading the durable row again.
    const latest = db.query("SELECT status, decision FROM approvals WHERE id = ?").get(requestID) as typeof row;
    if (latest?.status === "decided" && latest.decision) finish(latest.decision);
  });
}

export interface ApprovalRequest {
  id: string;
  threadID: string;
  turnID: string;
  toolName: string;
  callID: string;
  action: string;
  preview: string;
  status: "pending" | "decided";
  decision: Decision | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface ApprovalBrokerDeps {
  db: Database;
  emit: (frame: {
    type: "approval.request"; requestID: string; action: string; preview: string; buttons: Decision[];
    /** What outside text the run had read, newest first. Left out for a run that read none. */
    source?: ApprovalSource[];
    /** How risky the call is (0-3). */
    tier?: 0 | 1 | 2 | 3;
    /** When the card stops waiting (ISO time). */
    expiresAt?: string;
    /**
     * The owner must open the full text (`approval.full`) before allowing: the preview hides part of the call (it has a cut in it), or it
     * is more than can be taken in at a glance (over 2,000 characters or 40 lines), though every character of it is there.
     */
    truncated?: boolean;
  }) => void;
  /** Wait for a decision on a pending approval. */
  waitForDecision: (requestID: string, signal: AbortSignal) => Promise<Decision | null>;
  /**
   * A line the integration wants the owner to read with the card for this tool
   * (an MCP connector's own warning, say). Appended to the preview.
   */
  approvalNote?: (toolName: string) => string | undefined;
}

/** What the engine knows about the card, beyond the call itself. */
export interface CardInfo {
  card: ApprovalCard;
  /** The bot's name for the card ("Ava read ..."); "A bot" when it is not known. */
  botName?: string | null;
  /** The bot whose turn this is: the scope of a rule if the owner says "always". */
  agentID: string | null;
  /** When the card stops waiting (ISO time), so the owner and the client see the same deadline the wait uses. */
  expiresAt?: string;
}

/** The marks `clip` and `entry` leave where they cut something out. */
const CUT_MARKS = /\s…\s\d+ chars omitted\s…\s|… \(\+\d+ chars\) …|\nArguments given: /;

/** True when the preview has a part cut out of the middle. The owner must open the full text before allowing it. */
export function previewIsCut(preview: string): boolean {
  return CUT_MARKS.test(preview);
}

/**
 * How much of a card the owner can take in at a glance: the most characters and lines a preview may have before the card is marked
 * `truncated`. The web card's box is small, and a card the owner has not read to the end must not be allowed on a glance.
 */
export const FULL_VIEW_MAX_CHARS = 2_000;
export const FULL_VIEW_MAX_LINES = 40;

/**
 * True when the preview is more than the owner takes in at a glance (over 2,000 characters or 40 lines). The card is then marked
 * `truncated` even though nothing is cut: the flag means "the owner must open the full text before Allow", and `approval.full` answers
 * with the whole preview (`ws/approval-full.ts`).
 */
export function previewNeedsFullView(preview: string): boolean {
  return preview.length > FULL_VIEW_MAX_CHARS || preview.split("\n").length > FULL_VIEW_MAX_LINES;
}

export class ApprovalBroker {
  constructor(private readonly deps: ApprovalBrokerDeps) {}

  /** Returns the decision (or null if the caller aborted). */
  async request(
    threadID: string,
    turnID: string,
    toolName: string,
    callID: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    info?: CardInfo,
  ): Promise<Decision | null> {
    const action = redact(describeAction(toolName, args));
    const note = this.deps.approvalNote?.(toolName);
    const bot = info?.botName?.trim() || "A bot";
    // Throws (and nothing is stored or sent) when the call cannot be shown whole: the engine refuses such a call before it gets here.
    const body = previewAction(toolName, args, bot, { card: info?.card, db: this.deps.db, agentID: info?.agentID });
    const lead = info ? cardLead(info.card, bot) : "";
    const preview = redact(`${lead}${note ? `${body}\n\n${escapeUnsafe(note)}` : body}`);
    const { db } = this.deps;
    const requestID = newID("apr");
    // The rule's scope: this turn's bot, this tool, this exact target. A card the
    // engine said may not be remembered never offers "always".
    const target = info?.card.canRemember && info.agentID ? approvalTarget(toolName, args) : null;
    const scope = info?.agentID && target !== null ? { agentID: info.agentID, target } : null;
    const truncated = previewIsCut(preview) || previewNeedsFullView(preview);
    const source = info ? approvalSources(info.card) : [];
    const tier = info ? info.card.tier : undefined;
    const expiresAt = info?.expiresAt;

    db.run(
      `INSERT INTO approvals (id, thread_id, turn_id, action, preview, status, decision, call_id, tool_name, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?)`,
      [requestID, threadID, turnID, action, preview, callID, toolName, nowISO()],
    );
    // What the card said besides its text, kept with the row so a card replayed on reconnect is the same card.
    saveCardMeta(db, requestID, {
      ...(source.length > 0 ? { source } : {}),
      ...(tier !== undefined ? { tier } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      truncated,
      canRemember: scope !== null,
    });

    this.deps.emit({
      type: "approval.request", requestID, action, preview, buttons: scope ? ["once", "always", "reject"] : ["once", "reject"],
      ...(source.length > 0 ? { source } : {}),
      ...(tier !== undefined ? { tier } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      truncated,
    });

    const decision = await this.deps.waitForDecision(requestID, signal);
    if (decision === "always" && scope) addApprovalRule(db, { ...scope, toolName, approvalID: requestID });
    return decision;
  }

  /**
   * A call a standing rule let through is still an approval row, so the audit
   * trail shows what ran and which rule allowed it.
   */
  recordRuleApproval(
    threadID: string, turnID: string, toolName: string, callID: string, args: Record<string, unknown>,
    rule: { id: string; agentID: string; toolName: string; createdAt: string },
  ): void {
    const action = redact(describeAction(toolName, args));
    const note = this.deps.approvalNote?.(toolName);
    const body = recordedBody(toolName, args, { db: this.deps.db, agentID: rule.agentID });
    const preview = redact(note ? `${body}

${escapeUnsafe(note)}` : body);
    const when = nowISO();
    this.deps.db.run(
      `INSERT INTO approvals (id, thread_id, turn_id, action, preview, status, decision, call_id, tool_name, created_at, decided_at, rule_id)
       VALUES (?, ?, ?, ?, ?, 'decided', 'always', ?, ?, ?, ?, ?)`,
      [
        newID("apr"), threadID, turnID,
        `${action} [auto-approved by standing rule ${rule.id}]`,
        `${preview}

Auto-approved by standing rule ${rule.id}: "Always allow" for ${rule.agentID} / ${rule.toolName}, given ${rule.createdAt}. Revoke the rule to be asked again.`,
        callID, toolName, when, when, rule.id,
      ],
    );
  }
}

/**
 * What the audit row of a call a stored rule let through says of the call. A call that cannot be shown whole (too long for a card, or
 * naming a routine that is not there) was never put on one (a rule answered, nobody was asked), but the row still records what ran:
 * the reason it could not be shown, and the start and the end of it, cut in the middle and marked. The database is passed so a call
 * drawn from it (resuming a routine) is shown the way a card shows it.
 */
function recordedBody(toolName: string, args: Record<string, unknown>, options: { db: Database; agentID: string }): string {
  try {
    return previewAction(toolName, args, "A bot", options);
  } catch (error) {
    const why = error instanceof CardNotShown ? entry(error.message, 300) : "could not be drawn";
    return `${describeAction(toolName, args)}\n\n(${why}; the start and the end are kept)\n${escapeUnsafe(clip(JSON.stringify(args, null, 2) ?? "{}", 4_000), true)}`;
  }
}

/** The protocol's name for each kind of outside text a run can have read. */
const SOURCE_KIND: Record<TaintKind, ApprovalSource["kind"]> = {
  web: "web", email: "email", peer: "agent", attachment: "attachment", mcp: "connector", routine: "scheduled", scheduled: "scheduled", history: "unknown", unknown: "unknown",
};

/** The card's sources as the frame carries them: newest first, one line each, hidden characters shown as escapes (a label is a page title or a sender name: outside text). */
function approvalSources(card: ApprovalCard): ApprovalSource[] {
  return card.sources.slice(0, 20).map((source) => ({ kind: SOURCE_KIND[source.kind] ?? "unknown", ...(source.label ? { label: fitEntry(source.label, 300) } : {}) }));
}

const RISK_LINE: Record<RiskKind, string> = {
  undoable: "Risk: changes something you can undo",
  egress: "Risk: sends data out of this app",
  irreversible: "Risk: cannot be undone",
  either: "Risk: sends data out of this app, or changes something you cannot undo",
  command: "Risk: runs a command on this computer",
  standing: "Risk: starts work that repeats by itself, with no further question, until you cancel it",
};

const SOURCE_LINE: Record<string, (bot: string, label: string) => string> = {
  web: (bot, label) => `${bot} read a web page earlier in this task: ${label}`,
  email: (bot, label) => `${bot} read an email earlier in this task: ${label}`,
  peer: (bot, label) => `${bot} read a reply from ${label} earlier in this task.`,
  attachment: (bot, label) => `${bot} read an attached file earlier in this task: ${label}`,
  mcp: (bot, label) => `${bot} read ${label} earlier in this task.`,
  routine: () => "This task started from saved routine state, not from you.",
  scheduled: () => "This task started from a scheduled job, not from you.",
  history: (bot) => `${bot} is carrying on a conversation in which an earlier run read outside content.`,
  unknown: (bot) => `${bot} read outside content earlier in this task.`,
};

/**
 * The lines above the call on a card that the engine added: where the outside
 * content came from, how risky the call is, and why there is no "always".
 * The labels are outside text (a page title, a sender), so each goes through the card text escape here, whatever was done to it when it was taken.
 */
function cardLead(card: ApprovalCard, bot: string): string {
  const lines: string[] = [];
  // First: the owner said no to something in this run, and this command may reach it (policy/engine.ts).
  if (card.refusedRun) lines.push(escapeUnsafe(card.refusedRun));
  if (card.standingRule) lines.push(escapeUnsafe(card.standingRule));
  if (card.standingTainted) lines.push("If you approve, every run of this job starts with the restrictions of the outside content this task read: it may not change bots, schedules or rules, and it asks you before it sends anything out.");
  if (card.standingNarrowed) lines.push("If you approve, every run of this job runs with the tools of the run that asked, not with everything this bot can use.");
  const [newest, ...older] = card.sources;
  if (newest) {
    const say = SOURCE_LINE[newest.kind] ?? SOURCE_LINE.unknown!;
    lines.push(`${say(bot, entry(newest.label, 300))}${older.length > 0 ? ` (and ${older.length} more)` : ""}`);
  }
  lines.push(RISK_LINE[card.risk]);
  if (card.unnamedDestinations.length > 0) {
    lines.push(`Not named by you: ${card.unnamedDestinations.map((destination) => entry(destination, 200)).join(", ")}`);
    lines.push("This destination is not in your messages or your approved list.");
  }
  if (newest) lines.push("\"Always allow\" is off: this task used outside content.");
  if (card.refusedRun) lines.push("\"Always allow\" is off: you refused something in this task.");
  if (card.standingRule) lines.push("\"Always allow\" is off: work that starts again on its own is always put to you.");
  return `${lines.join("\n")}\n\n`;
}
