/**
 * The Sprint 2 policy frames: pause-all, per-bot off, spend status and caps,
 * and the full text behind an approval card. Kept out of `dispatch.ts` (already
 * very large); `dispatch` hands each frame here with a small deps object.
 */
import type { Database } from "bun:sqlite";
import type { AgentInfo, ClientFrame, ServerFrameBody } from "@agni/protocol";
import { canonicalAgentID, mentionRoster, personaInfo } from "../agent/personas";
import { resolveJobAgent } from "../jobs/runner";
import type { JobRow } from "../stores/jobs";
import { log } from "../log";
import { audit } from "../policy/audit-sink";
import { grantContinueOnce } from "../policy/budget";
import { listBotStates, readPauseState, setAgentEnabled, setAllPaused } from "../policy/pause";
import { getRunCaps } from "../stores/policy-settings";
import { fullApprovalText, markFullOpened } from "./approval-full";
import { cancelTurnsForPause, runningTurnCountForAgent, type PauseAbortReason } from "./turn-registry";

export interface PolicyFrameDeps {
  db: Database;
  /** To every connected client (and the replay log). */
  emit: (body: ServerFrameBody) => unknown;
  /** To the connection that asked. */
  reply: (body: ServerFrameBody) => unknown;
  error: (code: string, message: string) => void;
  /** Who is acting: the device id. */
  actor: string;
  /** Start the owner messages that waited while everything was paused. */
  releaseHeld: () => void;
}

type PauseOk = Extract<ServerFrameBody, { type: "policy.pause.ok" }>;

/** The counts a "Turn off Ava?" dialog needs: queued bot jobs per bot, wakes and delegations left out. */
function scheduledJobCounts(db: Database): Map<string, number> {
  const counts = new Map<string, number>();
  const rows = db
    .query<JobRow, []>(
      "SELECT id, kind, payload, state, run_at, attempts, result, enabled, created_at, updated_at FROM jobs WHERE state = 'queued' AND enabled = 1 AND kind IN ('turn', 'routine')",
    )
    .all();
  for (const row of rows) {
    if (row.kind === "turn") {
      try {
        const payload = JSON.parse(row.payload ?? "{}") as { wakeKey?: unknown; delegationTaskID?: unknown };
        if (payload.wakeKey || payload.delegationTaskID) continue;
      } catch {
        continue;
      }
    }
    const who = resolveJobAgent(db, row);
    const agentID = who.ok ? who.agentID : null;
    if (agentID) counts.set(agentID, (counts.get(agentID) ?? 0) + 1);
  }
  return counts;
}

/** The `policy.pause.ok` body for the state right now. */
export function pauseStateBody(db: Database, stopped = 0): PauseOk {
  const state = readPauseState(db);
  const scheduled = scheduledJobCounts(db);
  return {
    type: "policy.pause.ok",
    paused: state.paused,
    ...(state.changedAt ? { changedAt: state.changedAt } : {}),
    stopped,
    bots: listBotStates(db).map((bot) => ({
      agentID: bot.agentID,
      name: bot.name,
      enabled: bot.enabled,
      runningTurns: runningTurnCountForAgent(bot.agentID),
      scheduledJobs: scheduled.get(bot.agentID) ?? 0,
    })),
  };
}

/** True when anything differs from the default (nothing paused, every bot on): only then is the state worth sending unasked. */
export function pauseStateIsNonDefault(db: Database): boolean {
  return readPauseState(db).paused || listBotStates(db).some((bot) => !bot.enabled);
}

/** The roster with `enabled: false` on a bot that is off; a bot that is on carries no flag. */
export function withEnabledFlags(db: Database, agents: AgentInfo[]): AgentInfo[] {
  const off = new Set(listBotStates(db).filter((bot) => !bot.enabled).map((bot) => bot.agentID));
  return off.size === 0 ? agents : agents.map((agent) => (off.has(agent.id) ? { ...agent, enabled: false } : agent));
}

