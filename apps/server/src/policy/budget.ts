/**
 * Spend caps: "is there budget left?" The router's gate asks this before every
 * model call (S2-11). Spend comes from the per-call ledger
 * (`usage_ledger.cost_usd`), caps from the owner's settings
 * (`stores/policy-settings.ts`), both read live.
 *
 * Three scopes, narrowest first, so the reason names the most specific thing
 * that ran out: one root job in total, one bot's local day, everything's local
 * day.
 *
 * Fails closed. A check that cannot read its state (no database registered, a
 * database error, a ledger write that failed and has not worked since) denies
 * the call as `budget_unreadable`. A scope that holds a call of unknown cost
 * (no usage reported, no price) is denied as `cost_unknown`, because that
 * spend cannot be counted; with token counts known an unpriced model is
 * charged a fallback price instead (`models/prices.ts`), so this is rare.
 *
 * Cost: at most a few indexed SUM queries per call, none for a scope whose cap
 * is off; the local-day boundary is cached until it passes.
 */
import type { Database } from "bun:sqlite";
import { resolveTimeZone } from "../config";
import { getSpendCaps } from "../stores/policy-settings";
import { localDayBounds, spentSince, unknownCostCallsSince } from "../stores/usage";

/** Who is about to spend. Calls with no job (a chat reply) pass only `agentID`. */
export interface BudgetInput {
  agentID?: string;
  jobID?: string;
  /** The root of the delegation tree the job belongs to. Left out, it is looked up from the job. */
  rootJobID?: string;
}

/** Which cap stopped the run: today's total, one bot's day, or one job (root job) in all. */
export type BudgetScope = "day" | "bot" | "job";

/** `over_cap`: spend reached the cap. `cost_unknown`: the scope holds spend that cannot be counted. `budget_unreadable`: the state could not be read. */
export type BudgetReason = "over_cap" | "cost_unknown" | "budget_unreadable";

export type BudgetDecision =
  | { ok: true }
  | { ok: false; reason: BudgetReason; scope: BudgetScope; spentUsd: number; capUsd: number };

/** What "Continue once" adds when the per-job cap is switched off. */
export const CONTINUE_ONCE_DEFAULT_USD = 0.5;

let source: Database | null = null;
/** True after a ledger write failed, until a write (or the probe in `checkBudget`) works again. */
let ledgerFault = false;

interface Stop { scope: BudgetScope; reason: BudgetReason; agentID?: string }
interface Grant { baselineUsd: number; allowanceUsd: number; unknownOK: boolean; agentID?: string }
const stops = new Map<string, Stop>();
const grants = new Map<string, Grant>();
const MAX_TRACKED = 500;

/**
 * Register the database the server checks against. Called once at startup by
 * `startup/s2-ledger.ts`; `null` unregisters (tests). Clears stops and grants.
 */
export function configureBudget(db: Database | null): void {
  source = db;
  dayCache = null;
  ledgerFault = false;
  stops.clear();
  grants.clear();
}

/** Has the server pointed the check at its database? Before that (a tool, a test) there is nothing to cap. */
export function isBudgetConfigured(): boolean {
  return source !== null;
}

/** The ledger recorder reports each write here: a failure denies further calls until one works. */
export function markLedgerWrite(ok: boolean): void {
  ledgerFault = !ok;
}

interface DayCache { timeZone: string; startISO: string; endMs: number }
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

/**
 * The root of a job's delegation tree. A delegated job's payload names its root
 * (`rootJob`); a job with none, or one that is not recorded, is its own root.
 */
export function resolveRootJobID(db: Database, jobID: string): string {
  let current = jobID;
  for (let hops = 0; hops < 8; hops++) {
    const row = db.query<{ payload: string | null }, [string]>("SELECT payload FROM jobs WHERE id = ?").get(current);
    if (!row?.payload) return current;
    let root: unknown;
    try {
      root = (JSON.parse(row.payload) as { rootJob?: unknown } | null)?.rootJob;
    } catch {
      return current;
    }
    if (typeof root !== "string" || root === "" || root === current) return current;
    current = root;
  }
  return current;
}

/** The key a stopped run is known by for "Continue once": its root job, else the bot for a plain chat reply. */
export function budgetRunKey(input: BudgetInput, db: Database | null = source): string | undefined {
  if (input.rootJobID) return input.rootJobID;
  if (input.jobID) return db ? resolveRootJobID(db, input.jobID) : input.jobID;
  return input.agentID ? `agent:${input.agentID}` : undefined;
}

function unreadable(): BudgetDecision {
  return { ok: false, reason: "budget_unreadable", scope: "day", spentUsd: 0, capUsd: 0 };
}

