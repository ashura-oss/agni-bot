import type { Database } from "bun:sqlite";
import { newID, nowISO, utcDay } from "../util/ids";

export interface UsageRecord {
  turnID?: string;
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
}

/**
 * Per-turn summary row (the old ledger). It carries no cost and no kind, so it
 * never counts toward spend. S2-1 removes the one caller (task-loop) once the
 * per-call ledger below is the only record.
 */
export function recordUsage(db: Database, record: UsageRecord): void {
  db.run(
    "INSERT INTO usage_ledger (id, turn_id, provider, model, input_tokens, output_tokens, latency_ms, day, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      newID("use"),
      record.turnID ?? null,
      record.provider,
      record.model,
      record.inputTokens ?? 0,
      record.outputTokens ?? 0,
      record.latencyMs ?? null,
      utcDay(),
      nowISO(),
    ],
  );
}

export interface DayTotals {
  turns: number;
  inputTokens: number;
  outputTokens: number;
}

export function dayTotals(db: Database, day = utcDay()): DayTotals {
  const row = db
    .query<{ turns: number; input_tokens: number | null; output_tokens: number | null }, [string]>(
      `SELECT COUNT(*) AS turns, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens
       FROM usage_ledger WHERE day = ?`,
    )
    .get(day);
  return {
    turns: row?.turns ?? 0,
    inputTokens: row?.input_tokens ?? 0,
    outputTokens: row?.output_tokens ?? 0,
  };
}

/** One model call, as the ledger records it (S2-10). `costUsd` null means the cost is unknown, never zero. */
export interface LedgerCall {
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  latencyMs?: number;
  costUsd: number | null;
  agentID?: string;
  jobID?: string;
  rootJobID?: string;
  kind: "turn" | "side";
  purpose?: string;
}

/** Write one ledger row for one model call. A job with no parent is its own root. */
export function recordLedgerCall(db: Database, call: LedgerCall): void {
  db.run(
    `INSERT INTO usage_ledger
       (id, provider, model, input_tokens, output_tokens, cached_input_tokens, latency_ms, day, created_at,
        cost_usd, agent_id, job_id, root_job_id, call_kind, purpose)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newID("use"),
      call.provider,
      call.model,
      call.inputTokens ?? 0,
      call.outputTokens ?? 0,
      call.cachedInputTokens ?? 0,
      call.latencyMs ?? null,
      utcDay(),
      nowISO(),
      call.costUsd,
      call.agentID ?? null,
      call.jobID ?? null,
      call.rootJobID ?? call.jobID ?? null,
      call.kind,
      call.purpose ?? null,
    ],
  );
}

export interface LocalDay {
  /** Calendar day in the zone, YYYY-MM-DD. */
  day: string;
  /** Local midnight that starts the day, as a UTC ISO instant. */
  startISO: string;
  /** Local midnight that ends it (the next reset). */
  endISO: string;
}

/**
 * Where "today" starts and ends in an IANA time zone. Spend caps reset at local
 * midnight, so the ledger is summed over [startISO, endISO) rather than by the
 * UTC `day` column. Handles zones whose day is 23 or 25 hours long.
 */
export function localDayBounds(now: Date, timeZone: string): LocalDay {
  const day = localDate(now, timeZone);
  const next = new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)) + 1));
  return {
    day,
    startISO: localMidnight(day, timeZone).toISOString(),
    endISO: localMidnight(next.toISOString().slice(0, 10), timeZone).toISOString(),
  };
}

function localDate(instant: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}

/** Offset of `timeZone` from UTC at an instant, in ms (positive east of Greenwich). */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
  const asUTC = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUTC - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The UTC instant at which the local calendar day `ymd` begins in `timeZone`. */
function localMidnight(ymd: string, timeZone: string): Date {
  const wall = Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)));
  // Two passes: the offset at the guess may differ from the offset at the answer across a clock change.
  let guess = wall - zoneOffsetMs(new Date(wall), timeZone);
  guess = wall - zoneOffsetMs(new Date(guess), timeZone);
  return new Date(guess);
}

export interface SpendFilter {
  agentID?: string;
  /** A root job: every call made for it and everything it delegated. */
  rootJobID?: string;
}

/** Dollars spent by priced calls from `sinceISO` on (calls of unknown cost add nothing here). */
export function spentSince(db: Database, sinceISO: string, filter: SpendFilter = {}): number {
  const where = ["created_at >= ?"];
  const params: string[] = [sinceISO];
  if (filter.agentID !== undefined) { where.push("agent_id = ?"); params.push(filter.agentID); }
  if (filter.rootJobID !== undefined) { where.push("root_job_id = ?"); params.push(filter.rootJobID); }
  const row = db
    .query<{ spent: number | null }, string[]>(`SELECT SUM(cost_usd) AS spent FROM usage_ledger WHERE ${where.join(" AND ")}`)
    .get(...params);
  return row?.spent ?? 0;
}

/** Spend per bot since `sinceISO`, biggest first. Calls with no bot are not listed. */
export function spentByBotSince(db: Database, sinceISO: string): Array<{ agentID: string; spentUsd: number }> {
  return db
    .query<{ agent_id: string; spent: number | null }, [string]>(
      `SELECT agent_id, SUM(cost_usd) AS spent FROM usage_ledger
       WHERE created_at >= ? AND agent_id IS NOT NULL GROUP BY agent_id ORDER BY spent DESC, agent_id`,
    )
    .all(sinceISO)
    .map((row) => ({ agentID: row.agent_id, spentUsd: row.spent ?? 0 }));
}

/** Calls recorded by the per-call ledger since `sinceISO` whose cost is unknown (no price for the model). */
export function unpricedCallsSince(db: Database, sinceISO: string): number {
  return db
    .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM usage_ledger WHERE created_at >= ? AND call_kind IS NOT NULL AND cost_usd IS NULL")
    .get(sinceISO)?.n ?? 0;
}
