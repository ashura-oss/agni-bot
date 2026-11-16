/**
 * Spend caps: "is there budget left?" The engine asks this before every model
 * call (S2-11). Spend comes from the per-call ledger (`usage_ledger.cost_usd`),
 * caps from the owner's settings (`stores/policy-settings.ts`), both read live.
 *
 * Three scopes, narrowest first, so the reason names the most specific thing
 * that ran out: one root job in total, one bot's local day, everything's local
 * day. A call of unknown cost (a model with no price) adds nothing to spend;
 * the spend status counts those so the owner can see the gap.
 *
 * Cost: at most three indexed SUM queries per call, none when a cap is off; the
 * local-day boundary is cached until it passes.
 */
import type { Database } from "bun:sqlite";
import { resolveTimeZone } from "../config";
import { getSpendCaps } from "../stores/policy-settings";
import { localDayBounds, spentSince } from "../stores/usage";

/** Who is about to spend. Calls with no job (a chat reply) pass only `agentID`. */
export interface BudgetInput {
  agentID?: string;
  jobID?: string;
  /** The root of the delegation tree the job belongs to; a job with no parent is its own root. */
  rootJobID?: string;
}

/** Which cap stopped the run: today's total, one bot's day, or one job (root job) in all. */
export type BudgetScope = "day" | "bot" | "job";

export type BudgetDecision =
  | { ok: true }
  | { ok: false; scope: BudgetScope; spentUsd: number; capUsd: number };

let source: Database | null = null;

/**
 * Register the database the server checks against. Called once at startup by
 * `startup/s2-ledger.ts`; `null` unregisters (tests).
 */
export function configureBudget(db: Database | null): void {
  source = db;
  dayCache = null;
}

interface DayCache {
  timeZone: string;
  startISO: string;
  endMs: number;
}
let dayCache: DayCache | null = null;

/** Start of the current local day, cached until the next local midnight. */
function todayStartISO(): string {
  const now = Date.now();
  const timeZone = resolveTimeZone();
  if (dayCache && dayCache.timeZone === timeZone && now < dayCache.endMs) return dayCache.startISO;
  const bounds = localDayBounds(new Date(now), timeZone);
  dayCache = { timeZone, startISO: bounds.startISO, endMs: Date.parse(bounds.endISO) };
  return bounds.startISO;
}

/** Extra spend each root job may make beyond its caps after the owner chose "Continue once". */
const grants = new Map<string, { baselineUsd: number; allowanceUsd: number }>();
const MAX_GRANTS = 500;

/**
 * Check the caps before a model call. Pass `db` in tests; the server uses the
 * database registered by `configureBudget` at startup. With no database
 * registered nothing can be counted, so the check allows the call.
 */
export function checkBudget(input: BudgetInput, db: Database | null = source): BudgetDecision {
  if (!db) return { ok: true };
  const caps = getSpendCaps(db);
  const rootJobID = input.rootJobID ?? input.jobID;
  const grant = rootJobID !== undefined ? grants.get(rootJobID) : undefined;
  const needRootSpend = rootJobID !== undefined && (caps.perJobUsd !== null || grant !== undefined);
  const rootSpent = needRootSpend ? spentSince(db, "", { rootJobID }) : 0;

  // "Continue once": this root job may spend its granted amount beyond whatever stopped it.
  if (grant && rootSpent - grant.baselineUsd < grant.allowanceUsd) return { ok: true };

  if (caps.perJobUsd !== null && rootJobID !== undefined && rootSpent >= caps.perJobUsd) {
    return { ok: false, scope: "job", spentUsd: rootSpent, capUsd: caps.perJobUsd };
  }
  const dayStart = caps.perBotDayUsd !== null || caps.dayUsd !== null ? todayStartISO() : "";
  if (caps.perBotDayUsd !== null && input.agentID !== undefined) {
    const spent = spentSince(db, dayStart, { agentID: input.agentID });
    if (spent >= caps.perBotDayUsd) return { ok: false, scope: "bot", spentUsd: spent, capUsd: caps.perBotDayUsd };
  }
  if (caps.dayUsd !== null) {
    const spent = spentSince(db, dayStart);
    if (spent >= caps.dayUsd) return { ok: false, scope: "day", spentUsd: spent, capUsd: caps.dayUsd };
  }
  return { ok: true };
}

/**
 * "Continue once": let a run that hit a cap spend as much again as the per-job
 * cap, for that root job only (tech lead decision). Repeated grants add up.
 * Returns the extra amount granted in USD, or 0 when there is no per-job cap
 * to measure it by. Grants live in memory: a restart ends the run they were for.
 */
export function grantContinueOnce(rootJobID: string, db: Database | null = source): number {
  if (!db) return 0;
  const extra = getSpendCaps(db).perJobUsd;
  if (extra === null) return 0;
  const existing = grants.get(rootJobID);
  if (existing) {
    existing.allowanceUsd += extra;
  } else {
    if (grants.size >= MAX_GRANTS) grants.delete(grants.keys().next().value as string);
    grants.set(rootJobID, { baselineUsd: spentSince(db, "", { rootJobID }), allowanceUsd: extra });
  }
  return extra;
}
