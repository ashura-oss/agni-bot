/**
 * The policy engine: one question for every tool call, one place that answers
 * it (S2-02). `decide(run, call)` replaces the old free list and the
 * approval broker's `requiresApproval`.
 *
 * The checks, in order. The first that answers ends the question:
 *
 *   0. pause      the owner pulled the switch: stop the run
 *   1. capability is the tool this bot's, registered, and loaded?
 *   2. schema     are the arguments well formed? (an unloaded tool's schema
 *                 was never sent, so it is refused before its arguments are read)
 *   3. resources  a routine's domain list; something the owner already said
 *                 no to in this run
 *   4. budget     is there money left? (stop the run)
 *   5. tier       what does this call do, and what has the run read: a call
 *                 that needs the owner is asked; a run that has read outside
 *                 text may not change bots or schedules, and may only send to
 *                 places the owner named
 *   6. rules      a stored "always allow" for exactly this bot, tool and target
 *   7. owner      ask with a card
 *
 * It runs on every call, so it reads nothing slow: no model call, no network,
 * a handful of small database reads at most. Under a millisecond.
 */
import { entry } from "../agent/card-text";
import { approvalTarget, matchApprovalRule } from "../stores/approval-rules";
import { audit } from "./audit-sink";
import { isTainted, newestFirst } from "./context";
import { REFUSALS_BEFORE_STOP, findCoveringDenial, findDenial, noteBlockedAttempt, runHasDenial, type DenialRecord } from "./denials";
import { unnamedDestinations } from "./egress";
import { policyHooks } from "./hooks";
import { shellCandidates, shellWorkingDir } from "./resources";
import { scanShell } from "./shell-scan";
import type { Database } from "bun:sqlite";
import { assessCall, policyFor } from "./metadata";
import type {
  ApprovalCard, CallAssessment, Decision, Operation, PolicyInput, RefusalCode, RunContext, ToolTier,
} from "./types";
import type { ToolResource } from "./tool-meta";
import { domainAllowed } from "../routines/egress";

export interface DecideOptions {
  /**
   * False asks the question without leaving a trace: no audit row, no count
   * of a blocked attempt. For "would this need the owner?" probes (the
   * parallel-read starter). Default true.
   */
  record?: boolean;
}

export function decide(run: RunContext, input: PolicyInput, options: DecideOptions = {}): Decision {
  const record = options.record !== false;
  const decision = judge(run, input, record);
  return record ? recorded(run, input, decision) : decision;
}

// ---------------------------------------------------------------------------

const refuse = (code: RefusalCode, error: string, reason: string): Extract<Decision, { action: "refuse" }> => ({ action: "refuse", code, error, reason });

function judge(run: RunContext, input: PolicyInput, record: boolean): Decision {
  const { tool, args } = input;
  const services = run.services;

  // 0. pause
  const paused = policyHooks.isRunPaused(run);
  if (paused) return { action: "stop", cause: "pause", message: paused.message, reason: `paused (${paused.scope})` };

  // 1. capability
  if (!services.hasTool(tool) || !run.effectiveCapabilities.has(tool)) {
    return refuse("not_available", `Tool is not available to this persona: ${tool}`, "not on this bot's list");
  }
  if (services.isUnloaded(tool)) {
    return refuse("not_loaded", `${tool} is not loaded yet. Call load_tools with {"names":["${tool}"]} first, then call it again.`, "deferred tool not loaded");
  }

  // 2. schema
  const invalid = services.validateArgs(tool, args);
  if (invalid) return refuse("invalid_arguments", invalid, "arguments break the tool's schema");

  // 3. resources
  const domain = routineDomainCheck(run, tool, args);
  if (domain) return domain;
  const policy = policyFor(tool, services.metaOf?.(tool));
  const assessment = assessCall(policy, args);
  const denied = deniedEarlier(run, tool, args, assessment, record);
  if (denied) return denied;

  // 4. budget
  const budget = policyHooks.checkBudget(run);
  if (!budget.ok) return { action: "stop", cause: "budget", message: budget.message, reason: `budget: ${budget.scope} cap`, ...(budget.detail ? { budget: budget.detail } : {}) };

  // 5. tier and taint
  const tainted = isTainted(run);
  if (tainted && policy?.protectedWrite) {
    return refuse(
      "protected_write",
      protectedWriteError(run),
      "protected write in a tainted run",
    );
  }
  let asks = assessment.asks;
  let tier = assessment.tier;
  let unnamed: string[] = [];
  let why = asks ? `tier ${tier} call` : "free call";
  if (tainted && assessment.egress !== "none") {
    unnamed = unnamedDestinations(run, assessment.destinations).map((destination) => destination.value);
    if (assessment.egress === "send" || unnamed.length > 0) {
      asks = true;
      tier = Math.max(tier, 2) as ToolTier;
      why = unnamed.length > 0 ? "outside content read, destination not named by the owner" : "outside content read, sends data out";
    }
  }
  if (!asks) return { action: "run", via: "free", reason: why, assessment };

  // 6. stored rules. A run that has read outside content never rides on an old "always", for any call: what the owner
  // approved was one thing, once, not whatever this run now wants done after reading a page.
  const target = approvalTarget(tool, args);
  const canRemember = !tainted && target !== null;
  if (!tainted) {
    // An exact rule (what "Always allow" stores) or a pattern rule over the call's resources (S2-08).
    const rule = matchApprovalRule(run.services.db, { agentID: run.bot, toolName: tool, args, resources: assessment.resources });
    if (rule) return { action: "run", via: "rule", reason: `stored rule ${rule.id}`, assessment: { ...assessment, tier }, ruleID: rule.id, rule: { id: rule.id, agentID: rule.agentID, toolName: rule.toolName, createdAt: rule.createdAt } };
  }

  // 7. owner
  const card: ApprovalCard = {
    tier,
    risk: tainted && assessment.egress !== "none" && assessment.risk !== "command" ? "egress" : assessment.risk,
    verb: verbFor(tool, args, assessment, unnamed.length > 0),
    sources: newestFirst(run),
    canRemember,
    unnamedDestinations: unnamed,
    resources: assessment.resources,
    operation: assessment.operation,
  };
  return { action: "ask", reason: why, assessment: { ...assessment, tier }, card };
}

