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
 *                 places the owner named. A repeating job is a standing rule:
 *                 only the owner's own untainted turn makes one unasked; any
 *                 other run asks the owner (never "always", no stored rule)
 *   6. rules      a stored "always allow" for exactly this bot, tool and target
 *   7. owner      ask with a card
 *
 * It runs on every call, so it reads nothing slow: no model call, no network,
 * a handful of small database reads at most. Under a millisecond.
 */
import { entry } from "../agent/card-text";
import { cardProblem } from "../agent/card-preview";
import { approvalTarget, matchApprovalRule } from "../stores/approval-rules";
import { audit } from "./audit-sink";
import { isTainted, newestFirst } from "./context";
import { REFUSALS_BEFORE_STOP, anyDenial, findDenial, isShellDenial, noteBlockedAttempt, refusedThing, shellDenial, type DenialRecord } from "./denials";
import { unnamedDestinations } from "./egress";
import { policyHooks } from "./hooks";
import { assessCall, policyFor } from "./metadata";
import { isRecurringSchedule, standingRuleOrigin } from "./standing-rules";
import type {
  ApprovalCard, CallAssessment, Decision, Operation, PolicyInput, RefusalCode, RunContext, StandingKind, ToolTier,
} from "./types";
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
  const invalid = services.validateArgs(tool, args, run.bot);
  if (invalid) return refuse("invalid_arguments", invalid, "arguments break the tool's schema");

  // 3. resources
  const domain = routineDomainCheck(run, tool, args);
  if (domain) return domain;
  const policy = policyFor(tool, services.metaOf?.(tool));
  const assessment = assessCall(policy, args);
  const denied = deniedEarlier(run, tool, args, assessment, record);
  if (denied) return denied;
  // A shell command the server cannot prove to be one plain allowlisted command (policy/shell-proof.ts) names no file, so no
  // refusal can be compared with it. While this run holds ANY refusal it may touch it: it is never run on its own, and
  // the owner is asked with the refusal named. And once the owner has refused such a command, the run holds a run-wide
  // refusal of the shell: every later shell call and every file write asks too, whatever it names. (Sprint 7: an
  // unattended, sandboxed shell is off in any run that holds a refusal; the sandbox profile, not this check, is the
  // boundary there.)
  const refusedRun = refusalOnCard(run, tool, assessment);
  // A repeating job is a standing rule (policy/standing-rules.ts): what kind of one the engine decided this call is, and why the owner must be
  // asked (null when this is the owner's own clean turn). The card is drawn from this very answer, not from a second look at the arguments.
  const standingKind = policy?.standingKind?.(args, run) ?? null;
  const standing = standingKind !== null ? standingLine(standingKind, standingRuleOrigin(run)) : null;

  // 4. budget
  const budget = policyHooks.checkBudget(run);
  if (!budget.ok) return { action: "stop", cause: "budget", message: budget.message, reason: `budget: ${budget.scope} cap`, ...(budget.detail ? { budget: budget.detail } : {}) };

  // 5. tier and taint
  const tainted = isTainted(run);
  // (A repeating job from a tainted run is put to the owner below instead: a card, not a refusal.)
  if (tainted && policy?.protectedWrite && standing === null) {
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
  if (refusedRun) {
    asks = true;
    tier = Math.max(tier, tool === "write_file" ? 1 : tool.startsWith("mcp_") ? 2 : 3) as ToolTier;
    why = "a run that holds a refusal: a shell command the server cannot read file names from, a connector tool, or a call the refused shell command could have reached";
  }
  if (standing !== null) {
    asks = true;
    tier = Math.max(tier, 2) as ToolTier;
    why = "work that starts again on its own, from a run that is not the owner's own untainted turn";
  }
  if (!asks) return { action: "run", via: "free", reason: why, assessment };

  // 6. stored rules. A run that has read outside content never rides on an old "always", for any call: what the owner
  // approved was one thing, once, not whatever this run now wants done after reading a page. A repeating job is never
  // remembered or answered by a rule: each one is the owner's decision.
  const target = approvalTarget(tool, args);
  const canRemember = !tainted && target !== null && !refusedRun && standing === null;
  if (!tainted && !refusedRun && standing === null) {
    // An exact rule (what "Always allow" stores) or a pattern rule over the call's resources (S2-08).
    const rule = matchApprovalRule(run.services.db, { agentID: run.bot, toolName: tool, args, resources: assessment.resources });
    if (rule) return { action: "run", via: "rule", reason: `stored rule ${rule.id}`, assessment: { ...assessment, tier }, ruleID: rule.id, rule: { id: rule.id, agentID: rule.agentID, toolName: rule.toolName, createdAt: rule.createdAt } };
  }

  // 7. owner
  const card: ApprovalCard = {
    tier,
    risk: standing !== null ? "standing" : tainted && assessment.egress !== "none" && assessment.risk !== "command" ? "egress" : assessment.risk,
    verb: verbFor(tool, args, assessment, unnamed.length > 0),
    sources: newestFirst(run),
    canRemember,
    unnamedDestinations: unnamed,
    resources: assessment.resources,
    operation: assessment.operation,
    ...(refusedRun ? { refusedRun } : {}),
    ...(standing !== null && standingKind !== null ? { standingRule: standing, standingKind } : {}),
    ...(standing !== null && tainted ? { standingTainted: true } : {}),
    ...(standing !== null && run.narrowed ? { standingNarrowed: true } : {}),
  };
  // A card that cannot show the owner everything that will run is not raised (fail closed): the call is refused, and the model told why.
  const unshowable = cardProblem(tool, args, { bot: run.services.botName?.trim() || "A bot", card, db: run.services.db, agentID: run.bot });
  if (unshowable !== null) return refuse("cannot_show", `Not done: ${unshowable}`, "the owner could not be shown the whole call");
  return { action: "ask", reason: why, assessment: { ...assessment, tier }, card };
}