/** One notice per stopped run, in its own channel: what stopped it and that nothing was lost. */
function stopNotice(deps: PolicyFrameDeps, reason: PauseAbortReason, agentID: string | undefined, threadID: string): void {
  const owner = agentID ?? deps.db.query<{ agent_id: string }, [string]>("SELECT agent_id FROM threads WHERE id = ?").get(threadID)?.agent_id;
  if (!owner) return;
  const name = listBotStates(deps.db).find((bot) => bot.agentID === owner)?.name ?? "the bot";
  deps.emit({
    type: "status.update",
    channelId: canonicalAgentID(owner) === "ea" ? "main" : `dm:${owner}`,
    agentId: owner,
    text: reason === "paused" ? "Stopped: you paused all bots. Work done so far is kept." : `Stopped: you turned ${name} off. Work done so far is kept.`,
    transient: false,
  });
}

function stopTurns(deps: PolicyFrameDeps, reason: PauseAbortReason, agentID?: string): number {
  return cancelTurnsForPause(reason, agentID, (turn) => stopNotice(deps, reason, turn.agentID, turn.threadID));
}

/** Run a change that records itself in the audit log; a log that is down says so instead of leaving a half change. */
function guarded(deps: PolicyFrameDeps, change: () => void): boolean {
  try {
    change();
    return true;
  } catch (error) {
    log.error("policy change refused: the audit log could not record it", error);
    deps.error("internal", "That change could not be written to the audit log, so it was not made.");
    return false;
  }
}

export function handlePolicyPause(deps: PolicyFrameDeps, frame: Extract<ClientFrame, { type: "policy.pause" }>): void {
  if (frame.agentID !== undefined) {
    if (frame.paused === undefined) return void deps.reply(pauseStateBody(deps.db));
    return handleAgentEnabled(deps, { type: "agent.enabled.set", agentID: frame.agentID, enabled: !frame.paused });
  }
  if (frame.paused === undefined) return void deps.reply(pauseStateBody(deps.db));
  if (!guarded(deps, () => void setAllPaused(deps.db, frame.paused!, { actor: deps.actor }))) return;
  const stopped = frame.paused ? stopTurns(deps, "paused") : 0;
  deps.emit(pauseStateBody(deps.db, stopped));
  if (!frame.paused) deps.releaseHeld();
}

export function handleAgentEnabled(deps: PolicyFrameDeps, frame: Extract<ClientFrame, { type: "agent.enabled.set" }>): void {
  // `agni` and `ea` are one bot: everything below works on the canonical id.
  const agentID = canonicalAgentID(frame.agentID);
  if (!listBotStates(deps.db).some((bot) => bot.agentID === agentID)) {
    return deps.error("unknown_agent", `no agent ${frame.agentID}`);
  }
  if (!guarded(deps, () => void setAgentEnabled(deps.db, agentID, frame.enabled, { actor: deps.actor }))) return;
  const stopped = frame.enabled ? 0 : stopTurns(deps, "agent_off", agentID);
  deps.emit(pauseStateBody(deps.db, stopped));
  deps.emit({ type: "agents.update", agents: withEnabledFlags(deps.db, personaInfo(deps.db)), mentions: withEnabledFlags(deps.db, mentionRoster(deps.db)) });
  if (frame.enabled) deps.releaseHeld();
}

// --- spend ---------------------------------------------------------------------

type SpendOk = Extract<ServerFrameBody, { type: "spend.status.ok" }>;
type CapsBody = SpendOk["caps"];

/** What the spend frames need from the ledger and caps (Sprint 2, S2-3). Registered at startup once that is built in. */
export interface SpendProvider {
  status(db: Database): Omit<SpendOk, "type">;
  setCaps(db: Database, caps: Partial<CapsBody>): CapsBody;
}

let spendProvider: SpendProvider | null = null;

export function setSpendProvider(provider: SpendProvider | null): void {
  spendProvider = provider;
}

const NO_SPEND = "Spending limits are not available in this build.";

/**
 * The `spend.status.ok` body: today's numbers, and the owner's run limits to show beside them (read-only). A run-limit
 * read that fails leaves `runCaps` out and says so in the log; the status itself still goes.
 */