/** A routine runs with a list of domains; web tools stay inside it. */
function routineDomainCheck(run: RunContext, tool: string, args: Record<string, unknown>): Decision | null {
  const allowed = run.services.allowedDomains;
  if (!allowed) return null;
  const blocked = (): Decision => refuse("domain_not_allowed", "domain is not allowed", "outside the routine's domain list");
  if (tool === "web_fetch") {
    // The routine's own rule (routines/egress.ts), so the two cannot drift apart.
    if (typeof args.url !== "string" || !domainAllowed(args.url, allowed)) return blocked();
  } else if (tool === "web_search" && allowed.length === 0) {
    return blocked();
  }
  return null;
}

/** The shell tools: a command line the server reads for the files it touches. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(["bash", "run_privileged"]);

/** The owner said no to this earlier in the run, to the thing itself and not just the tool. */
function deniedEarlier(run: RunContext, tool: string, args: Record<string, unknown>, assessment: CallAssessment, record: boolean): Decision | null {
  const db = run.services.db;
  const shell = SHELL_TOOLS.has(tool);
  const command = shell ? String(args.command ?? "") : undefined;
  // Every word of a command is a candidate file, not just the words the metadata kept for the card.
  const scan = shell ? shellProbe(db, run, command ?? "", tool === "bash" ? args.cwd : undefined) : null;
  const hit = findDenial(db, run, assessment.operation, [...assessment.resources, ...(scan?.candidates ?? [])], command);
  if (hit) {
    const attempts = record ? noteBlockedAttempt(db, hit.id) : hit.blockedCount;
    if (record && attempts >= REFUSALS_BEFORE_STOP) {
      return {
        action: "stop", cause: "refused",
        message: `I stopped: I kept trying to reach ${entry(hit.key, 120)} after you said no.`,
        reason: `refused ${attempts} times: ${hit.operation} on ${hit.kind}`,
      };
    }
    return refusedAfterNo(run, tool, args, assessment, hit, "");
  }
  // A command that holds a variable, a pattern, a substitution, `eval`, `cd` and the like may reach the refused thing without
  // naming it. While the run holds a refusal that covers it, such a command is not run and is not offered to the owner.
  if (scan && scan.unresolved.length > 0) {
    const any = findCoveringDenial(db, run, assessment.operation);
    if (any) return refusedAfterNo(run, tool, args, assessment, any, ` This command uses ${scan.unresolved.slice(0, 3).join(", ")}, which I cannot follow to file names, so it might reach it. Name the files plainly, with no variables, patterns, substitution or folder changes.`);
  }
  return null;
}

function refusedAfterNo(run: RunContext, tool: string, args: Record<string, unknown>, assessment: CallAssessment, hit: DenialRecord, because: string): Decision {
  const bot = run.services.botName?.trim() || "A bot";
  return {
    ...refuse(
      "denied_resource",
      `Refused: the owner said no to ${OPERATION_PHRASE[hit.operation]} ${entry(hit.key, 200)} earlier in this task. This covers every tool and every route to it, for the rest of this task.${because} Do not try again. Tell the owner what you were trying to do and ask how to continue.`,
      because ? `owner said no to ${hit.operation} on ${hit.kind}; command cannot be resolved` : `owner said no to ${hit.operation} on ${hit.kind}`,
    ),
    preview: `Blocked: ${entry(bot, 60)} tried to ${verbFor(tool, args, assessment, false)} after you said no to ${DENIED_GERUND[hit.operation]} it.`,
  };
}

