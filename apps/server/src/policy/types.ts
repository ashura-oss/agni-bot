/**
 * The policy contract: the types every Sprint 2 task and Sprint 3 build
 * against. Committed first (S2-1a) so nobody waits on the engine.
 *
 * One gatekeeper, `decide(run, call)` in `engine.ts`, answers every tool call
 * with a `Decision`. What a call is (`ToolMeta`) lives in `tool-meta.ts`
 * (frozen); where audit rows go (`AuditSink`) lives in `audit-sink.ts`
 * (frozen). This file holds the rest: the run being judged, the call, and the
 * answer.
 *
 * Contracts other tasks implement (the engine calls these through
 * `policy/hooks.ts`, so a task that has not merged yet leaves the default):
 *
 *   S2-3  `checkBudget(run: RunContext): BudgetVerdict`      in `policy/budget.ts`
 *   S2-2  `isRunPaused(run: RunContext): PauseVerdict | null` in `policy/pause.ts`
 */
import type { Database } from "bun:sqlite";
import type { ToolMeta, ToolResource, ToolTier } from "./tool-meta";

export type { ToolMeta, ToolResource, ToolTier, ToolClass } from "./tool-meta";
export type { AuditEvent, AuditSink } from "./audit-sink";

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * What kind of outsider text a run has read. The approval card names it:
 * "Ava read a web page earlier in this task: example.com/offers".
 */
export type TaintKind = "web" | "email" | "peer" | "attachment" | "mcp" | "routine" | "scheduled" | "unknown";

export interface TaintSource {
  kind: TaintKind;
  /** One short line for the card: a host and path (no query), a sender and subject, a bot name, a file name. Already cleaned for display. */
  label: string;
  /** The tool whose result brought it in, when a tool did. */
  tool?: string;
  /** ISO time the run first read it. */
  at: string;
}

/**
 * Who the run is acting for:
 *  - owner: the owner's own chat turn.
 *  - peer: another bot's brief, handoff or delegation (text the owner did not write).
 *  - routine: an unattended routine run (its saved state is outside text).
 *  - job: a turn the daemon starts from a scheduled job (model-written text from an untainted run).
 *  - wake: a turn that tells a parent bot its delegated task finished.
 */
export type PrincipalKind = "owner" | "peer" | "routine" | "job" | "wake";

export interface Principal {
  kind: PrincipalKind;
  /** The bot that wrote the text, for a peer. */
  from?: string;
}

/** Money state a run carries, written by S2-3's recorder and read by `checkBudget`. */
export interface RunBudget {
  /** Dollars the owner allowed this run on top of its caps ("Continue once"). Starts at 0. */
  extraAllowanceUSD: number;
}

/** What the engine needs from the world around the run. Built once per turn. */
export interface RunServices {
  db: Database;
  /** Why the arguments break the tool's schema, or null (the registry's `validateArgs`). */
  validateArgs: (tool: string, args: Record<string, unknown>, bot?: string) => string | null;
  /** True when the tool is registered in this turn. */
  hasTool: (tool: string) => boolean;
  /** What a tool says about itself (a connector tool's own meta), when it says anything. */
  metaOf?: (tool: string) => ToolMeta | undefined;
  /** A deferred tool the model has not loaded yet: its schema was never sent. */
  isUnloaded: (tool: string) => boolean;
  /** A routine's domain allowlist for web tools; absent outside routines. */
  allowedDomains?: string[];
  /** Display name of the bot, for cards. Null when unknown ("A bot"). */
  botName: string | null;
}