/** The card's sentence for a standing rule: why the owner is asked, and for a one-shot job, why that is a standing rule at all. */
function standingLine(kind: StandingKind, origin: string | null): string | null {
  if (origin === null || kind !== "next_job") return origin;
  return `${origin} A job that schedules the next job keeps the work going by itself.`;
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

/** The owner said no to this earlier in the run, to the thing itself and not just the tool. */
function deniedEarlier(run: RunContext, tool: string, args: Record<string, unknown>, assessment: CallAssessment, record: boolean): Decision | null {
  const db = run.services.db;
  // For a shell command the resources are the literal paths of a proven command (policy/metadata.ts); an unproven one has none here.
  const hit = findDenial(db, run, assessment.operation, assessment.resources);
  if (!hit) return null;
  const attempts = record ? noteBlockedAttempt(db, hit.id) : hit.blockedCount;
  if (record && attempts >= REFUSALS_BEFORE_STOP) {
    return {
      action: "stop", cause: "refused",
      message: `I stopped: I kept trying to reach ${refusedThing(hit, (text) => entry(text, 120))} after you said no.`,
      reason: `refused ${attempts} times: ${hit.operation} on ${hit.kind}`,
    };
  }
  return refusedAfterNo(run, tool, args, assessment, hit);
}

/**
 * The card's lead line when this run holds a refusal that reaches this call, or null. Reached: a shell command the server cannot
 * read file names from, in a run that holds any refusal; any shell call, file write or connector (MCP) tool once the owner refused
 * a shell command; and a connector tool in a run that holds any refusal (its arguments name no file the server can compare, so
 * the trust the owner gave it, and any stored rule, do not apply while the run holds a "no").
 */
function refusalOnCard(run: RunContext, tool: string, assessment: CallAssessment): string | null {
  if (assessment.unprovenShell) return refusalNamedOnCard(run, "command");
  const connector = tool.startsWith("mcp_");
  const reached = tool === "write_file" || assessment.risk === "command" || connector;
  if (reached && shellDenial(run.services.db, run)) return SHELL_REFUSED_LINE;
  return connector ? refusalNamedOnCard(run, "tool") : null;
}

const SHELL_REFUSED_LINE = "You said no to running a command earlier in this task. I cannot tell which files it would have touched, so every command, every file change and every connector call now asks you first.";

/** The card's line for a call the server cannot read file names from, when the run holds a refusal; null when it holds none. */
function refusalNamedOnCard(run: RunContext, what: "command" | "tool"): string | null {
  const held = anyDenial(run.services.db, run);
  if (!held) return null;
  if (isShellDenial(held)) return SHELL_REFUSED_LINE;
  const why = what === "command" ? "This command may touch it, and I cannot tell from the command which files it reaches." : "This tool may reach it, and I cannot tell from its arguments what it touches.";
  return `You said no to ${OPERATION_PHRASE[held.operation]} ${refusedThing(held, (text) => entry(text, 200))} earlier in this task. ${why}`;
}

function refusedAfterNo(run: RunContext, tool: string, args: Record<string, unknown>, assessment: CallAssessment, hit: DenialRecord): Decision {
  const bot = run.services.botName?.trim() || "A bot";
  return {
    ...refuse(
      "denied_resource",
      `Refused: the owner said no to ${OPERATION_PHRASE[hit.operation]} ${refusedThing(hit, (text) => entry(text, 200))} earlier in this task. This covers every tool and every route to it, for the rest of this task. Do not try again. Tell the owner what you were trying to do and ask how to continue.`,
      `owner said no to ${hit.operation} on ${hit.kind}`,
    ),
    preview: `Blocked: ${entry(bot, 60)} tried to ${verbFor(tool, args, assessment, false)} after you said no to ${DENIED_GERUND[hit.operation]} it.`,
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
    case "job_schedule": return isRecurringSchedule(args) ? "start a repeating job" : "schedule the next job";
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
    principal: run.principal?.kind ?? "unknown",
    tainted: isTainted(run),
  };
  if (isTainted(run)) base.taint = newestFirst(run).reverse().map((source) => ({ kind: source.kind, label: source.label }));
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
      if (decision.card.refusedRun) base.refusedRun = true;
      if (decision.card.standingRule) base.standingRule = true;
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
