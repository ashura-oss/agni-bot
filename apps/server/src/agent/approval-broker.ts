/**
 * HITL approval broker. Only actions that can *destroy* state pause the loop:
 * destructive shell, writes outside the scratch tree, sends from the owner's
 * mailbox, and payment-style tools. Everything reversible runs free — reading,
 * research, memory, links, tasks, renames, and handoffs.
 *
 * Known reversible tools are listed in `FREE_TOOLS`: a prompt on every
 * reversible step trains the owner to click Allow without reading. Anything
 * not listed (a new tool, an MCP plugin tool) gates by default — a new
 * reversible tool must be added to `FREE_TOOLS` to run free.
 *
 * Approvals are durable: they live in the `approvals` table and are surfaced
 * to the client as `approval.request` frames. The decision is recorded and the
 * loop resumes (or aborts) once the client answers.
 *
 * "Always allow" is a standing rule (`stores/approval-rules.ts`): one bot, one
 * tool, one target, kept until the owner revokes it. Before a card is raised
 * an active matching rule answers instead, and that answer is still recorded as
 * an approval row so the audit trail shows what ran and which rule allowed it.
 */
import type { Database } from "bun:sqlite";
import { newID, nowISO } from "../util/ids";
import { isReadOnlyCommand } from "../tools/bash";
import { isOutsideScratch, resolveWritePath, scratchDir, writeTargetExists } from "../tools/write-file";
import { MCP_FREE_TOOLS } from "../plugins/mcp";
import { addApprovalRule, agentForTurn, approvalTarget, findApprovalRule } from "../stores/approval-rules";

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
  emit: (frame: { type: "approval.request"; requestID: string; action: string; preview: string; buttons: Decision[] }) => void;
  /** Wait for a decision on a pending approval. */
  waitForDecision: (requestID: string, signal: AbortSignal) => Promise<Decision | null>;
  /**
   * Why a call's arguments break the tool's schema, or null (the registry's
   * `validateArgs`). A call that fails never raises a card: the tool refuses
   * it with an error that names the field, so the owner is not asked about
   * an action that cannot run.
   */
  validate?: (toolName: string, args: Record<string, unknown>) => string | null;
  /**
   * A line the integration wants the owner to read with the card for this tool
   * (an MCP connector's own warning, say). Appended to the preview.
   */
  approvalNote?: (toolName: string) => string | undefined;
}

/** Tools that cannot destroy state or reach outside scratch. Everything else asks. */
const FREE_TOOLS = new Set([
  "ask", "say", "request_owner_input", "expand", "draft_email", "read_artifact", "scratch_read", "scratch_append",
  // Only unlocks tools already on the agent's allowlist; each of those still gates on its own.
  "load_tools",
  "memory_search", "memory_write", "transcript_search", "links_search", "link_save",
  "tasks_list", "task_create", "task_update", "task_status", "task_cancel",
  "remember_fact", "recall_fact", "get_fact", "forget_fact",
  // Confined to the scratch tree by the tools themselves.
  "read_file", "grep", "glob",
  "web_search", "web_fetch", "deep_research", "mail_search", "mail_read", "calendar_list", "drive_search", "drive_read",
  "skills_list", "skills_load", "skills_resource",
  "handoff", "delegate_task", "delegate_wait", "rename_agent", "create_agent", "update_agent", "share_thread",
  "job_schedule", "job_list", "job_cancel", "routine_create", "routine_list", "routine_pause", "routine_delete",
]);

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
  ): Promise<Decision | null> {
    const action = describeAction(toolName, args);
    const note = this.deps.approvalNote?.(toolName);
    const preview = note ? `${previewAction(toolName, args)}\n\n${escapeUnsafe(note)}` : previewAction(toolName, args);
    const { db } = this.deps;
    const requestID = newID("apr");
    // The rule's scope: this turn's bot, this tool, this exact target. Without
    // a bot or a target there is nothing to scope a rule to, so we always ask.
    const agentID = agentForTurn(db, threadID, turnID);
    const target = approvalTarget(toolName, args);
    const scope = agentID && target !== null ? { agentID, target } : null;

    const rule = scope ? findApprovalRule(db, scope.agentID, toolName, scope.target) : null;
    if (rule) {
      const when = nowISO();
      db.run(
        `INSERT INTO approvals (id, thread_id, turn_id, action, preview, status, decision, call_id, tool_name, created_at, decided_at, rule_id)
         VALUES (?, ?, ?, ?, ?, 'decided', 'always', ?, ?, ?, ?, ?)`,
        [
          requestID, threadID, turnID,
          `${action} [auto-approved by standing rule ${rule.id}]`,
          `${preview}

Auto-approved by standing rule ${rule.id}: "Always allow" for ${rule.agentID} / ${rule.toolName}, given ${rule.createdAt}. Revoke the rule to be asked again.`,
          callID, toolName, when, when, rule.id,
        ],
      );
      return "always";
    }

    db.run(
      `INSERT INTO approvals (id, thread_id, turn_id, action, preview, status, decision, call_id, tool_name, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?)`,
      [requestID, threadID, turnID, action, preview, callID, toolName, nowISO()],
    );

    this.deps.emit({ type: "approval.request", requestID, action, preview, buttons: scope ? ["once", "always", "reject"] : ["once", "reject"] });

    const decision = await this.deps.waitForDecision(requestID, signal);
    if (decision === "always" && scope) addApprovalRule(db, { ...scope, toolName, approvalID: requestID });
    return decision;
  }

  /**
   * True only for actions that can destroy state — the owner's rule is "ask me
   * about destructive things, and nothing else" (2026-10-19). Everything
   * reversible is free: research, memory, links, tasks, renames, handoffs, and
   * reads. Renaming in particular is a chat-driven identity change that used to
   * stop the turn for a click; it no longer does. A tool this switch and
   * `FREE_TOOLS` do not know gates.
   */
  requiresApproval(toolName: string, args: Record<string, unknown>): boolean {
    // A call the tool will refuse for its arguments is not worth a card; the
    // tool's own check turns it into an error the model can fix.
    if (this.deps?.validate?.(toolName, args)) return false;
    switch (toolName) {
      case "bash":
        return !isReadOnlyCommand(String(args.command ?? ""), typeof args.cwd === "string" ? args.cwd : undefined);
      case "write_file": {
        // Writes outside the owner-declared scratch tree gate. Inside scratch,
        // creating a new file is free; changing one that exists asks, whether
        // it is replaced (a denied delete must not be doable as an overwrite)
        // or appended to (an appended script is a changed script). A relative
        // path means a path under scratch, as it does for the tool itself.
        const path = typeof args.path === "string" ? args.path : "";
        if (isOutsideScratch(path, scratchDir())) return true;
        return writeTargetExists(path);
      }
      case "mail_send":
        // Agni's own mailbox ("agent", also the default when omitted) is
        // ungated (AGENTS.md amendment 2026-10-17); every other value gates.
        return !(args.account === undefined || args.account === null || args.account === "agent");
      case "calendar_create":
      case "calendar_update":
        // Same rule: Agni's own calendar is free, the owner's asks.
        return !(args.account === undefined || args.account === null || args.account === "agent");
      default:
        return !FREE_TOOLS.has(toolName) && !MCP_FREE_TOOLS.has(toolName);
    }
  }
}

