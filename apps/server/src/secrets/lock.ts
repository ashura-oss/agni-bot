/**
 * A cross-process write lock for `vault.bin`: a sibling file created with
 * "exclusive" mode, so two processes (the daemon and a CLI command) cannot
 * both read-modify-write the vault at once. The file records the holder's pid.
 *
 * A lock is stale, and removed, when
 *  - its recorded pid is not a running process (the writer crashed): at once;
 *  - or it is older than 30 seconds, whatever it says (the writes it guards
 *    take milliseconds; this covers a writer that died before recording its
 *    pid, and a dead writer's pid that the system has given to another process).
 */
import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { VaultError } from "./types";

const STALE_MS = 30_000;
const WAIT_MS = 5_000;

export interface LockOptions {
  /** How long to wait for a live holder. Default 5 s. */
  waitMs?: number;
  /** Age after which any lock is taken over. Default 30 s. */
  staleMs?: number;
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The pid a lock file records, or `undefined` when it is empty, partial or not ours. */
function recordedPid(text: string): number | undefined {
  try {
    const pid = (JSON.parse(text) as { pid?: unknown }).pid;
    return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Remove the lock if it is stale. True when it is gone (removed, or released meanwhile). */
function clearIfStale(lockPath: string, staleMs: number): boolean {
  let text: string;
  try {
    text = readFileSync(lockPath, "utf8");
  } catch {
    return true; // released between the two calls
  }
  const pid = recordedPid(text);
  const stale = (pid !== undefined && !pidAlive(pid)) || Date.now() - statSync(lockPath).mtimeMs > staleMs;
  if (!stale) return false;
  try {
    // Only the lock we judged: if another process replaced it since, leave it.
    if (readFileSync(lockPath, "utf8") === text) rmSync(lockPath, { force: true });
  } catch {
    // gone already
  }
  return true;
}

/** Take the lock, run `fn`, release it. */
export function withFileLock<T>(lockPath: string, fn: () => T, options: LockOptions = {}): T {
  const waitMs = options.waitMs ?? WAIT_MS;
  const staleMs = options.staleMs ?? STALE_MS;
  const started = Date.now();
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      } finally {
        closeSync(fd);
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new VaultError("WRITE_FAILED", `Could not create the vault lock file (${(error as Error).message}).`, { cause: error });
      }
      try {
        if (clearIfStale(lockPath, staleMs)) continue;
      } catch {
        continue; // released between the two calls
      }
      if (Date.now() - started > waitMs) {
        throw new VaultError("LOCK_TIMEOUT", "Another Agni process is writing the vault and did not finish. Try again in a moment.");
      }
      sleep(20);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockPath, { force: true });
  }
}