/** The candidates and the unresolved parts of a shell command, or null when the run holds no refusal (nothing to compare with). */
function shellProbe(db: Database, run: RunContext, command: string, cwd: unknown): { candidates: ToolResource[]; unresolved: string[] } | null {
  if (!runHasDenial(db, run)) return null;
  return {
    candidates: shellCandidates(command, shellWorkingDir(typeof cwd === "string" && cwd ? cwd : undefined)),
    unresolved: scanShell(command).unresolved,
  };
}

const DENIED_GERUND: Record<Operation, string> = {
  delete: "deleting", change: "changing", send: "sending", read: "reading", run: "running",
};

const OPERATION_PHRASE: Record<Operation, string> = {
  delete: "deleting", change: "changing", send: "sending to", read: "reading", run: "running a command on",
};

/** Why a tainted run may not change bots, schedules or rules, in words that fit the run. */
function protectedWriteError(run: RunContext): string {
  const why = run.unattended
    ? "this is an unattended routine run"
    : `this run read outside content (${taintSummary(run)})`;
  return `Not done: ${why}, so it may not change bots, schedules, routines or rules. Tell the owner what you wanted to change and ask them to do it.`;
}

function taintSummary(run: RunContext): string {
  const newest = newestFirst(run)[0];
  return newest ? entry(newest.label, 80) : "outside content";
}

/** The heading's verb phrase: from what the call does, not from the raw tool name. */
export function verbFor(tool: string, args: Record<string, unknown>, assessment: CallAssessment, unnamed: boolean): string {
  if (unnamed) {
    if (tool === "mail_send") return "send to an address you have not named";
    if (tool.startsWith("calendar_")) return "invite someone you have not named";
    if (tool === "web_fetch" || tool === "link_save") return "open a site you have not named";
    return "send to a place you have not named";
  }
  switch (tool) {
    case "mail_send": return "send an email";
    case "calendar_create": return "add a calendar event";
    case "calendar_update": return "change a calendar event";
    case "bash": return assessment.operation === "delete" ? "delete files with a command" : "run a command on this computer";
    case "run_privileged": return "run a command as administrator";
    case "write_file": {
      const outside = assessment.tier >= 2;
      if (args.append === true) return outside ? "add to a file outside your scratch folder" : "add to a file";
      return outside ? "write a file outside your scratch folder" : assessment.tier === 1 ? "overwrite a file" : "write a file";
    }
    case "web_fetch": return "open a web page";
    case "share_thread": return "share this conversation";
    default:
      return tool.startsWith("mcp_") ? `use ${entry(tool.replace(/^mcp_/, ""), 60)}` : `use ${entry(tool, 60)}`;
  }
}

// ---------------------------------------------------------------------------
// The audit trail
// ---------------------------------------------------------------------------

/**
 * Write the decision down. A call that would run (or be asked) is not allowed
 * to go ahead unrecorded: if the trail cannot take the row, the call is refused.
 * A call already refused or stopped stays so for its own reason.
 */
function recorded(run: RunContext, input: PolicyInput, decision: Decision): Decision {
  try {
    audit({
      kind: "policy.decision",
      actor: run.bot,
      turnID: run.turnID,
      ...(run.jobID ? { jobID: run.jobID } : {}),
      detail: auditDetail(run, input, decision),
    });
    return decision;
  } catch {
    if (decision.action === "refuse" || decision.action === "stop") return decision;
    return refuse("audit_unavailable", "Not run: the audit log could not record this action, so it was not allowed.", "audit trail unavailable");
  }
}

function auditDetail(run: RunContext, input: PolicyInput, decision: Decision): Record<string, unknown> {
  const base: Record<string, unknown> = {
    tool: input.tool,
    callID: input.callID,
    action: decision.action,
    reason: decision.reason,
    principal: run.principal.kind,
    tainted: isTainted(run),
  };
  if (isTainted(run)) base.taint = run.taint.sources.map((source) => ({ kind: source.kind, label: source.label }));
  switch (decision.action) {
    case "run":
      base.via = decision.via;
      base.tier = decision.assessment.tier;
      if (decision.ruleID) base.ruleID = decision.ruleID;
      break;
    case "ask":
      base.tier = decision.card.tier;
      base.risk = decision.card.risk;
      base.canRemember = decision.card.canRemember;
      base.resources = decision.card.resources.slice(0, 10);
      if (decision.card.unnamedDestinations.length) base.unnamedDestinations = decision.card.unnamedDestinations.slice(0, 10);
      break;
    case "refuse":
      base.code = decision.code;
      break;
    case "stop":
      base.cause = decision.cause;
      break;
  }
  return base;
}
