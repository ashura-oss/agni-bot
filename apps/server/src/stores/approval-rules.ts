/**
 * Standing approval rules: what "Always allow" remembers.
 *
 * A rule is scoped to exactly one bot (`agent_id`), one tool (`tool_name`) and
 * one target (`target`), and lasts until the owner revokes it. It is matched by
 * plain equality on all three, never by prefix, pattern or "similar enough",
 * so it cannot widen to another bot, another tool, or a different command,
 * path or recipient.
 *
 * The target is the thing the owner was actually shown and agreed to, per tool:
 *
 *   bash            the exact command, with CRLF turned into LF and outer
 *                   whitespace trimmed (inner whitespace is significant). When
 *                   the call names a `cwd`, the target is `cd '<abs cwd>' &&
 *                   <command>`, which does exactly what the call does, so the
 *                   same command in another directory is a different target.
 *   write_file      the resolved absolute real path (relative paths resolve
 *                   against scratch, symlinks are followed; folded to lower
 *                   case on Windows). Never the content.
 *   mail_send       the account plus the recipient list: JSON
 *                   `{"account","to"}`, recipients sorted and de-duplicated,
 *                   the domain lower-cased and the local part left exact.
 *                   Never the subject or body.
 *   calendar_update the account plus the event id: JSON `{"account","eventId"}`.
 *   anything else   the canonical JSON of the arguments (keys sorted at every
 *                   level, array order kept). That covers calendar_create and
 *                   every plugin tool: only the very same call is remembered.
 *
 * Some tools are never remembered (`NEVER_REMEMBER`): their approval is the
 * point of the tool. `approvalTarget` returns null for those, and for a call
 * whose target cannot be worked out; null means "ask every time".
 */
import type { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { newID, nowISO } from "../util/ids";
import { resolveWritePath } from "../tools/write-file";

/** `run_privileged`: the owner reviews each privileged command and types the secret themselves. */
const NEVER_REMEMBER = new Set(["run_privileged"]);

export interface ApprovalRule {
  id: string;
  agentID: string;
  toolName: string;
  target: string;
  createdAt: string;
  /** Set when the owner revoked the rule; a revoked rule never matches. */
  revokedAt: string | null;
  /** The approval card the owner answered "always" on. */
  approvalID: string | null;
}

interface RuleRow {
  id: string;
  agent_id: string;
  tool_name: string;
  target: string;
  created_at: string;
  revoked_at: string | null;
  approval_id: string | null;
}

const toRule = (row: RuleRow): ApprovalRule => ({
  id: row.id,
  agentID: row.agent_id,
  toolName: row.tool_name,
  target: row.target,
  createdAt: row.created_at,
  revokedAt: row.revoked_at,
  approvalID: row.approval_id,
});

/** What a rule for this call is scoped to, or null when the call cannot be remembered. */
export function approvalTarget(toolName: string, args: Record<string, unknown>): string | null {
  if (NEVER_REMEMBER.has(toolName)) return null;
  switch (toolName) {
    case "bash": {
      const command = typeof args.command === "string" ? args.command.replace(/\r\n/g, "\n").trim() : "";
      if (!command) return null;
      if (typeof args.cwd === "string" && args.cwd.trim()) return `cd ${shellQuote(resolve(args.cwd))} && ${command}`;
      return command;
    }
    case "write_file": {
      if (typeof args.path !== "string" || !args.path.trim()) return null;
      const target = resolveWritePath(args.path);
      if (!target) return null;
      return process.platform === "win32" ? target.toLowerCase() : target;
    }
    case "mail_send": {
      const account = typeof args.account === "string" && args.account.trim() ? args.account.trim().toLowerCase() : "agent";
      const raw = Array.isArray(args.to) ? args.to : typeof args.to === "string" ? [args.to] : [];
      const to = [...new Set(raw.filter((entry): entry is string => typeof entry === "string").map(normaliseRecipient).filter(Boolean))].sort();
      if (to.length === 0) return null;
      return canonicalJSON({ account, to });
    }
    case "calendar_update": {
      if (typeof args.eventId === "string" && args.eventId.trim()) {
        const account = typeof args.account === "string" && args.account.trim() ? args.account.trim().toLowerCase() : "agent";
        return canonicalJSON({ account, eventId: args.eventId.trim() });
      }
      return canonicalJSON(args);
    }
    default:
      return canonicalJSON(args);
  }
}

/** The bot a turn belongs to (the turn's own bot, then its thread's), or null when unknown. */
export function agentForTurn(db: Database, threadID: string, turnID: string): string | null {
  const turn = db.query("SELECT agent_id FROM turns WHERE id = ?").get(turnID) as { agent_id: string } | null;
  if (turn?.agent_id) return turn.agent_id;
  const thread = db.query("SELECT agent_id FROM threads WHERE id = ?").get(threadID) as { agent_id: string } | null;
  return thread?.agent_id ?? null;
}

/** The active rule for exactly this bot, tool and target, if any. */
export function findApprovalRule(db: Database, agentID: string, toolName: string, target: string): ApprovalRule | null {
  const row = db
    .query("SELECT * FROM approval_rules WHERE agent_id = ? AND tool_name = ? AND target = ? AND revoked_at IS NULL")
    .get(agentID, toolName, target) as RuleRow | null;
  return row ? toRule(row) : null;
}

/** Remember a rule. Adding one that is already active returns the existing rule. */
export function addApprovalRule(
  db: Database,
  rule: { agentID: string; toolName: string; target: string; approvalID?: string | null },
): ApprovalRule {
  const existing = findApprovalRule(db, rule.agentID, rule.toolName, rule.target);
  if (existing) return existing;
  const id = newID("rul");
  db.run(
    "INSERT INTO approval_rules (id, agent_id, tool_name, target, created_at, revoked_at, approval_id) VALUES (?, ?, ?, ?, ?, NULL, ?)",
    [id, rule.agentID, rule.toolName, rule.target, nowISO(), rule.approvalID ?? null],
  );
  return toRule(db.query("SELECT * FROM approval_rules WHERE id = ?").get(id) as RuleRow);
}

/** Active rules, newest first; revoked ones too when asked. */
export function listApprovalRules(db: Database, options: { includeRevoked?: boolean } = {}): ApprovalRule[] {
  const rows = db
    .query(`SELECT * FROM approval_rules ${options.includeRevoked ? "" : "WHERE revoked_at IS NULL"} ORDER BY created_at DESC, id`)
    .all() as RuleRow[];
  return rows.map(toRule);
}

/** Revoke a rule. True when an active rule was revoked; false for an unknown or already revoked id. */
export function revokeApprovalRule(db: Database, id: string): boolean {
  const result = db.run("UPDATE approval_rules SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [nowISO(), id]);
  return result.changes > 0;
}

function normaliseRecipient(entry: string): string {
  const address = entry.trim();
  const at = address.lastIndexOf("@");
  return at < 0 ? address : `${address.slice(0, at)}@${address.slice(at + 1).toLowerCase()}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** JSON with object keys sorted at every level, so equal arguments give equal text. */
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? "null";
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]));
  }
  return value;
}
