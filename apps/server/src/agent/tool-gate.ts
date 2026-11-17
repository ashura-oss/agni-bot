/**
 * Putting the policy engine's answer into effect for one tool call: refuse it,
 * stop the run, let it through, or ask the owner and write their answer down.
 *
 * `executeTool` and the tests both go through here, so there is one way for a
 * call to get past the gate. The engine decides (`policy/engine.ts`); the
 * broker draws the card (`approval-broker.ts`); this joins them.
 */
import type { Database } from "bun:sqlite";
import type { ServerFrameBody } from "@agni/protocol";
import type { ApprovalBroker } from "./approval-broker";
import { CardNotShown } from "./card-preview";
import { expireApprovalForCall } from "./pending-cards";
import { audit } from "../policy/audit-sink";
import { SHELL_REFUSAL, recordDenial } from "../policy/denials";
import { decide } from "../policy/engine";
import { describeRecurring } from "../policy/standing-rules";
import type { ApprovalCard, CallAssessment, PolicyInput, RunContext, RunStop } from "../policy/types";
import { entry } from "./card-text";

export interface GateDeps {
  db: Database;
  broker: ApprovalBroker;
  emit: (frame: ServerFrameBody) => void;
  /** The session state while the call waits on the owner: "awaiting_approval", then "running". */
  setState: (state: string) => void;
  /** Stop the turn's clock while the call waits on the owner; the result ends the wait. */
  hold: () => () => void;
  /** The longest the owner is waited for before the card expires. */
  ownerWaitMs: number;
}

export type GateResult =
  | { go: true; assessment: CallAssessment; approvedBy: "policy" | "rule" | "owner" }
  | {
    go: false;
    /** The tool result the model gets. */
    content: string;
    /** What is stored on the tool call row; the closure record and job retries read it. */
    code: string;
    /** The short line the activity strip shows. */
    preview: string;
    /** The owner was asked (the loop marks the session as having waited on a card). */
    awaiting: boolean;
    /** The whole run ends, not just this call. */
    stop?: RunStop;
  };

const blocked = (code: string, error: string, preview: string, awaiting = false): GateResult =>
  ({ go: false, content: JSON.stringify({ error }), code, preview, awaiting });

/** The `tool_calls.error` code stored for each refusal. The closure record and the job-retry check know these. */
const STORED_CODE: Record<string, string> = {
  not_available: "tool_not_allowed",
  not_loaded: "tool_not_loaded",
  domain_not_allowed: "domain_not_allowed",
  cannot_show: "cannot_show",
  protected_write: "protected_write",
  denied_resource: "denied_resource",
  audit_unavailable: "audit_unavailable",
};

const PREVIEW: Record<string, string> = {
  not_available: "not available", not_loaded: "not loaded", domain_not_allowed: "domain not allowed", cannot_show: "too much to show you",
  protected_write: "not allowed after outside content", denied_resource: "you said no to this", audit_unavailable: "not recorded",
};

export async function gateToolCall(deps: GateDeps, run: RunContext, input: PolicyInput, signal: AbortSignal): Promise<GateResult> {
  const decision = decide(run, input);
  switch (decision.action) {
    case "stop":
      return {
        go: false,
        content: JSON.stringify({ skipped: true, reason: decision.message }),
        code: `run_stopped_${decision.cause}`,
        preview: decision.cause === "pause" ? "paused" : decision.cause === "budget" ? "budget used up" : "stopped",
        awaiting: false,
        stop: { cause: decision.cause, message: decision.message, ...(decision.budget ? { budget: decision.budget } : {}) },
      };
    case "refuse": {
      // An invalid call keeps its own message as the stored code, as the tool's own refusal always did.
      const code = decision.code === "invalid_arguments" ? decision.error : (STORED_CODE[decision.code] ?? decision.code);
      return blocked(code, decision.error, decision.preview ?? PREVIEW[decision.code] ?? decision.error.slice(0, 120));
    }
    case "run":
      if (decision.rule) deps.broker.recordRuleApproval(run.threadID, run.turnID, input.tool, input.callID, input.args, decision.rule);
      return { go: true, assessment: decision.assessment, approvedBy: decision.via === "rule" ? "rule" : "policy" };
    case "ask":
      return askOwner(deps, run, input, decision.card, decision.assessment, signal);
  }
}

