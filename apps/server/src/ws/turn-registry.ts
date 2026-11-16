/**
 * The turns running in this process, by turn ID.
 *
 * A turn belongs to the server, not to the connection that started it: it keeps
 * running when that socket closes (reload, phone lock, network blip), and any
 * authenticated connection may cancel it. So the abort controllers live here,
 * one server-wide map, instead of on each connection's session.
 */

import type { AbortReason } from "../agent/abort-reason";

interface RunningTurn {
  controller: AbortController;
  threadID: string;
  /** The paired device that started the turn; revoking it stops the turn. */
  deviceID: string | undefined;
}

const running = new Map<string, RunningTurn>();
const idleWaiters: Array<() => void> = [];

function notifyIfIdle(): void {
  if (running.size > 0) return;
  for (const resolve of idleWaiters.splice(0)) resolve();
}

/** Remember a turn's controller until the turn ends. */
export function registerTurn(turnID: string, threadID: string, controller: AbortController, deviceID?: string): void {
  running.set(turnID, { controller, threadID, deviceID });
}

/** Forget a finished turn. A no-op when the entry already belongs to someone else. */
export function unregisterTurn(turnID: string, controller: AbortController): void {
  if (running.get(turnID)?.controller === controller) running.delete(turnID);
  notifyIfIdle();
}

/** Abort a running turn from any connection; false when it is unknown or already over. */
export function cancelTurn(turnID: string, reason: AbortReason = "owner_stop"): boolean {
  const turn = running.get(turnID);
  if (!turn) return false;
  turn.controller.abort(reason);
  return true;
}

/** Abort every turn a device started (it was revoked or logged out); returns how many. */
export function cancelTurnsForDevice(deviceID: string): number {
  let cancelled = 0;
  for (const turn of running.values()) {
    if (turn.deviceID !== deviceID) continue;
    turn.controller.abort("device_revoked" satisfies AbortReason);
    cancelled += 1;
  }
  return cancelled;
}

/** The devices that have a turn running, so a sweep can check them against revocations. */
export function runningTurnDeviceIDs(): string[] {
  return [...new Set([...running.values()].flatMap((turn) => (turn.deviceID ? [turn.deviceID] : [])))];
}

/**
 * Databases whose server is stopping. A turn that finishes during shutdown must
 * not start the message queued behind it: that message stays on disk for the
 * next boot.
 */
const stopping = new WeakSet<object>();
export function markServerStopping(db: object): void { stopping.add(db); }
export function clearServerStopping(db: object): void { stopping.delete(db); }
export function isServerStopping(db: object): boolean { return stopping.has(db); }

/**
 * Abort every running turn. A server calls this when it stops: turns outlive
 * their sockets, so they must not outlive the server that would carry their
 * frames (they finish as `cancelled`, not as a row left `running`).
 */
export function cancelAllTurns(): number {
  const turns = [...running.values()];
  for (const turn of turns) turn.controller.abort("shutdown" satisfies AbortReason);
  return turns.length;
}

/**
 * Resolves once no turn is running (immediately when none is). A stopping
 * server awaits this after `cancelAllTurns`, so the cancelled turns finish
 * writing before anyone closes the database under them.
 */
export function whenNoTurnsRunning(timeoutMs = 3_000): Promise<void> {
  if (running.size === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    idleWaiters.push(() => { clearTimeout(timer); resolve(); });
  });
}

/** Is this turn still running in this process? */
export function isTurnRunning(turnID: string): boolean {
  return running.has(turnID);
}

/** The thread a running turn belongs to, when it is running. */
export function runningTurnThread(turnID: string): string | undefined {
  return running.get(turnID)?.threadID;
}

/** How many turns are registered (tests assert entries are cleaned up). */
export function runningTurnCount(): number {
  return running.size;
}
