/**
 * A cross-process write lock for `vault.bin`: a sibling file created with
 * "exclusive" mode, so two processes (the daemon and a CLI command) cannot
 * both read-modify-write the vault at once. A lock older than 30 seconds is
 * a crashed writer's and is removed.
 */
import { closeSync, openSync, rmSync, statSync, writeSync } from "node:fs";
import { VaultError } from "./types";

const STALE_MS = 30_000;
const WAIT_MS = 5_000;

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Take the lock, run `fn`, release it. */
export function withFileLock<T>(lockPath: string, fn: () => T): T {
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
        if (Date.now() - statSync(lockPath).mtimeMs > STALE_MS) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        continue; // released between the two calls
      }
      if (Date.now() - started > WAIT_MS) {
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