async function askOwner(
  deps: GateDeps, run: RunContext, input: PolicyInput, card: ApprovalCard, assessment: CallAssessment, signal: AbortSignal,
): Promise<GateResult> {
  // Stopped already: no new card for a dead turn.
  if (signal.aborted) return { go: false, content: JSON.stringify({ skipped: true, reason: "cancelled" }), code: "cancelled", preview: "cancelled", awaiting: false };
  deps.setState("awaiting_approval");
  // The owner's time to decide is not the turn's.
  const release = deps.hold();
  const waitSignal = AbortSignal.any([signal, AbortSignal.timeout(deps.ownerWaitMs)]);
  // The deadline the card shows is the one the wait uses.
  const expiresAt = new Date(Date.now() + deps.ownerWaitMs).toISOString();
  let answer: Awaited<ReturnType<ApprovalBroker["request"]>>;
  try {
    answer = await deps.broker.request(run.threadID, run.turnID, input.tool, input.callID, input.args, waitSignal, { card, agentID: run.bot, botName: run.services.botName, expiresAt });
  } catch (error) {
    // The engine checks this before it asks; a card that still cannot be drawn (the routine it names went away, say) is not shown, and nothing runs.
    // It is not the owner's no: no denial is recorded.
    if (!(error instanceof CardNotShown)) throw error;
    deps.setState("running");
    return blocked("cannot_show", `Not done: ${error.message}`, "too much to show you");
  } finally {
    release();
  }
  deps.setState("running");
  const denial = (cause: "denied" | "expired"): void => {
    // The owner's no covers the thing, not just this call (S2-07). A bad row must not make the refusal weaker, so it is not left to chance:
    // a failure to write it is raised, and the call is refused either way.
    // A shell command the server could not read file names from names none, so its refusal is of running commands (policy/denials.ts).
    recordDenial(deps.db, run, { tool: input.tool, operation: card.operation, resources: assessment.unprovenShell ? [SHELL_REFUSAL] : card.resources, cause });
    if (card.standingRule) auditStandingRefusal(run, input, cause);
  };
  // Nobody answered in time (the turn itself was not stopped): expire the card.
  if (!answer && !signal.aborted && waitSignal.aborted) {
    expireApprovalForCall(deps.db, run.turnID, input.callID, "expired", deps.emit);
    denial("expired");
    return {
      ...blocked("approval_expired", declined(card, "Not approved: nobody answered in time, so the action was not run."), "expired", true),
    };
  }
  if (!answer || answer === "reject") {
    if (answer) denial("denied");
    else if (card.standingRule) auditStandingRefusal(run, input, "cancelled");
    return blocked("approval_rejected", declined(card, answer ? "User denied this action." : "Approval was cancelled."), answer ? "denied" : "cancelled", true);
  }
  try {
    audit({
      kind: "policy.approval",
      actor: run.bot,
      turnID: run.turnID,
      ...(run.jobID ? { jobID: run.jobID } : {}),
      detail: { tool: input.tool, callID: input.callID, answer, tier: card.tier, tainted: card.sources.length > 0, ...(card.unnamedDestinations.length ? { unnamedDestinations: card.unnamedDestinations.slice(0, 10) } : {}) },
    });
  } catch {
    return blocked("audit_unavailable", "Not run: the audit log could not record the approval, so the action was not run.", "not recorded", true);
  }
  return { go: true, assessment, approvedBy: "owner" };
}

/**
 * A repeating job the owner did not approve leaves its own audit row, besides the denial. The call is refused either way, so a
 * row the trail cannot take does not change the answer.
 */
function auditStandingRefusal(run: RunContext, input: PolicyInput, cause: "denied" | "expired" | "cancelled"): void {
  try {
    audit({
      kind: "job.recurring.refused",
      actor: run.bot,
      turnID: run.turnID,
      ...(run.jobID ? { jobID: run.jobID } : {}),
      detail: { tool: input.tool, callID: input.callID, cause, schedule: describeRecurring(input.args), principal: run.principal?.kind ?? "unknown", request: run.denialRoot ?? run.rootJob ?? run.rootTurnID },
    });
  } catch {
    // The refusal stands without its row.
  }
}

/**
 * The model's text for a "no". A send to a place the owner did not name says
 * so, and says not to look for another way; every other "no" says not to
 * reach the same thing another way either.
 */
function declined(card: ApprovalCard, base: string): string {
  if (card.unnamedDestinations.length > 0) {
    const places = card.unnamedDestinations.map((destination) => entry(destination, 120)).join(", ");
    return `Not sent: the destination ${places} was not named by the owner and the owner did not approve it. Do not try another address or tool to send this. Ask the owner in plain words where it should go.`;
  }
  return `${base} Do not try to do the same thing another way; ask the owner how to continue.`;
}
