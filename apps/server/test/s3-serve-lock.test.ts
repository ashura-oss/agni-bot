/**
 * The lock a running `serve` holds in AGNI_HOME for its lifetime. `agni vault migrate` and `export`
 * read it to know a server has the database and credential files open, because the pid file is
 * written only by `daemon start` (a foreground or service-managed `serve` never writes it).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServeLockError, acquireServeLock, serveLockPath, serveLockState } from "../src/startup/s3-serve-lock";

let roots: string[] = [];
const fresh = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "agni-slock-"));
  roots.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  roots = [];
});

async function deadPid(): Promise<number> {
  const child = Bun.spawn([process.execPath, "-e", "0"], { stdout: "ignore", stderr: "ignore" });
  await child.exited;
  return child.pid;
}

const write = (home: string, content: string): void => {
  mkdirSync(home, { recursive: true });
  writeFileSync(serveLockPath(home), content);
};

describe("serveLockState", () => {
  test("no lock file: free", () => {
    expect(serveLockState({ home: fresh() })).toEqual({ state: "free" });
  });

  test("a lock naming a live process: held, with its pid", () => {
    const home = fresh();
    write(home, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    expect(serveLockState({ home })).toEqual({ state: "held", pid: process.pid });
  });

  test("a lock naming a dead process is stale: free", async () => {
    const home = fresh();
    write(home, JSON.stringify({ pid: await deadPid(), startedAt: new Date().toISOString() }));
    expect(serveLockState({ home })).toEqual({ state: "free" });
  });

  test("a lock written before this machine booted is stale even when its pid is alive again", () => {
    const home = fresh();
    write(home, JSON.stringify({ pid: process.pid, startedAt: new Date(Date.now() - 400 * 24 * 3600 * 1000).toISOString() }));
    expect(serveLockState({ home })).toEqual({ state: "free" });
  });

  test("a lock that cannot be parsed fails closed: unreadable, not free", () => {
    const home = fresh();
    write(home, "{not json");
    expect(serveLockState({ home }).state).toBe("unreadable");
  });

  test("a lock that cannot be read at all fails closed: unreadable, not free", () => {
    const home = fresh();
    mkdirSync(serveLockPath(home), { recursive: true }); // a directory where the file should be
    expect(serveLockState({ home }).state).toBe("unreadable");
  });
});

describe("acquireServeLock", () => {
  test("writes the lock, and release removes it", () => {
    const home = fresh();
    const lock = acquireServeLock({ home });
    expect(JSON.parse(readFileSync(serveLockPath(home), "utf8")).pid).toBe(process.pid);
    lock.release();
    expect(existsSync(serveLockPath(home))).toBe(false);
  });

  test("refuses while another live process holds it", async () => {
    const home = fresh();
    const other = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 60000)"], { stdout: "ignore", stderr: "ignore" });
    try {
      write(home, JSON.stringify({ pid: other.pid, startedAt: new Date().toISOString() }));
      expect(() => acquireServeLock({ home })).toThrow(ServeLockError);
      expect(JSON.parse(readFileSync(serveLockPath(home), "utf8")).pid).toBe(other.pid);
    } finally {
      other.kill();
      await other.exited;
    }
  });

  test("reclaims a stale lock whose process is gone", async () => {
    const home = fresh();
    write(home, JSON.stringify({ pid: await deadPid(), startedAt: new Date().toISOString() }));
    const lock = acquireServeLock({ home });
    expect(serveLockState({ home })).toEqual({ state: "held", pid: process.pid });
    lock.release();
  });

  test("release leaves a lock that another process has since taken over", async () => {
    const home = fresh();
    const lock = acquireServeLock({ home });
    write(home, JSON.stringify({ pid: await deadPid(), startedAt: new Date().toISOString() }));
    lock.release();
    expect(existsSync(serveLockPath(home))).toBe(true);
  });

  test("refuses, holding nothing, when the lock cannot be read", () => {
    const home = fresh();
    mkdirSync(serveLockPath(home), { recursive: true });
    expect(() => acquireServeLock({ home })).toThrow(ServeLockError);
  });
});