function spendStatusBody(provider: SpendProvider, db: Database): SpendOk {
  const body: SpendOk = { type: "spend.status.ok", ...provider.status(db) };
  try {
    const caps = getRunCaps(db);
    body.runCaps = {
      rootJobWallMinutes: caps.rootJobWallMs / 60_000,
      maxConcurrentDelegations: caps.maxConcurrentDelegations,
      maxSelfScheduledJobsPerBot: caps.maxSelfScheduledJobsPerBot,
      maxWakesPerRequest: caps.maxWakesPerRequest,
    };
  } catch (error) {
    log.error("spend status sent without the run caps: they could not be read", error);
  }
  return body;
}

export function handleSpendStatus(deps: PolicyFrameDeps): void {
  if (!spendProvider) return deps.error("spend_unavailable", NO_SPEND);
  deps.reply(spendStatusBody(spendProvider, deps.db));
}

export function handleSpendCapsSet(deps: PolicyFrameDeps, frame: Extract<ClientFrame, { type: "spend.caps.set" }>): void {
  if (!spendProvider) return deps.error("spend_unavailable", NO_SPEND);
  const requested: Partial<CapsBody> = {};
  if (frame.dayUsd !== undefined) requested.dayUsd = frame.dayUsd;
  if (frame.perBotDayUsd !== undefined) requested.perBotDayUsd = frame.perBotDayUsd;
  if (frame.perJobUsd !== undefined) requested.perJobUsd = frame.perJobUsd;
  const before = spendProvider.status(deps.db).caps;
  const after = { ...before, ...requested };
  if (after.dayUsd !== null && after.perBotDayUsd !== null && after.perBotDayUsd > after.dayUsd) {
    return deps.error("bad_cap", "Each bot's limit cannot be more than the daily limit.");
  }
  // A cap is a limit the owner can lift: the change goes on the record first, and a log that is down stops it.
  try {
    audit({ kind: "spend.caps.set", actor: deps.actor, detail: { before, after } });
  } catch (error) {
    log.error("spend caps not changed: the audit log could not record it", error);
    return deps.error("internal", "That change could not be written to the audit log, so it was not made.");
  }
  try {
    spendProvider.setCaps(deps.db, requested);
  } catch (error) {
    return deps.error("bad_cap", error instanceof Error ? error.message : "Those limits cannot be used.");
  }
  deps.emit(spendStatusBody(spendProvider, deps.db));
}

/**
 * "Continue once": the owner lets a run that a spend cap stopped go on, for one more allowance. This is the
 * only caller of `grantContinueOnce`; no tool, bot or job reaches it. The change goes on the record first, as a
 * cap change does, and a log that is down stops it.
 */
export function handleSpendContinue(deps: PolicyFrameDeps, frame: Extract<ClientFrame, { type: "spend.continue" }>): void {
  try {
    audit({ kind: "spend.continue", actor: deps.actor, detail: { runKey: frame.runKey } });
  } catch (error) {
    log.error("spend continue refused: the audit log could not record it", error);
    return deps.error("internal", "That change could not be written to the audit log, so it was not made.");
  }
  const grantedUsd = grantContinueOnce(frame.runKey, deps.db);
  if (grantedUsd <= 0) return deps.error("not_found", "That run is not stopped for spending, so there is nothing to continue.");
  deps.reply({ type: "spend.continue.ok", runKey: frame.runKey, grantedUsd });
}

// --- approval.full ---------------------------------------------------------------

export function handleApprovalFull(deps: PolicyFrameDeps, frame: Extract<ClientFrame, { type: "approval.full" }>): void {
  const full = fullApprovalText(deps.db, frame.requestID);
  if (!full) return deps.error("not_found", `no waiting card ${frame.requestID} with a full text to show`);
  // The owner's client has the whole text now; the card may be allowed (`approve.reply`, `ws/dispatch.ts`).
  markFullOpened(frame.requestID, full.cut);
  deps.reply({ type: "approval.full.ok", requestID: frame.requestID, text: full.text, ...(full.cut ? { cut: true } : {}) });
}