export interface RunContext {
  /** The bot running (an `agents.id`). */
  bot: string;
  threadID: string;
  turnID: string;
  /** The daemon job this run belongs to, or null for an owner chat turn. */
  jobID: string | null;
  /**
   * The refusal scope: the job at the root of a delegation chain, or null when the chain has no job. What the owner
   * refused under a root holds for everything that belongs to it: the children, a resumed task, the wake that reports back.
   */
  rootJob: string | null;
  /** The turn at the root of the chain: the "run" a denial belongs to when no job does. */
  rootTurnID: string;
  /**
   * The refusal scope this run was handed, when it is not its own root: a job a bot scheduled keeps the scope of the run that
   * scheduled it (and what that run delegated, woke or resumed carries it on), so what the owner refused there holds in the job
   * for good. Set by the server from the job's payload, never by a tool's arguments. Absent: the scope is the root's own.
   */
  denialRoot?: string;
  /**
   * The time limit's clock (`agent/run-clock.ts`), which is not the same thing as the root: a wake, a resumed task and a
   * job's next run keep the refusals of their root but start a clock of their own. A delegated child shares its parent's.
   */
  clockKey: string;
  principal: Principal;
  /** The tools this run may call at all (the persona's allowlist narrowed by the chain). Deferred tools are in it. */
  effectiveCapabilities: ReadonlySet<string>;
  /**
   * `effectiveCapabilities` was cut down by whoever started this run (a bot's brief or a delegated task, or a job a narrowed run
   * scheduled), not just by the persona. A job this run schedules carries the set so its fires are cut down to it too.
   */
  narrowed?: boolean;
  /**
   * Where this run's chain came from (`policy/provenance.ts`). `ownerStarted` is a positive marker set by the front door that knows
   * (the owner's own chat turn, a job the owner made); `botChained` is set by any link a bot made, and never cleared. A run is the
   * owner's own work only when the first is true and the second false: a missing or unreadable record is a bot's.
   */
  ownerStarted: boolean;
  botChained: boolean;
  /** Outsider text this run has read. Empty means untainted. Grows during the run; never shrinks. */
  taint: { sources: TaintSource[] };
  budget: RunBudget;
  /** The owner's own words in this conversation, for the egress binding. Never text a bot or a tool wrote. */
  ownerText: string[];
  /** Nobody is watching (a job or routine run): cards wait longer, and `ask` is not possible. */
  unattended: boolean;
  services: RunServices;
  /** Told every time the run is marked, with all it has read so far, so the mark can be saved before the run goes on (a crash must not lose it). */
  onTaint?: (sources: readonly TaintSource[]) => void;
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

export interface PolicyInput {
  tool: string;
  args: Record<string, unknown>;
  /** The model's call id, for the audit trail and the card. */
  callID: string;
}

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

/**
 * What kind of standing rule (work that starts again on its own) a call is, as the engine classified it. The card carries it, and
 * the preview is chosen by it, so what the owner reads is the view of what the engine decided (`policy/standing-rules.ts`).
 *  - repeating_job: a `job_schedule` with a clock time or an interval.
 *  - next_job: a one-shot `job_schedule` from a run of a job a bot made (a chain of one-shot jobs is a repeating job by another route).
 *  - routine_create: a new routine.
 *  - routine_resume: `routine_pause` with `enabled: true`.
 */
export type StandingKind = "repeating_job" | "next_job" | "routine_create" | "routine_resume";

/** What the owner's card should say about the harm, in words: the tier alone is not precise enough. */
export type RiskKind = "undoable" | "egress" | "irreversible" | "either" | "command" | "standing";

/** What a call does once its arguments are read: the engine's own view of one call. */
export interface CallAssessment {
  /** The tier of this call, which can differ from the tool's default (a new file in scratch is 0, an overwrite 1). */
  tier: ToolTier;
  risk: RiskKind;
  /** Would an untainted run be asked? False means free until the run is tainted. */
  asks: boolean;
  /**
   * Does the call send data out of the app? `send` (a mail, an invite, a connector call) needs the owner in
   * a tainted run; `fetch` (opening a site) needs the owner only for a destination the owner did not name.
   */
  egress: EgressKind;
  /** Where an egress call goes (recipients, hosts). */
  destinations: ToolResource[];
  /** What the call touches, for denials and rules. */
  resources: ToolResource[];
  /** The operation, in plain verbs: reading, changing, deleting, sending to. */
  operation: Operation;
  /** A shell call the server could not prove to be one allowlisted program on plain files (policy/shell-proof.ts): what it touches is unknown. */
  unprovenShell?: boolean;
}

export type EgressKind = "none" | "send" | "fetch";

export type Operation = "read" | "change" | "delete" | "send" | "run";

/** What the owner's card shows besides the preview. All strings are already cleaned for display. */
export interface ApprovalCard {
  tier: ToolTier;
  risk: RiskKind;
  /** Heading verb phrase: "send an email", "overwrite a file". */
  verb: string;
  /** Newest source first. Empty for an untainted run. */
  sources: TaintSource[];
  /** "Always allow" is offered. False in a tainted run and for tools that are never remembered. */
  canRemember: boolean;
  /** The egress binding raised this card: a destination the owner did not name. */
  unnamedDestinations: string[];
  /** The resources the call touches, for a denial. */
  resources: ToolResource[];
  operation: Operation;
  /**
   * This run holds a refusal that reaches the call: a shell command the server cannot read file names from, or (after
   * the owner refused such a command) any shell call or file write. One sentence naming what the owner refused. The
   * card leads with it.
   */
  refusedRun?: string;
  /**
   * The call starts work that repeats on its own (a repeating job) and this run is not the owner's own untainted turn: one
   * sentence saying why the owner is asked. "Always allow" is off for such a card, and no stored rule answers it.
   */
  standingRule?: string;
  /**
   * What kind of standing rule the engine decided this call is. Set whenever `standingRule` is. The preview is the view of this
   * kind, and a card whose kind and call disagree is not shown (`agent/card-preview.ts`).
   */
  standingKind?: StandingKind;
  /**
   * The standing rule is asked of a run that has read outside text, so what it starts will run with that text's restrictions
   * from its first step. The card says so.
   */
  standingTainted?: boolean;
  /**
   * The standing rule is asked of a run whose tools were narrowed: what it starts will run with those tools (the tools of the run
   * that asked), not with everything the bot may call. The card says so.
   */
  standingNarrowed?: boolean;
}

/** Why a call was refused, as a stable code for tests, the audit trail and the model's error. */
export type RefusalCode =
  | "not_available"
  | "not_loaded"
  | "invalid_arguments"
  | "domain_not_allowed"
  | "protected_write"
  | "denied_resource"
  | "audit_unavailable"
  /** The owner could not be shown the whole call (too long for a card, or the call and its classification disagree): no card is raised and nothing runs. */
  | "cannot_show"
  | "off";

/** The standing rule that let a call through, for the approval row that records it. */
export interface RuleRef { id: string; agentID: string; toolName: string; createdAt: string }

export type StopCause = "budget" | "pause" | "refused" | "wall_time";

/**
 * Which cap stopped a run and how far it got, for the owner's notice and its "Raise" and "Continue once"
 * buttons. `runKey` names the stopped run for the owner frame `spend.continue`.
 */
export interface BudgetStopDetail {
  scope: "day" | "bot" | "job";
  /** `over_cap`: the cap was reached. `cost_unknown`: spend that cannot be priced is in the scope. `budget_unreadable`: spend could not be read. */
  reason: "over_cap" | "cost_unknown" | "budget_unreadable";
  spentUsd: number;
  capUsd: number;
  runKey?: string;
}

/** The whole run ends here, and why: what the loop publishes and what the owner is shown. */
export interface RunStop {
  cause: StopCause;
  message: string;
  /** Set for a budget stop. */
  budget?: BudgetStopDetail;
}

export type Decision =
  /** Run it. `via` says what let it through: nothing needed asking, or a stored rule. */
  | { action: "run"; via: "free" | "rule"; reason: string; assessment: CallAssessment; ruleID?: string; rule?: RuleRef }
  /** Do not run it; the model gets `error` as the tool result. */
  | { action: "refuse"; code: RefusalCode; error: string; reason: string; /** One quiet line for the owner's activity strip, when the refusal is theirs to know about. */ preview?: string }
  /** Ask the owner with a card; the call runs only on an allowing answer. */
  | { action: "ask"; reason: string; assessment: CallAssessment; card: ApprovalCard }
  /** End the whole run, not just this call. */
  | { action: "stop"; cause: StopCause; message: string; reason: string; budget?: BudgetStopDetail };

// ---------------------------------------------------------------------------
// Contracts implemented elsewhere
// ---------------------------------------------------------------------------

/** S2-3: is there budget left for the next model call and tool call? */
export type BudgetVerdict =
  | { ok: true }
  | { ok: false; scope: "day" | "bot" | "job"; spentUSD: number; capUSD: number; message: string; detail?: BudgetStopDetail };

/** S2-2: why a run may not continue because of the pause switch. */
export interface PauseVerdict {
  scope: "all" | "bot";
  message: string;
}

export type CheckBudget = (run: RunContext) => BudgetVerdict;
export type IsRunPaused = (run: RunContext) => PauseVerdict | null;
