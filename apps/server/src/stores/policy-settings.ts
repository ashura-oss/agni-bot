/**
 * The owner's policy numbers (S2-11, S2-09): spend caps and run caps. Stored as
 * JSON text in `policy_settings` (migration 55), read live so a change applies
 * to the next model call. A missing or unreadable value is the default; `null`
 * means "no cap".
 */
import type { Database } from "bun:sqlite";
import { resolveTimeZone } from "../config";
import { nowISO } from "../util/ids";
import { localDayBounds, spentByBotSince, spentSince, unpricedCallsSince } from "./usage";

/** Owner decisions, 2026-11-16: $2 a day overall, $1 a day per bot, $0.50 a job. */
export const SPEND_CAP_DEFAULTS = { dayUsd: 2, perBotDayUsd: 1, perJobUsd: 0.5 } as const;

/** Owner decisions, 2026-11-16: 30 minutes per root job, 4 delegations at once, 10 self-scheduled jobs per bot. */
export const RUN_CAP_DEFAULTS = {
  rootJobWallMs: 30 * 60_000,
  maxConcurrentDelegations: 4,
  maxSelfScheduledJobsPerBot: 10,
} as const;

export interface SpendCaps {
  /** Everything, per local day. */
  dayUsd: number | null;
  /** One bot, per local day. */
  perBotDayUsd: number | null;
  /** One root job, in total. */
  perJobUsd: number | null;
}

export interface RunCaps {
  rootJobWallMs: number;
  maxConcurrentDelegations: number;
  maxSelfScheduledJobsPerBot: number;
}

const KEY = {
  dayUsd: "spend.day_cap_usd",
  perBotDayUsd: "spend.bot_day_cap_usd",
  perJobUsd: "spend.job_cap_usd",
  rootJobWallMs: "run.root_job_wall_ms",
  maxConcurrentDelegations: "run.max_concurrent_delegations",
  maxSelfScheduledJobsPerBot: "run.max_self_scheduled_jobs_per_bot",
} as const;

function readRaw(db: Database, key: string): { found: boolean; value: unknown } {
  const row = db.query<{ value: string }, [string]>("SELECT value FROM policy_settings WHERE key = ?").get(key);
  if (!row) return { found: false, value: undefined };
  try {
    return { found: true, value: JSON.parse(row.value) as unknown };
  } catch {
    return { found: false, value: undefined };
  }
}

function writeRaw(db: Database, key: string, value: number | null): void {
  db.run(
    `INSERT INTO policy_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, JSON.stringify(value), nowISO()],
  );
}

function readCap(db: Database, key: string, fallback: number): number | null {
  const { found, value } = readRaw(db, key);
  if (!found) return fallback;
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function readCount(db: Database, key: string, fallback: number): number {
  const { found, value } = readRaw(db, key);
  return found && typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

export function getSpendCaps(db: Database): SpendCaps {
  return {
    dayUsd: readCap(db, KEY.dayUsd, SPEND_CAP_DEFAULTS.dayUsd),
    perBotDayUsd: readCap(db, KEY.perBotDayUsd, SPEND_CAP_DEFAULTS.perBotDayUsd),
    perJobUsd: readCap(db, KEY.perJobUsd, SPEND_CAP_DEFAULTS.perJobUsd),
  };
}

/** Change any of the spend caps. `null` removes a cap. A bad value (not a positive number) throws and changes nothing. */
export function setSpendCaps(db: Database, caps: Partial<SpendCaps>): SpendCaps {
  for (const [name, value] of Object.entries(caps)) {
    if (value !== null && !(typeof value === "number" && Number.isFinite(value) && value > 0)) {
      throw new Error(`spend cap ${name} must be a positive number of dollars, or null for no cap`);
    }
  }
  db.transaction(() => {
    for (const name of ["dayUsd", "perBotDayUsd", "perJobUsd"] as const) {
      if (caps[name] !== undefined) writeRaw(db, KEY[name], caps[name]);
    }
  })();
  return getSpendCaps(db);
}

export function getRunCaps(db: Database): RunCaps {
  return {
    rootJobWallMs: readCount(db, KEY.rootJobWallMs, RUN_CAP_DEFAULTS.rootJobWallMs),
    maxConcurrentDelegations: readCount(db, KEY.maxConcurrentDelegations, RUN_CAP_DEFAULTS.maxConcurrentDelegations),
    maxSelfScheduledJobsPerBot: readCount(db, KEY.maxSelfScheduledJobsPerBot, RUN_CAP_DEFAULTS.maxSelfScheduledJobsPerBot),
  };
}

/** Change any of the run caps. Each must be a positive whole number. A bad value throws and changes nothing. */
export function setRunCaps(db: Database, caps: Partial<RunCaps>): RunCaps {
  for (const [name, value] of Object.entries(caps)) {
    if (!(typeof value === "number" && Number.isInteger(value) && value > 0)) {
      throw new Error(`run cap ${name} must be a positive whole number`);
    }
  }
  db.transaction(() => {
    for (const name of ["rootJobWallMs", "maxConcurrentDelegations", "maxSelfScheduledJobsPerBot"] as const) {
      const value = caps[name];
      if (value !== undefined) writeRaw(db, KEY[name], value);
    }
  })();
  return getRunCaps(db);
}

export interface SpendStatus {
  /** Local calendar day the numbers are for. */
  day: string;
  /** When the day's spend resets (next local midnight), ISO UTC. */
  resetsAt: string;
  timeZone: string;
  caps: SpendCaps;
  /** Priced spend across everything today. */
  daySpentUsd: number;
  /** Priced spend per bot today (bots that spent), with the per-bot cap each is held to. */
  bots: Array<{ agentID: string; spentUsd: number; capUsd: number | null }>;
  /** Calls today whose cost is unknown because the model has no price: they are not counted in any spend. */
  unpricedCalls: number;
}

/** Today's spend against the caps, for the `spend.status` frame. */
export function getSpendStatus(db: Database, options: { now?: Date; timeZone?: string } = {}): SpendStatus {
  const timeZone = options.timeZone ?? resolveTimeZone();
  const { day, startISO, endISO } = localDayBounds(options.now ?? new Date(), timeZone);
  const caps = getSpendCaps(db);
  return {
    day,
    resetsAt: endISO,
    timeZone,
    caps,
    daySpentUsd: spentSince(db, startISO),
    bots: spentByBotSince(db, startISO).map((bot) => ({ ...bot, capUsd: caps.perBotDayUsd })),
    unpricedCalls: unpricedCallsSince(db, startISO),
  };
}