/**
 * Everything on an approval card that the model chose (a path, a command, a
 * recipient, any argument) goes through this section before it is drawn, so
 * nothing the model writes can add a line to the card, reorder it, or read
 * differently from what it is. Control characters, bidirectional overrides and
 * isolates, and zero-width or invisible characters are shown as visible
 * escapes (a line break becomes backslash-n, U+202E becomes backslash-u202E); each entry is capped; free text that really is
 * several lines (a mail body, a shell script) is quoted line by line.
 */
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]|[\u{e0000}-\u{e007f}]/gu;
const NAMED_ESCAPES: Record<string, string> = { "\n": "\\n", "\r": "\\r", "\t": "\\t" };

/** Show every character that could change how the card reads as a visible escape. `keepLineBreaks` leaves "\n" alone (the card's own structure). */
function escapeUnsafe(text: string, keepLineBreaks = false): string {
  return text.replace(UNSAFE_CHARS, (ch) => {
    if (keepLineBreaks && ch === "\n") return ch;
    const named = NAMED_ESCAPES[ch];
    if (named) return named;
    const code = ch.codePointAt(0)!;
    return code > 0xffff ? `\\u{${code.toString(16).toUpperCase()}}` : `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
  });
}

/** One model-chosen entry on one line, cut at `max` characters with a marker that says how much is missing. */
function entry(value: unknown, max = 320): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return raw.length > max ? `${escapeUnsafe(raw.slice(0, max))}… (+${raw.length - max} chars)` : escapeUnsafe(raw);
}

/** Several lines of model-written text, each quoted, so a line that looks like a card field is plainly quoted text. */
function quoted(text: string, max: number): string {
  return escapeUnsafe(clip(text.replace(/\r\n/g, "\n"), max), true).split("\n").map((line) => `> ${line}`).join("\n");
}

/** An argument for display. A missing one reads as "(not given)", never "?" or "undefined". */
function shown(value: unknown, max = 400): string {
  if (value === undefined || value === null || value === "") return "(not given)";
  return escapeUnsafe(clip(typeof value === "string" ? value : JSON.stringify(value) ?? "(not given)", max));
}

/** The arguments with every string cut at `max` characters, for the JSON view. */
function boundedArgs(value: unknown, max: number): unknown {
  if (typeof value === "string") return value.length > max ? `${value.slice(0, max)}… (+${value.length - max} chars)` : value;
  if (Array.isArray(value)) return value.map((item) => boundedArgs(item, max));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, boundedArgs(item, max)]));
  return value;
}

function describeAction(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "bash": return `run shell: ${shown(String(args.command ?? ""), 400)}`;
    case "write_file": {
      const path = typeof args.path === "string" ? args.path : "";
      const replaces = path !== "" && args.append !== true && !isOutsideScratch(path, scratchDir()) && writeTargetExists(path);
      return `${replaces ? "overwrite existing file" : "write file"}: ${shown(path)}`;
    }
    case "read_file": return `read file: ${shown(args.path)}`;
    case "memory_write": return `save memory: ${entry(String(args.text ?? ""), 80)}`;
    case "link_save": return `save link: ${shown(args.url)}`;
    case "task_create": return `add task: ${shown(args.title)}`;
    case "task_update": return `update task ${shown(args.id)}`;
    case "mail_send": return `send email to ${Array.isArray(args.to) ? shown(args.to.map((to) => entry(to)).join(", ")) : shown(args.to)}: ${entry(String(args.subject ?? ""), 80)}`;
    case "rename_agent": return args.agentId ? `rename ${shown(args.agentId)} to ${shown(args.name)}` : `rename the assistant to ${shown(args.name)}`;
    default: return `${entry(toolName, 80)}(${escapeUnsafe(clip(JSON.stringify(args), 400))})`;
  }
}

function previewAction(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "bash") return quoted(String(args.command ?? ""), 4_000);
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

/** Cap long text without hiding its end: the dangerous part is often the tail. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)} … ${text.length - 2 * half} chars omitted … ${text.slice(-half)}`;
}
