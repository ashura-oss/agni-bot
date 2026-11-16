/**
 * S3-01 review fix 4: a lock whose recorded process is gone is stale at once,
 * not after 30 seconds. A lock held by a live process still blocks.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "../src/secrets/lock";
import { VaultError } from "../src/secrets";

let roots: string[] = [];
const fresh = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "agni-vlock-"));
  roots.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  roots = [];
});

/** The pid of a process that has just exited. */
async function deadPid(): Promise<number> {
  const child = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
  await child.exited;
  return child.pid;
}

describe("withFileLock", () => {
  test("takes a free lock, runs, and releases it", () => {
    const lock = join(fresh(), "vault.bin.lock");
    expect(withFileLock(lock, () => existsSync(lock))).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  test("a lock left by a process that no longer exists is taken over immediately", async () => {
    const lock = join(fresh(), "vault.bin.lock");
    writeFileSync(lock, JSON.stringify({ pid: await deadPid(), at: Date.now() })); // fresh mtime: the 30 s rule would not apply
    const started = Date.now();
    expect(withFileLock(lock, () => "ran")).toBe("ran");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(existsSync(lock)).toBe(false);
  });

  test("a lock held by a live process still blocks, then times out with a clear error", () => {
    const lock = join(fresh(), "vault.bin.lock");
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
    let error: unknown;
    try {
      withFileLock(lock, () => "must not run", { waitMs: 150 });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(VaultError);
    expect((error as VaultError).code).toBe("LOCK_TIMEOUT");
    expect(existsSync(lock)).toBe(true); // not stolen from the live holder
  });

  test("a lock older than the stale age is taken over even if its pid is alive (a reused pid)", () => {
    const lock = join(fresh(), "vault.bin.lock");
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
    expect(withFileLock(lock, () => "ran", { waitMs: 100, staleMs: -1 })).toBe("ran");
  });

  test("a lock whose contents cannot be read is judged by its age, as before", () => {
    const lock = join(fresh(), "vault.bin.lock");
    writeFileSync(lock, "not json");
    expect(() => withFileLock(lock, () => "x", { waitMs: 100 })).toThrow(VaultError); // fresh and unreadable: wait
    expect(withFileLock(lock, () => "x", { waitMs: 100, staleMs: -1 })).toBe("x"); // old enough: taken over
  });
});
