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
import { clip, entry, escapeUnsafe, fitEntry, quoted } from "./card-text";
import { saveCardMeta } from "./pending-cards";
import type { ApprovalCard, RiskKind, TaintKind } from "../policy/types";
import { isOutsideScratch, resolveWritePath, scratchDir, writeTargetExists } from "../tools/write-file";
import { addApprovalRule, approvalTarget } from "../stores/approval-rules";
import { describeRecurring, isRecurringSchedule } from "../policy/standing-rules";

export { clip };

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
    /** The preview hides part of the call: the owner opens the full text before allowing. */
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
    const body = previewAction(toolName, args, bot);
    const lead = info ? cardLead(info.card, bot) : "";
    const preview = redact(`${lead}${note ? `${body}\n\n${escapeUnsafe(note)}` : body}`);
    const { db } = this.deps;
    const requestID = newID("apr");
    // The rule's scope: this turn's bot, this tool, this exact target. A card the
    // engine said may not be remembered never offers "always".
    const target = info?.card.canRemember && info.agentID ? approvalTarget(toolName, args) : null;
    const scope = info?.agentID && target !== null ? { agentID: info.agentID, target } : null;
    const truncated = previewIsCut(preview);
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
    const body = previewAction(toolName, args);
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

/** The protocol's name for each kind of outside text a run can have read. */
const SOURCE_KIND: Record<TaintKind, ApprovalSource["kind"]> = {
  web: "web", email: "email", peer: "agent", attachment: "attachment", mcp: "connector", routine: "scheduled", scheduled: "scheduled", unknown: "unknown",
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

/** An argument for display. A missing one reads as "(not given)", never "?" or "undefined". */
function shown(value: unknown, max = 400): string {
  if (value === undefined || value === null || value === "") return "(not given)";
  return escapeUnsafe(clip(typeof value === "string" ? value : JSON.stringify(value) ?? "(not given)", max));
}

/** The arguments with every long string cut in the middle (start and end kept), for the JSON view. */
function boundedArgs(value: unknown, max: number): unknown {
  if (typeof value === "string") return clip(value, max);
  if (Array.isArray(value)) return value.map((item) => boundedArgs(item, max));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, boundedArgs(item, max)]));
  return value;
}

function describeAction(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "bash": return `run shell: ${shown(String(args.command ?? ""), 400)}`;
    case "write_file": {
      const path = typeof args.path === "string" ? args.path : "";
      const exists = path !== "" && !isOutsideScratch(path, scratchDir()) && writeTargetExists(path);
      const label = !exists ? "write file" : args.append === true ? "append to existing file" : "overwrite existing file";
      return `${label}: ${shown(path)}`;
    }
    case "read_file": return `read file: ${shown(args.path)}`;
    case "memory_write": return `save memory: ${entry(String(args.text ?? ""), 80)}`;
    case "link_save": return `save link: ${shown(args.url)}`;
    case "task_create": return `add task: ${shown(args.title)}`;
    case "task_update": return `update task ${shown(args.id)}`;
    case "mail_send": return `send email to ${Array.isArray(args.to) ? shown(args.to.map((to) => entry(to)).join(", ")) : shown(args.to)}: ${entry(String(args.subject ?? ""), 80)}`;
    case "job_schedule": return isRecurringSchedule(args) ? `start a repeating job: ${describeRecurring(args)}` : `job_schedule(${escapeUnsafe(clip(JSON.stringify(args), 400))})`;
    case "rename_agent": return args.agentId ? `rename ${shown(args.agentId)} to ${shown(args.name)}` : `rename the assistant to ${shown(args.name)}`;
    default: return `${entry(toolName, 80)}(${escapeUnsafe(clip(JSON.stringify(args), 400))})`;
  }
}

function previewAction(toolName: string, args: Record<string, unknown>, bot = "A bot"): string {
  if (toolName === "bash") return quoted(String(args.command ?? ""), 4_000);
  if (toolName === "job_schedule" && isRecurringSchedule(args)) return repeatingJobPreview(args, bot);
  if (toolName === "mail_send") return [...audienceLines(args), describeAction(toolName, args), "", quoted(String(args.body ?? ""), 4_000)].join("\n");
  if (toolName === "write_file" && typeof args.path === "string") {
    // The path the write really lands on: a relative path means under scratch,
    // and a link is followed. This is also what "always allow" would remember.
    const real = resolveWritePath(args.path);
    return `${describeAction(toolName, args)}

Resolved path: ${real === null || real === undefined ? "(cannot be resolved)" : entry(real, 1_000)}`;
  }
  return fullCall(toolName, args);
}

/**
 * A repeating job: who it is for, when it runs in words, and the prompt it will run each time, quoted as data (the bot wrote it, and
 * it will run without anyone reading it again). Every other argument it was given is named too.
 */
function repeatingJobPreview(args: Record<string, unknown>, bot: string): string {
  const lines = [
    `Bot: ${entry(bot, 80)}`,
    `Runs: ${describeRecurring(args)}`,
    `${entry(bot, 80)} would run this each time, on its own:`,
    quoted(String(args.text ?? ""), 4_000),
  ];
  const others = Object.keys(args).filter((name) => !["text", "dailyAt", "days", "everyMinutes"].includes(name));
  if (others.length > 0) lines.push("", `Also given: ${others.map((name) => `${entry(name, 40)} = ${entry(args[name], 80)}`).join(", ")}`);
  return lines.join("\n");
}

/** How much of a call's arguments the card shows: enough that padding cannot push anything out of sight. */
const PREVIEW_ARGS_CHARS = 4_000;
/** One string in the arguments view. */
const PREVIEW_ARG_STRING_CHARS = 1_000;

/**
 * A card for a tool that has no preview of its own: the whole call, not a cut
 * of its first and last 200 characters. Who the call reaches (recipients and
 * attendees) comes first, in plain lines, because an argument list long enough
 * to be cut would otherwise be able to hide them. A cut list also names every
 * argument and its size.
 */
function fullCall(toolName: string, args: Record<string, unknown>): string {
  const json = escapeUnsafe(JSON.stringify(boundedArgs(args, PREVIEW_ARG_STRING_CHARS), null, 2) ?? "{}", true);
  const sizes = Object.entries(args).map(([name, value]) => `${entry(name, 80)} (${(typeof value === "string" ? value : JSON.stringify(value) ?? "").length} chars)`);
  const body = json.length > PREVIEW_ARGS_CHARS ? `${clip(json, PREVIEW_ARGS_CHARS)}\n\nArguments given: ${sizes.join(", ")}` : json;
  return [...audienceLines(args), `${entry(toolName, 80)} with these arguments:`, "", body].join("\n");
}

/** Argument names that hold the people a call reaches. */
const AUDIENCE_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["to", "To"], ["cc", "Cc"], ["bcc", "Bcc"], ["attendees", "Attendees"],
  ["recipients", "Recipients"], ["emails", "Emails"], ["invitees", "Invitees"], ["guests", "Guests"], ["participants", "Participants"],
];
const AUDIENCE_SHOWN = 50;

/** The people a call reaches, one line per kind with how many there are, ahead of everything else. */
function audienceLines(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, label] of AUDIENCE_KEYS) {
    const value = args[key];
    const names = Array.isArray(value) ? value : typeof value === "string" && value ? [value] : [];
    if (names.length === 0) continue;
    const more = names.length > AUDIENCE_SHOWN ? `, … (+${names.length - AUDIENCE_SHOWN} more)` : "";
    out.push(`${label} (${names.length}): ${names.slice(0, AUDIENCE_SHOWN).map((name) => entry(name)).join(", ")}${more}`);
  }
  return out;
}