/** Can the ledger be written right now? Tries a row inside a savepoint and rolls it back, leaving nothing behind. */
function probeLedger(db: Database): boolean {
  try {
    db.run("SAVEPOINT budget_probe");
    try {
      db.run("INSERT INTO usage_ledger (id, provider, model, day, created_at) VALUES ('probe', 'probe', 'probe', '1970-01-01', '1970-01-01T00:00:00.000Z')");
    } finally {
      db.run("ROLLBACK TO budget_probe");
      db.run("RELEASE budget_probe");
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Check the caps before a model call. Pass `db` in tests; the server uses the
 * database registered by `configureBudget` at startup. With nothing to read
 * the call is denied (`budget_unreadable`).
 */
export function checkBudget(input: BudgetInput, db: Database | null = source): BudgetDecision {
  if (!db) return unreadable();
  try {
    if (ledgerFault) {
      if (!probeLedger(db)) return unreadable();
      ledgerFault = false;
    }
    return evaluate(input, db);
  } catch {
    return unreadable();
  }
}

function evaluate(input: BudgetInput, db: Database): BudgetDecision {
  const caps = getSpendCaps(db);
  const root = input.rootJobID ?? (input.jobID ? resolveRootJobID(db, input.jobID) : undefined);
  const key = budgetRunKey({ ...input, ...(root ? { rootJobID: root } : {}) }, db);
  const needsDay = caps.perBotDayUsd !== null || caps.dayUsd !== null;
  const dayStart = needsDay ? todayStartISO() : "";

  const deny = (scope: BudgetScope, reason: BudgetReason, spentUsd: number, capUsd: number): BudgetDecision => {
    if (key !== undefined) {
      if (!stops.has(key) && stops.size >= MAX_TRACKED) stops.delete(stops.keys().next().value as string);
      stops.set(key, { scope, reason, ...(input.agentID !== undefined ? { agentID: input.agentID } : {}) });
    }
    return { ok: false, reason, scope, spentUsd, capUsd };
  };

  const scopes: Array<{ scope: BudgetScope; cap: number | null; applies: boolean; spent: () => number; unknown: () => number }> = [
    {
      scope: "job", cap: caps.perJobUsd, applies: root !== undefined,
      spent: () => spentSince(db, "", { rootJobID: root }),
      unknown: () => unknownCostCallsSince(db, "", { rootJobID: root }),
    },
    {
      scope: "bot", cap: caps.perBotDayUsd, applies: input.agentID !== undefined,
      spent: () => spentSince(db, dayStart, { agentID: input.agentID }),
      unknown: () => unknownCostCallsSince(db, dayStart, { agentID: input.agentID }),
    },
    {
      scope: "day", cap: caps.dayUsd, applies: true,
      spent: () => spentSince(db, dayStart),
      unknown: () => unknownCostCallsSince(db, dayStart),
    },
  ];

  for (const { scope, cap, applies, spent, unknown } of scopes) {
    if (cap === null || !applies) continue;
    const found = key !== undefined ? grants.get(`${key}|${scope}`) : undefined;
    // A bot's grant is for that bot's day: another bot working under the same root job is not covered.
    const grant = scope === "bot" && found?.agentID !== input.agentID ? undefined : found;
    const used = spent();
    if (used >= cap && !(grant && used - grant.baselineUsd < grant.allowanceUsd)) return deny(scope, "over_cap", used, cap);
    if (!grant?.unknownOK && unknown() > 0) return deny(scope, "cost_unknown", used, cap);
  }
  return { ok: true };
}

/**
 * "Continue once": the owner lets a stopped run go on. Only the scope that
 * stopped it is lifted, by the per-job cap (or `CONTINUE_ONCE_DEFAULT_USD`
 * when that cap is off); the other scopes still apply. For a `cost_unknown`
 * stop it also lets that scope's unknown-cost calls pass. Repeated grants add up.
 * Returns the amount granted in USD, or 0 when this run was never stopped.
 *
 * Owner-only: the only caller allowed is the owner-frame handler in the
 * WebSocket layer. No tool, agent or job may call it (a test scans the source).
 * Grants live in memory: a restart ends the run they were for.
 */
export function grantContinueOnce(runKey: string, db: Database | null = source): number {
  if (!db) return 0;
  const stop = stops.get(runKey);
  if (!stop || stop.reason === "budget_unreadable") return 0;
  try {
    const amount = getSpendCaps(db).perJobUsd ?? CONTINUE_ONCE_DEFAULT_USD;
    const dayStart = todayStartISO();
    const measured = stop.scope === "job" ? spentSince(db, "", { rootJobID: runKey })
      : stop.scope === "bot" ? spentSince(db, dayStart, { agentID: stop.agentID ?? "" })
      : spentSince(db, dayStart);
    const id = `${runKey}|${stop.scope}`;
    const existing = grants.get(id);
    if (existing) {
      existing.allowanceUsd += amount;
      existing.unknownOK ||= stop.reason === "cost_unknown";
    } else {
      if (grants.size >= MAX_TRACKED) grants.delete(grants.keys().next().value as string);
      grants.set(id, {
        baselineUsd: measured,
        allowanceUsd: amount,
        unknownOK: stop.reason === "cost_unknown",
        ...(stop.agentID !== undefined ? { agentID: stop.agentID } : {}),
      });
    }
    return amount;
  } catch {
    return 0;
  }
}
