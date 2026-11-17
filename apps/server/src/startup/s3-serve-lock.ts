/**
 * The lock a running `serve` holds in AGNI_HOME for as long as it runs.
 *
 * `agni vault migrate` and `agni vault export` rewrite the database and the credential files, and a
 * running server holds both open and keeps serving the old values from memory. The pid file cannot
 * tell them: only `daemon start` writes it, never a foreground `serve` or one a login service runs.
 * So `serve` takes this lock first thing, and the two commands refuse while it is held (and while
 * `/health` answers, as `daemon start` also checks).
 *
 * The lock is a file made with exclusive create (`wx`) that records the pid and start time:
 *   - released when `serve` exits (the `exit` event covers `process.exit` in the signal handlers);
 *   - stale when its pid is gone, or when it was written before this machine booted (a pid can be
 *     reused after a reboot), and a new `serve` takes a stale lock over;
 *   - never guessed: a lock that cannot be read or parsed is reported as unreadable, and the
 *     commands that would rewrite files treat that as held. Two `serve` processes that both find
 *     the same stale lock in the same instant are still stopped by the port (EADDRINUSE).
 */
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { uptime } from "node:os";
import { join } from "node:path";
import { agniHome } from "../home";
import { isProcessAlive } from "../daemon";

/** A lock older than the machine's boot (less this much, for clock adjustments) cannot belong to a live process. */
const BOOT_TOLERANCE_MS = 60_000;

export type ServeLockState =
  | { state: "free" }
  | { state: "held"; pid: number }
  /** The file is there but cannot be trusted: callers that rewrite files must treat it as held. */
  | { state: "unreadable"; reason: string; corrupt: boolean };

export class ServeLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServeLockError";
  }
}

export interface ServeLockOptions {
  home?: string;
}

export function serveLockPath(home: string = agniHome()): string {
  return join(home, "serve.lock");
}

/** What the lock file says right now. Read-only. */
export function serveLockState(options: ServeLockOptions = {}): ServeLockState {
  const path = serveLockPath(options.home);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "free" };
    return { state: "unreadable", reason: error instanceof Error ? error.message : String(error), corrupt: false };
  }
  let parsed: { pid?: unknown; startedAt?: unknown };
  try {
    parsed = JSON.parse(text) as { pid?: unknown; startedAt?: unknown };
  } catch {
    return { state: "unreadable", reason: "its contents are not valid JSON", corrupt: true };
  }
  const { pid, startedAt } = parsed;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || typeof startedAt !== "string" || Number.isNaN(Date.parse(startedAt))) {
    return { state: "unreadable", reason: "it does not name a process and a start time", corrupt: true };
  }
  if (Date.parse(startedAt) < Date.now() - uptime() * 1000 - BOOT_TOLERANCE_MS) return { state: "free" };
  return isProcessAlive(pid) ? { state: "held", pid } : { state: "free" };
}

export interface ServeLock {
  path: string;
  /** Remove the lock, if it is still this process's. Safe to call twice. */
  release(): void;
}

function ownedBy(path: string, pid: number): boolean {
  try {
    return (JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown }).pid === pid;
  } catch {
    return false;
  }
}

/**
 * Take the lock for this process, or throw `ServeLockError` (another server holds it, or the lock
 * cannot be read). A stale lock is taken over. Released automatically when the process exits.
 */
export function acquireServeLock(options: ServeLockOptions = {}): ServeLock {
  const path = serveLockPath(options.home);
  const pid = process.pid;
  const body = `${JSON.stringify({ pid, startedAt: new Date().toISOString() })}\n`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeSync(fd, body);
      } finally {
        closeSync(fd);
      }
      return handle(path, pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new ServeLockError(`the server lock ${path} could not be created: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const state = serveLockState(options);
    if (state.state === "held") {
      if (state.pid === pid) return handle(path, pid);
      throw new ServeLockError(`another Agni server (pid ${state.pid}) is running on this home (${path}). Stop it first, or use a different AGNI_HOME.`);
    }
    if (state.state === "unreadable" && !state.corrupt) {
      throw new ServeLockError(`the server lock ${path} cannot be read (${state.reason}), so Agni cannot tell whether a server is running. Check the file and its permissions.`);
    }
    // Stale (its process is gone) or a torn write: take it over and try again.
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new ServeLockError(`the stale server lock ${path} could not be removed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  throw new ServeLockError(`the server lock ${path} could not be taken after several tries; is another server starting on this home?`);
}

function handle(path: string, pid: number): ServeLock {
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    if (!ownedBy(path, pid)) return;
    try {
      unlinkSync(path);
    } catch {
      // Already gone: the only outcome wanted.
    }
  };
  process.once("exit", release);
  return { path, release };
}
