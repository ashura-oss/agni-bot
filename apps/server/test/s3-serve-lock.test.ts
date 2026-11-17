/**
 * The lock a running `serve` holds in AGNI_HOME for its lifetime. `agni vault migrate` and `export`
 * read it to know a server has the database and credential files open, because the pid file is
 * written only by `daemon start` (a foreground or service-managed `serve` never writes it).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServeLockError, acquireServeLock, removeServeLockOf, serveLockPath, serveLockState } from "../src/startup/s3-serve-lock";

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

  test("a lock written before this machine booted is still held while its pid is alive (a clock jump or a long uptime must not free it)", () => {
    const home = fresh();
    write(home, JSON.stringify({ pid: process.pid, startedAt: new Date(Date.now() - 400 * 24 * 3600 * 1000).toISOString() }));
    expect(serveLockState({ home })).toEqual({ state: "held", pid: process.pid });
  });

  test("a lock that names where its server listens reports it", () => {
    const home = fresh();
    write(home, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token: "t1", host: "127.0.0.1", port: 8787 }));
    expect(serveLockState({ home })).toEqual({ state: "held", pid: process.pid, token: "t1", host: "127.0.0.1", port: 8787 });
  });

  test("an empty lock file written a moment ago is a server in the middle of taking it: starting, not corrupt", () => {
    const home = fresh();
    write(home, "");
    expect(serveLockState({ home })).toEqual({ state: "starting" });
  });

  test("a half-written lock written a moment ago is starting too", () => {
    const home = fresh();
    write(home, '{"pid": 12');
    expect(serveLockState({ home })).toEqual({ state: "starting" });
  });

  test("an empty lock that has sat there for a while is corrupt (a crash mid-write), not starting", () => {
    const home = fresh();
    write(home, "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(serveLockPath(home), old, old);
    expect(serveLockState({ home }).state).toBe("unreadable");
  });

  test("a lock that cannot be parsed fails closed: never free (starting while it is fresh, unreadable once it has sat)", () => {
    const home = fresh();
    write(home, "{not json");
    expect(serveLockState({ home }).state).toBe("starting");
    const old = new Date(Date.now() - 60_000);
    utimesSync(serveLockPath(home), old, old);
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
    expect(serveLockState({ home })).toEqual(expect.objectContaining({ state: "held", pid: process.pid }));
    lock.release();
  });

  test("the lock carries a random token, and release removes only a lock with that token", () => {
    const home = fresh();
    const lock = acquireServeLock({ home });
    const mine = JSON.parse(readFileSync(serveLockPath(home), "utf8")) as { pid: number; token: string };
    expect(mine.token).toMatch(/^[0-9a-f-]{16,}$/);
    // The same pid but not the same token: a lock this handle did not write (a server that took over, and lost the port).
    write(home, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token: "someone-else" }));
    lock.release();
    expect(JSON.parse(readFileSync(serveLockPath(home), "utf8")).token).toBe("someone-else");
  });

  test("each acquire gets its own token", () => {
    const first = fresh();
    const second = fresh();
    const a = acquireServeLock({ home: first });
    const b = acquireServeLock({ home: second });
    expect(JSON.parse(readFileSync(serveLockPath(first), "utf8")).token).not.toBe(JSON.parse(readFileSync(serveLockPath(second), "utf8")).token);
    a.release();
    b.release();
  });

  test("a lock that is torn but old is taken over; a fresh empty one is not (a server is writing it)", () => {
    const home = fresh();
    write(home, "");
    expect(() => acquireServeLock({ home })).toThrow(ServeLockError);
    expect(readFileSync(serveLockPath(home), "utf8")).toBe(""); // left alone
    const old = new Date(Date.now() - 60_000);
    utimesSync(serveLockPath(home), old, old);
    const lock = acquireServeLock({ home });
    expect(serveLockState({ home })).toEqual(expect.objectContaining({ state: "held", pid: process.pid }));
    lock.release();
  });

  test("recordEndpoint adds where the server listens, in one atomic replace (no temp file left, same token)", () => {
    const home = fresh();
    const lock = acquireServeLock({ home });
    const before = JSON.parse(readFileSync(serveLockPath(home), "utf8")) as { token: string };
    lock.recordEndpoint("127.0.0.1", 4321);
    expect(serveLockState({ home })).toEqual({ state: "held", pid: process.pid, token: before.token, host: "127.0.0.1", port: 4321 });
    expect(readdirSync(home)).toEqual(["serve.lock"]);
    lock.release();
    expect(existsSync(serveLockPath(home))).toBe(false);
  });

  test("recordEndpoint does not write into a lock that is not this handle's", () => {
    const home = fresh();
    const lock = acquireServeLock({ home });
    write(home, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token: "someone-else" }));
    lock.recordEndpoint("127.0.0.1", 4321);
    const after = JSON.parse(readFileSync(serveLockPath(home), "utf8"));
    expect(after.token).toBe("someone-else");
    expect(after.port).toBeUndefined();
  });

  test("removeServeLockOf removes the lock only when it names that pid", async () => {
    const home = fresh();
    const dead = await deadPid();
    write(home, JSON.stringify({ pid: dead, startedAt: new Date().toISOString(), token: "t" }));
    expect(removeServeLockOf(process.pid, { home })).toBe(false);
    expect(existsSync(serveLockPath(home))).toBe(true);
    expect(removeServeLockOf(dead, { home })).toBe(true);
    expect(existsSync(serveLockPath(home))).toBe(false);
    expect(removeServeLockOf(dead, { home })).toBe(false); // nothing left
  });

  test("release leaves a lock that another process has since taken over", async () => {
    const home = fresh();
    const lock = acquireServeLock({ home });
    write(home, JSON.stringify({ pid: await deadPid(), startedAt: new Date().toISOString() }));
    lock.release();
    expect(existsSync(serveLockPath(home))).toBe(true);
  });

  test("the refusal names the lock file and says to delete it when no server is running", async () => {
    const home = fresh();
    const other = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 60000)"], { stdout: "ignore", stderr: "ignore" });
    try {
      write(home, JSON.stringify({ pid: other.pid, startedAt: new Date().toISOString(), token: "theirs", host: "127.0.0.1", port: 8787 }));
      let error: unknown;
      try {
        acquireServeLock({ home });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ServeLockError);
      const message = (error as ServeLockError).message;
      expect(message).toContain(String(other.pid));
      expect(message).toContain(`delete ${serveLockPath(home)} if no Agni server is running`);
      expect((error as ServeLockError).holder).toMatchObject({ pid: other.pid, host: "127.0.0.1", port: 8787 });
    } finally {
      other.kill();
      await other.exited;
    }
  });

  test("refuses, holding nothing, when the lock cannot be read", () => {
    const home = fresh();
    mkdirSync(serveLockPath(home), { recursive: true });
    expect(() => acquireServeLock({ home })).toThrow(ServeLockError);
  });
});
