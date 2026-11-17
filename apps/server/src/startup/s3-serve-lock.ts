/**
 * The lock a running `serve` holds in AGNI_HOME for as long as it runs.
 *
 * `agni vault migrate` and `agni vault export` rewrite the database and the credential files, and a
 * running server holds both open and keeps serving the old values from memory. The pid file cannot
 * tell them: only `daemon start` writes it, never a foreground `serve` or one a login service runs.
 * So `serve` takes this lock first thing, and the two commands refuse while it is held (and while
 * `/health` answers, as `daemon start` also checks). The two commands take the same lock themselves
 * once their checks pass and hold it until they finish, so a `serve` started meanwhile is refused.
 *
 * The lock is a file made with exclusive create (`wx`) that records the pid, a random token, and the
 * time it was taken; `serve` adds where it listens once it is listening (`recordEndpoint`):
 *   - released when `serve` exits (the `exit` event covers `process.exit` in the signal handlers), and
 *     only if the file still carries this handle's token, so a process never removes a lock another
 *     one took over (a `serve` that loses the port race must not remove the winner's);
 *   - stale when its pid is gone. A live pid always counts as held, whatever the lock's age: a clock
 *     jump or a long uptime must not free a lock a server holds. A pid that was reused after a hard
 *     kill is handled by `daemon stop` (it removes the lock once the process is gone) and by `serve`
 *     alone (`s3-serve-start.ts`: nothing listens where the lock says the server does); the commands
 *     that rewrite files stay fail closed and say which file to delete;
 *   - never guessed: a lock that cannot be read or parsed is reported as unreadable, and the
 *     commands that would rewrite files treat that as held. The one exception is a file a server is
 *     in the middle of writing (empty or cut short, written a moment ago): that is `starting`, and
 *     refuses like a held lock instead of being taken over while it is being written.
 *   Two `serve` processes that both find the same stale lock in the same instant are still stopped by
 *   the port (EADDRINUSE); a takeover removes the stale file only if it is still the file that was read, by renaming it
 *   to a name of its own first (see `removeServeLockIfUnchanged`), so two takeovers cannot both delete it.
 */
import { randomUUID } from "node:crypto";
import { closeSync, linkSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { agniHome } from "../home";
import { isProcessAlive } from "../util/process-alive";

/** A lock file that cannot be read as a lock but was written this recently is a server writing it, not a crash. */
const STARTING_GRACE_MS = 5_000;

/** Who holds the lock, and where it listens once it does. */
export interface ServeLockHolder {
  pid: number;
  token?: string;
  host?: string;
  port?: number;
}

export type ServeLockState =
  | { state: "free" }
  | ({ state: "held" } & ServeLockHolder)
  /** The file is there but is empty or cut short, and was written a moment ago: a server is taking the lock right now. */
  | { state: "starting" }
  /** The file is there but cannot be trusted: callers that rewrite files must treat it as held. */
  | { state: "unreadable"; reason: string; corrupt: boolean };

export class ServeLockError extends Error {
  /** The lock's holder, when a live process holds it (what `serve` needs to tell a reused pid from a running server). */
  readonly holder?: ServeLockHolder & { raw: string };

  constructor(message: string, holder?: ServeLockHolder & { raw: string }) {
    super(message);
    this.name = "ServeLockError";
    if (holder) this.holder = holder;
  }
}

export interface ServeLockOptions {
  home?: string;
}

export function serveLockPath(home: string = agniHome()): string {
  return join(home, "serve.lock");
}

/** The words every refusal ends with: a lock whose server is long gone is the one thing a person must clear by hand. */
const clearHint = (path: string): string => `Stop it first, use a different AGNI_HOME, or delete ${path} if no Agni server is running.`;

interface Reading {
  state: ServeLockState;
  /** The file's text, when it could be read: a takeover removes the file only if it still says this. */
  raw?: string;
}

function readLock(path: string): Reading {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: { state: "free" } };
    return { state: { state: "unreadable", reason: error instanceof Error ? error.message : String(error), corrupt: false } };
  }
  const untrusted = (reason: string): Reading => {
    let young = false;
    try {
      young = Date.now() - statSync(path).mtimeMs < STARTING_GRACE_MS;
    } catch {
      // Gone since it was read: reported as the corrupt file that was read.
    }
    return { state: young ? { state: "starting" } : { state: "unreadable", reason, corrupt: true }, raw: text };
  };
  let parsed: { pid?: unknown; startedAt?: unknown; token?: unknown; host?: unknown; port?: unknown };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return untrusted(text.trim() === "" ? "it is empty" : "its contents are not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object") return untrusted("it does not name a process and a start time");
  const { pid, startedAt, token, host, port } = parsed;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || typeof startedAt !== "string" || Number.isNaN(Date.parse(startedAt))) {
    return untrusted("it does not name a process and a start time");
  }
  if (!isProcessAlive(pid)) return { state: { state: "free" }, raw: text };
  return {
    state: {
      state: "held",
      pid,
      ...(typeof token === "string" ? { token } : {}),
      ...(typeof host === "string" ? { host } : {}),
      ...(typeof port === "number" && Number.isInteger(port) && port > 0 && port < 65_536 ? { port } : {}),
    },
    raw: text,
  };
}

/** What the lock file says right now. Read-only. */
export function serveLockState(options: ServeLockOptions = {}): ServeLockState {
  return readLock(serveLockPath(options.home)).state;
}

