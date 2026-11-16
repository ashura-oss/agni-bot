/**
 * Pause-all and per-bot off (S2-13).
 *
 * `isRunPaused` is the one question the policy engine asks at step boundaries
 * and at delegation: may this bot's work go on? The state is in the database
 * (migration 59), so `agni pause` in another process works on a running daemon.
 * Reads come from a short-lived in-memory copy, so the check costs microseconds
 * and never a model call; a change made through this process shows at once.
 *
 * Pause-all and per-bot off are separate: resuming all does not turn on a bot
 * that was off. Turning something off never waits on the audit log (an
 * emergency stop must work); turning it back on records first and fails
 * closed.
 */
import type { Database } from "bun:sqlite";
import { audit } from "./audit-sink";
import { log } from "../log";

export interface PauseVerdict {
  paused: boolean;
  /** Why, in words the model may read. Absent when not paused. */
  reason?: string;
  /** What stopped it: everything (pause-all) or this one bot (turned off). Absent when not paused. */
  scope?: "all" | "agent";
}

export interface PauseActor {
  /** Who made the change: a device id, "cli" or "owner". */
  actor: string;
}

export interface PauseState {
  paused: boolean;
  changedAt: string | null;
  changedBy: string | null;
}

export interface BotState {
  agentID: string;
  name: string;
  enabled: boolean;
}

const DEFAULT_CACHE_MS = 250;

interface Snapshot {
  at: number;
  paused: boolean;
  off: Map<string, string>;
}

let bound: { db: Database; cacheMs: number } | null = null;
let snapshot: Snapshot | null = null;

/** Point the check at a database. Replaces any earlier binding and drops the cached copy. */
export function bindPauseStore(db: Database, options: { cacheMs?: number } = {}): void {
  bound = { db, cacheMs: options.cacheMs ?? DEFAULT_CACHE_MS };
  snapshot = null;
}

/** Forget the database (tests; a server shutting down). With none bound nothing is paused. */
export function unbindPauseStore(): void {
  bound = null;
  snapshot = null;
}

function cleanName(name: string): string {
  const flat = name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > 64 ? `${flat.slice(0, 63)}…` : flat;
}

function load(db: Database): Snapshot {
  const paused = db.query<{ paused: number }, []>("SELECT paused FROM pause_state WHERE id = 1").get()?.paused === 1;
  const off = new Map<string, string>();
  for (const row of db.query<{ id: string; name: string | null }, []>("SELECT id, COALESCE(display_name, name) AS name FROM agents WHERE disabled = 1").all()) {
    off.set(row.id, cleanName(row.name ?? row.id) || row.id);
  }
  return { at: Date.now(), paused, off };
}

function current(): Snapshot | null {
  if (!bound) return null;
  if (!snapshot || Date.now() - snapshot.at >= bound.cacheMs) {
    try {
      snapshot = load(bound.db);
    } catch (error) {
      // A closed or locked database must not make every tool call throw. Keep the last known state.
      log.warn("pause: could not read the pause state", error);
      return snapshot;
    }
  }
  return snapshot;
}

/** May this bot's work go on? `agentID` null or unknown only checks pause-all. */
export function isRunPaused(run: { agentID?: string | null }): PauseVerdict {
  const state = current();
  if (!state) return { paused: false };
  if (state.paused) {
    return { paused: true, reason: "The owner paused all bots. Do not retry; nothing new starts until the owner resumes them.", scope: "all" };
  }
  const name = run.agentID ? state.off.get(run.agentID) : undefined;
  if (name !== undefined) {
    return { paused: true, reason: `${name} is turned off by the owner. Do not retry. Tell the owner if this task needs ${name}.`, scope: "agent" };
  }
  return { paused: false };
}

export function readPauseState(db: Database): PauseState {
  const row = db.query<{ paused: number; changed_at: string | null; changed_by: string | null }, []>("SELECT paused, changed_at, changed_by FROM pause_state WHERE id = 1").get();
  return { paused: row?.paused === 1, changedAt: row?.changed_at ?? null, changedBy: row?.changed_by ?? null };
}

export function listBotStates(db: Database): BotState[] {
  return db
    .query<{ id: string; name: string | null; disabled: number }, []>("SELECT id, COALESCE(display_name, name) AS name, disabled FROM agents ORDER BY created_at, id")
    .all()
    .map((row) => ({ agentID: row.id, name: cleanName(row.name ?? row.id) || row.id, enabled: row.disabled === 0 }));
}

/** Record an audit row for a change. `stop` changes never fail on the log; widening ones do. */
function recordChange(stop: boolean, event: Parameters<typeof audit>[0]): void {
  if (!stop) return audit(event);
  try {
    audit(event);
  } catch (error) {
    log.warn("pause: audit record failed for a stop; the stop stands", error);
  }
}

function touched(db: Database): void {
  if (bound?.db === db) snapshot = null;
}

/** Pause or resume every bot. Returns whether anything changed. */
export function setAllPaused(db: Database, paused: boolean, who: PauseActor): boolean {
  if (readPauseState(db).paused === paused) return false;
  const event = { kind: "pause.set", actor: who.actor, detail: { paused } };
  if (!paused) recordChange(false, event);
  db.run("UPDATE pause_state SET paused = ?, changed_at = ?, changed_by = ? WHERE id = 1", [paused ? 1 : 0, new Date().toISOString(), who.actor]);
  touched(db);
  if (paused) recordChange(true, event);
  return true;
}

/** Turn one bot off or on. False when there is no such bot or it already has that state. */
export function setAgentEnabled(db: Database, agentID: string, enabled: boolean, who: PauseActor): boolean {
  const row = db.query<{ disabled: number }, [string]>("SELECT disabled FROM agents WHERE id = ?").get(agentID);
  if (!row || (row.disabled === 0) === enabled) return false;
  const event = { kind: "agent.enabled", actor: who.actor, detail: { agentID, enabled } };
  if (enabled) recordChange(false, event);
  db.run("UPDATE agents SET disabled = ?, updated_at = ? WHERE id = ?", [enabled ? 0 : 1, new Date().toISOString(), agentID]);
  touched(db);
  if (!enabled) recordChange(true, event);
  return true;
}
