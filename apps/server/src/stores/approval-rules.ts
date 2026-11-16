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
 *   write_file      the resolved absolute real path inside scratch (relative
 *                   paths resolve against scratch, symlinks are followed;
 *                   folded to lower case on Windows). Never the content. A
 *                   path outside scratch has no target: it asks every time.
 *   mail_send       the account plus the recipient list: JSON
 *                   `{"account","to"}`, recipients sorted and de-duplicated,
 *                   the domain lower-cased and the local part left exact.
 *                   Never the subject or body.
 *   anything else   the canonical JSON of the arguments (keys sorted at every
 *                   level, array order kept). That covers the calendar tools
 *                   and every plugin tool: only the very same call is
 *                   remembered, so an event id alone never allows a new edit.
 *
 * Shell tools are never remembered: `bash` and `run_privileged` always ask.
 * `findApprovalRule` and `addApprovalRule` refuse them too, whoever the caller.
 * Whether a command is safe depends on the files it runs, the programs PATH
 * finds and the directory it runs in, all of which can change after the owner
 * looked, and no check made here can see them as the shell will. So an
 * "always" answer on a shell command stores nothing, and its card does not
 * offer "always". Rules for the other tools are unaffected. `approvalTarget`
 * also returns null for a call whose target cannot be worked out; null means
 * "ask every time".
 *
 * A rule may instead carry a resource pattern (S2-08): still one bot and one
 * tool, but matching every call whose resources (paths, recipients, hosts) all
 * fit one pattern, such as `*@example.com`. A pattern is anchored (the whole
 * value must fit), a star never crosses a slash or an address boundary, and a
 * pattern that would match nearly everything is refused when it is stored.
 * A pattern rule never matches a shell tool or a write outside scratch.
 * `matchApprovalRule` is the one call the policy engine makes.
 */
import type { Database } from "bun:sqlite";
import { log } from "../log";
import { audit } from "../policy/audit-sink";
import { newID, nowISO } from "../util/ids";
import { isOutsideScratch, resolveWritePath, scratchDir } from "../tools/write-file";
import type { ToolResource } from "../policy/tool-meta";
import { normalizeRecipients } from "../mail/smtp";

/** Shell tools: `bash` (see the header) and `run_privileged` (the owner reviews each command and types the secret). */
const NEVER_REMEMBER = new Set(["bash", "run_privileged"]);

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
  /** Set on a rule that matches by resource pattern instead of one exact target. */
  resourcePattern: string | null;
  /** The mailbox a mail pattern rule was made for ("agent" or "owner"); null on every other rule. */
  account: MailAccount | null;
}

interface RuleRow {
  id: string;
  agent_id: string;
  tool_name: string;
  target: string;
  created_at: string;
  revoked_at: string | null;
  approval_id: string | null;
  resource_pattern: string | null;
}

const toRule = (row: RuleRow): ApprovalRule => ({
  id: row.id,
  agentID: row.agent_id,
  toolName: row.tool_name,
  target: row.target,
  createdAt: row.created_at,
  revokedAt: row.revoked_at,
  approvalID: row.approval_id,
  resourcePattern: row.resource_pattern ?? null,
  account: row.resource_pattern !== null && row.tool_name === "mail_send" ? accountOfPatternTarget(row.target) : null,
});

/** The mailboxes a mail send can come from. */
export type MailAccount = "agent" | "owner";

/** The mailbox a mail call sends from, read the way the mail tool reads it; null for a value the tool would refuse. */
function mailAccountOf(value: unknown): MailAccount | null {
  if (value === undefined || value === null) return "agent";
  const text = typeof value === "string" ? value.trim() : "";
  return text === "agent" || text === "owner" ? text : null;
}

/**
 * A mail call as the sender will see it: its mailbox and its recipients, parsed with the sender's own parser
 * (`mail/smtp.ts`). Null when either does not parse cleanly (an entry with a comma, a semicolon, a display name or
 * a line break, a value that is not a string, no recipients, an unknown mailbox): such a call is never matched by a
 * rule, so it shows its card.
 */
export function parseMailCall(args: Record<string, unknown>): { account: MailAccount; to: string[] } | null {
  const account = mailAccountOf(args.account);
  if (account === null) return null;
  let to: string[];
  try {
    to = normalizeRecipients(args.to).map(normaliseRecipient);
  } catch {
    return null;
  }
  return { account, to: [...new Set(to)].sort() };
}

const PATTERN_TARGET = "pattern:";
const MAIL_ACCOUNT_MARK = "account=";

/** The key a pattern rule is stored under: one live rule per bot, tool and pattern (and, for mail, mailbox). */
function patternTarget(toolName: string, pattern: string, account: MailAccount | null): string {
  return toolName === "mail_send" && account !== null ? `${PATTERN_TARGET}${MAIL_ACCOUNT_MARK}${account}:${pattern}` : `${PATTERN_TARGET}${pattern}`;
}