export interface ServeLock {
  path: string;
  /** Remove the lock, if it is still this handle's (same token). Safe to call twice. */
  release(): void;
  /** Say where this server listens, once it is listening: one atomic replace of the lock file. Best effort. */
  recordEndpoint(host: string, port: number): void;
}

function ownedBy(path: string, pid: number, token: string | undefined): boolean {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown; token?: unknown };
    return parsed.pid === pid && parsed.token === token;
  } catch {
    return false;
  }
}

/**
 * Remove the lock file only if it is still the one that was read (it says `raw`). Reading and then deleting is not safe:
 * between the two a faster process can delete the file and create its own lock, and the delete would then take that one.
 * So the file is first renamed to a name of its own (one process's rename takes it, any other finds nothing), the renamed
 * file is checked against `raw`, and only then deleted. A file that is not the one that was judged is put back, unless
 * a newer lock already has the name: then that one stays and the renamed file is dropped. True when the lock was removed.
 */
export function removeServeLockIfUnchanged(path: string, raw: string): boolean {
  const aside = `${path}.${randomUUID()}.removing`;
  try {
    renameSync(path, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  let text: string | undefined;
  try {
    text = readFileSync(aside, "utf8");
  } catch {
    // Unreadable: not provably the lock that was judged, so it is put back below.
  }
  if (text === raw) {
    try {
      unlinkSync(aside);
    } catch {
      // The lock's own name is already free, which is the outcome wanted; a leftover side file is harmless.
    }
    return true;
  }
  try {
    // A hard link refuses to replace a lock that was created in the meantime; a rename would overwrite it.
    linkSync(aside, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      try {
        renameSync(aside, path);
      } catch {
        throw new Error(`the server lock ${path} was set aside as ${aside} and could not be put back; rename it back if no other Agni server is running`);
      }
      return false;
    }
  }
  try {
    unlinkSync(aside);
  } catch {
    // Put back already; only the side copy is left.
  }
  return false;
}

/**
 * Remove the lock if it names `pid`, whatever its token: for the command that ended that process (`daemon stop`), after
 * which the lock cannot be anyone's. A lock that names another pid is a newer server's and is left. True when removed.
 */
export function removeServeLockOf(pid: number, options: ServeLockOptions = {}): boolean {
  const path = serveLockPath(options.home);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
    if ((JSON.parse(raw) as { pid?: unknown }).pid !== pid) return false;
  } catch {
    return false;
  }
  return removeServeLockIfUnchanged(path, raw);
}

const heldMessage = (path: string, pid: number): string => `another Agni server (pid ${pid}) is running on this home (${path}). ${clearHint(path)}`;

/**
 * Take the lock for this process, or throw `ServeLockError` (another server holds it, one is starting, or the lock
 * cannot be read). A stale lock is taken over. Released automatically when the process exits.
 */
export function acquireServeLock(options: ServeLockOptions = {}): ServeLock {
  const path = serveLockPath(options.home);
  const pid = process.pid;
  const token = randomUUID();
  const body = `${JSON.stringify({ pid, startedAt: new Date().toISOString(), token })}\n`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeSync(fd, body);
      } finally {
        closeSync(fd);
      }
      return handle(path, pid, token);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new ServeLockError(`the server lock ${path} could not be created: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const { state, raw } = readLock(path);
    if (state.state === "held") {
      if (state.pid === pid) return handle(path, pid, state.token);
      throw new ServeLockError(heldMessage(path, state.pid), { ...state, raw: raw ?? "" });
    }
    if (state.state === "starting") {
      throw new ServeLockError(`another Agni server is starting on this home (${path}). Wait a moment and try again, or delete ${path} if no Agni server is running.`);
    }
    if (state.state === "unreadable" && !state.corrupt) {
      throw new ServeLockError(`the server lock ${path} cannot be read (${state.reason}), so Agni cannot tell whether a server is running. Check the file and its permissions.`);
    }
    // Stale (its process is gone) or a torn write left long ago: take it over, but only the file that was read.
    if (raw !== undefined) {
      try {
        removeServeLockIfUnchanged(path, raw);
      } catch (error) {
        throw new ServeLockError(`the stale server lock ${path} could not be removed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  throw new ServeLockError(`the server lock ${path} could not be taken after several tries; is another server starting on this home?`);
}

/** Wait without a timer: the writers here are synchronous, and a few milliseconds is all a reader holds the file open. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function handle(path: string, pid: number, token: string | undefined): ServeLock {
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    process.removeListener("exit", release);
    if (!ownedBy(path, pid, token)) return;
    try {
      unlinkSync(path);
    } catch {
      // Already gone: the only outcome wanted.
    }
  };
  const recordEndpoint = (host: string, port: number): void => {
    if (released || !ownedBy(path, pid, token)) return;
    let current: Record<string, unknown>;
    try {
      current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      return;
    }
    const temporary = `${path}.${token ?? pid}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify({ ...current, host, port })}\n`, { mode: 0o600 });
      // A reader holding the old file open for a moment makes the replace fail on Windows: try again briefly.
      for (let attempt = 0; ; attempt++) {
        try {
          renameSync(temporary, path);
          return;
        } catch (error) {
          if (attempt >= 4) throw error;
          pause(25);
        }
      }
    } catch {
      // Best effort: a lock with no address is still a lock (it only cannot be told from a reused pid by `serve`).
      try {
        unlinkSync(temporary);
      } catch {
        // Nothing to remove.
      }
    }
  };
  process.once("exit", release);
  return { path, release, recordEndpoint };
}
