/**
 * Two `serve` processes that find the same stale lock in the same instant: at most one takes the lock, and the lock
 * file that is left is the winner's. The stale file removal must not be a read followed by a delete, because a process
 * that reads it, loses the race to a faster one that deletes it and creates its own, would then delete the new lock.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeServeLockIfUnchanged, serveLockPath } from "../src/startup/s3-serve-lock";

let roots: string[] = [];
const fresh = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "agni-sltake-"));
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

const waitUntil = async (what: string, ready: () => boolean): Promise<void> => {
  const deadline = Date.now() + 20_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(1);
  }
};

test("two takeovers of one stale lock at the same instant: at most one wins, and the lock file is the winner's", async () => {
  const home = fresh();
  const rounds = 40;
  const stalePid = await deadPid();
  const children = ["a", "b"].map((id) =>
    Bun.spawn([process.execPath, resolve(import.meta.dir, "s3-serve-lock-takeover-child.ts"), resolve(import.meta.dir, "../src/startup/s3-serve-lock.ts"), home, String(rounds), id], {
      stdout: "inherit",
      stderr: "inherit",
    }),
  );
  try {
    await waitUntil("both children to start", () => existsSync(join(home, "ready-a")) && existsSync(join(home, "ready-b")));
    const violations: string[] = [];
    let wins = 0;
    for (let round = 0; round < rounds; round++) {
      // A big stale file: the longer the read-and-compare of a removal takes, the wider the window the old code left open.
      writeFileSync(serveLockPath(home), `${JSON.stringify({ pid: stalePid, startedAt: new Date().toISOString(), token: "stale", pad: "x".repeat(6_000_000) })}\n`);
      writeFileSync(join(home, `go-${round}`), "1");
      await waitUntil("both results", () => existsSync(join(home, `res-${round}-a`)) && existsSync(join(home, `res-${round}-b`)));
      const results = ["a", "b"].map((id) => readFileSync(join(home, `res-${round}-${id}`), "utf8"));
      const winners = results.filter((text) => text.startsWith("WON ")).map((text) => Number(text.slice(4)));
      wins += winners.length;
      if (winners.length > 1) violations.push(`round ${round}: both took the lock`);
      let owner: unknown;
      try {
        owner = (JSON.parse(readFileSync(serveLockPath(home), "utf8")) as { pid?: unknown }).pid;
      } catch {
        owner = undefined;
      }
      if (winners.length === 1 && owner !== winners[0]) violations.push(`round ${round}: the winner (pid ${winners[0]}) does not own the lock file (${String(owner)})`);
      writeFileSync(join(home, `done-${round}`), "1");
      await waitUntil("both releases", () => existsSync(join(home, `released-${round}-a`)) && existsSync(join(home, `released-${round}-b`)));
      rmSync(serveLockPath(home), { force: true });
    }
    expect(violations).toEqual([]);
    expect(wins).toBeGreaterThan(0);
  } finally {
    for (const child of children) child.kill();
    await Promise.all(children.map((child) => child.exited));
  }
}, 120_000);

test("a lock that is not the one that was judged is left where it was, and nothing is removed", () => {
  const home = fresh();
  const path = serveLockPath(home);
  const current = `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token: "newer" })}\n`;
  writeFileSync(path, current);
  expect(removeServeLockIfUnchanged(path, `${JSON.stringify({ pid: 1, startedAt: "x", token: "older" })}\n`)).toBe(false);
  expect(readFileSync(path, "utf8")).toBe(current);
});

test("the lock that was judged is removed, and no side file is left behind", () => {
  const home = fresh();
  const path = serveLockPath(home);
  const text = `${JSON.stringify({ pid: 1, startedAt: new Date().toISOString(), token: "old" })}\n`;
  writeFileSync(path, text);
  expect(removeServeLockIfUnchanged(path, text)).toBe(true);
  expect(existsSync(path)).toBe(false);
  expect(new Bun.Glob("*").scanSync(home).next().done).toBe(true);
});