function accountOfPatternTarget(target: string): MailAccount | null {
  const body = target.startsWith(PATTERN_TARGET) ? target.slice(PATTERN_TARGET.length) : "";
  if (!body.startsWith(MAIL_ACCOUNT_MARK)) return null;
  const account = body.slice(MAIL_ACCOUNT_MARK.length).split(":", 1)[0];
  return account === "agent" || account === "owner" ? account : null;
}

/** What a rule for this call is scoped to, or null when the call cannot be remembered. */
export function approvalTarget(toolName: string, args: Record<string, unknown>): string | null {
  if (NEVER_REMEMBER.has(toolName)) return null;
  switch (toolName) {
    case "write_file": {
      if (typeof args.path !== "string" || !args.path.trim()) return null;
      // A path-only rule outside scratch would let the bot later rewrite startup
      // items, hooks, scripts or config files with no card. Only scratch overwrites
      // are remembered.
      if (isOutsideScratch(args.path, scratchDir())) return null;
      const target = resolveWritePath(args.path);
      if (!target) return null;
      return process.platform === "win32" ? target.toLowerCase() : target;
    }
    case "mail_send": {
      // What the sender will do with the call, or nothing to remember: a list it would refuse is never a rule's target.
      const mail = parseMailCall(args);
      return mail ? canonicalJSON({ account: mail.account, to: mail.to }) : null;
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
  if (NEVER_REMEMBER.has(toolName)) return null;
  const row = db
    .query("SELECT * FROM approval_rules WHERE agent_id = ? AND tool_name = ? AND target = ? AND revoked_at IS NULL")
    .get(agentID, toolName, target) as RuleRow | null;
  const rule = row ? toRule(row) : null;
  if (!rule) return null;
  if (canStillMatch(rule)) return rule;
  // A rule that can no longer match (a scratch folder moved away from it) is revoked, as the
  // list does, so moving the folder back cannot bring it to life again.
  db.run("UPDATE approval_rules SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [nowISO(), rule.id]);
  return null;
}

/**
 * Remember a rule. Adding one that is already active returns the existing rule.
 * Null, and nothing stored, for a tool that is never remembered.
 */
export function addApprovalRule(
  db: Database,
  rule: { agentID: string; toolName: string; target: string; approvalID?: string | null; resourcePattern?: string | null; account?: string | null },
): ApprovalRule | null {
  if (NEVER_REMEMBER.has(rule.toolName)) return null;
  const pattern = rule.resourcePattern ?? null;
  if (pattern !== null) {
    const problem = validateResourcePattern(pattern);
    if (problem) throw new Error(`resource pattern refused: ${problem}`);
  }
  // A mail pattern rule is for one mailbox: a rule made for the agent's mailbox must not let the owner's mailbox send.
  const account = rule.account === undefined || rule.account === null ? null : mailAccountOf(rule.account);
  if (pattern !== null && rule.toolName === "mail_send" && account === null) throw new Error("a mail rule needs the account it is for: agent or owner");
  // A pattern rule's target is its pattern (and mailbox), so the one-live-rule-per-target index also keeps patterns unique.
  const target = pattern !== null ? patternTarget(rule.toolName, pattern, account) : rule.target;
  const existing = findApprovalRule(db, rule.agentID, rule.toolName, target);
  if (existing) return existing;
  const id = newID("rul");
  // A rule is a standing permission: it goes on the record first, and a failing log stops it being made.
  audit({ kind: "approval.rule.added", actor: "owner", detail: { ruleID: id, agentID: rule.agentID, toolName: rule.toolName, target, resourcePattern: pattern, approvalID: rule.approvalID ?? null } });
  db.run(
    "INSERT INTO approval_rules (id, agent_id, tool_name, target, created_at, revoked_at, approval_id, resource_pattern) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)",
    [id, rule.agentID, rule.toolName, target, nowISO(), rule.approvalID ?? null, pattern],
  );
  return toRule(db.query("SELECT * FROM approval_rules WHERE id = ?").get(id) as RuleRow);
}

/** Why a pattern is not allowed as a rule, or null when it is. */
export function validateResourcePattern(pattern: string): string | null {
  if (pattern.trim().length === 0) return "it is empty";
  if (pattern.length > 300) return "it is longer than 300 characters";
  if (/[\s,;\u0000-\u001f\u007f]/.test(pattern)) return "it has a space, comma, semicolon or control character";
  if (pattern.includes("**")) return "`**` is not allowed; a star stands for part of one segment";
  const literal = pattern.replace(/\*/g, "");
  if (literal.length < 4) return "it has too few fixed characters and would match almost anything";
  if (pattern.startsWith("*") && pattern.slice(pattern.lastIndexOf("*") + 1).length < 6) return "a pattern that starts with a star needs at least 6 fixed characters after it, such as *@example.com";
  return null;
}

/** A value in the form both sides of a pattern match are compared in. */
function normaliseForMatch(kind: ToolResource["kind"], value: string): string {
  switch (kind) {
    case "recipient": {
      const at = value.lastIndexOf("@");
      return at < 0 ? value : `${value.slice(0, at)}@${value.slice(at + 1).toLowerCase()}`;
    }
    case "host":
      return value.toLowerCase();
    case "path": {
      const slashed = value.replace(/\\/g, "/");
      return process.platform === "win32" ? slashed.toLowerCase() : slashed;
    }
    default:
      return value;
  }
}

/** Whether one resource fits a pattern. The whole value must fit; a star never crosses a slash. */
export function matchResourcePattern(pattern: string, resource: ToolResource): boolean {
  const value = normaliseForMatch(resource.kind, resource.value);
  if (resource.kind === "path" && value.split("/").includes("..")) return false;
  const star = resource.kind === "recipient" ? "[^/\\s,;@]*" : "[^/\\s,;]*";
  const source = normaliseForMatch(resource.kind, pattern)
    .split("*")
    .map((chunk) => chunk.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(star);
  return new RegExp(`^${source}$`).test(value);
}

/**
 * The standing rule that allows this call, if any: the exact-target rule first
 * (what "Always allow" stores), then a pattern rule of the same bot and tool
 * whose pattern every resource of the call fits. Never for a shell tool, and
 * never for a write outside scratch. `resources` come from the tool's
 * metadata (`policy/tool-meta.ts`); a call with none matches no pattern.
 */
export function matchApprovalRule(
  db: Database,
  call: { agentID: string; toolName: string; args: Record<string, unknown>; resources: readonly ToolResource[] },
): ApprovalRule | null {
  if (NEVER_REMEMBER.has(call.toolName)) return null;
  const target = approvalTarget(call.toolName, call.args);
  if (target !== null) {
    const exact = findApprovalRule(db, call.agentID, call.toolName, target);
    if (exact) return exact;
  }
  // A mail call is matched on what the sender will use, not on the engine's reading of the arguments.
  const mail = call.toolName === "mail_send" ? parseMailCall(call.args) : null;
  if (call.toolName === "mail_send" && mail === null) return null;
  const resources: readonly ToolResource[] = mail ? mail.to.map((value) => ({ kind: "recipient" as const, value })) : call.resources;
  if (resources.length === 0) return null;
  if (call.toolName === "write_file" && resources.some((resource) => resource.kind !== "path" || isOutsideScratch(resource.value, scratchDir()))) return null;
  const rows = db
    .query("SELECT * FROM approval_rules WHERE agent_id = ? AND tool_name = ? AND revoked_at IS NULL AND resource_pattern IS NOT NULL ORDER BY created_at, id")
    .all(call.agentID, call.toolName) as RuleRow[];
  for (const row of rows) {
    const pattern = row.resource_pattern;
    const rule = toRule(row);
    // A mail rule is for the mailbox it was made for; one written without a mailbox matches no mail.
    if (mail && rule.account !== mail.account) continue;
    if (pattern && resources.every((resource) => matchResourcePattern(pattern, resource))) return rule;
  }
  return null;
}

/**
 * Whether a stored rule could ever match a call. A rule written before shell
 * commands and writes outside scratch stopped being remembered is still in the
 * table but `approvalTarget` can no longer produce its target, so it is dead
 * weight that would read as active in Settings.
 */
function canStillMatch(rule: ApprovalRule): boolean {
  if (NEVER_REMEMBER.has(rule.toolName)) return false;
  if (rule.toolName === "write_file") return !isOutsideScratch(rule.target, scratchDir());
  return true;
}

/**
 * Active rules that can still match, newest first. A rule that can no longer
 * match is revoked as it is found. With `includeRevoked`, the whole history.
 */
export function listApprovalRules(db: Database, options: { includeRevoked?: boolean } = {}): ApprovalRule[] {
  const rows = db
    .query(`SELECT * FROM approval_rules ${options.includeRevoked ? "" : "WHERE revoked_at IS NULL"} ORDER BY created_at DESC, id`)
    .all() as RuleRow[];
  const rules = rows.map(toRule);
  if (options.includeRevoked) return rules;
  const live = rules.filter(canStillMatch);
  // A rule the list hides is not left active: a scratch folder that moves, or a
  // path that changes case, could make it matchable again. It stays in the history.
  const dead = rules.filter((rule) => !live.includes(rule) && rule.revokedAt === null);
  if (dead.length > 0) {
    const when = nowISO();
    for (const rule of dead) db.run("UPDATE approval_rules SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [when, rule.id]);
  }
  return live;
}

/** Revoke a rule. True when an active rule was revoked; false for an unknown or already revoked id. */
export function revokeApprovalRule(db: Database, id: string): boolean {
  const result = db.run("UPDATE approval_rules SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [nowISO(), id]);
  if (result.changes > 0) {
    // Taking a permission away is never held up by the log.
    try {
      audit({ kind: "approval.rule.revoked", actor: "owner", detail: { ruleID: id } });
    } catch (error) {
      log.warn("audit: could not record a revoked rule", error);
    }
  }
  return result.changes > 0;
}

function normaliseRecipient(entry: string): string {
  const address = entry.trim();
  const at = address.lastIndexOf("@");
  return at < 0 ? address : `${address.slice(0, at)}@${address.slice(at + 1).toLowerCase()}`;
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
