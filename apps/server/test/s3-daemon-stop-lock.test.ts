/**
 * `daemon stop` ends the process without giving it a chance to clean up on Windows (and SIGKILL does the same anywhere), so
 * the `serve.lock` it held is left behind and, once the pid is reused, blocks `serve`. stopDaemon removes the lock once the
 * process is gone, when the lock names that pid.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { stopDaemon, writePidFile } from "../src/daemon";
import { serveLockPath } from "../src/startup/s3-serve-lock";

let roots: string[] = [];
const children: Array<ReturnType<typeof Bun.spawn>> = [];
const fresh = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "agni-dstop-"));
  roots.push(dir);
  return dir;
};
afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill();
    await child.exited;
  }
  for (const dir of roots) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  roots = [];
});

const config = (home: string) => ({ ...loadConfig(), pidPath: join(home, "run", "agni.pid") });

/** A process that ignores SIGTERM where it can be ignored (POSIX), so the SIGKILL path runs there; Windows ends it at once. */
function stubborn(): ReturnType<typeof Bun.spawn> {
  const child = Bun.spawn([process.execPath, "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
  children.push(child);
  return child;
}

function writeLock(home: string, pid: number): void {
  writeFileSync(serveLockPath(home), `${JSON.stringify({ pid, startedAt: new Date().toISOString(), token: "t" })}\n`);
}

describe("stopDaemon and serve.lock", () => {
  test("stopping the daemon removes the lock it held, whichever signal ended it", async () => {
    const home = fresh();
    mkdirSync(join(home, "run"), { recursive: true });
    const child = stubborn();
    await Bun.sleep(300); // let it install its handler
    writePidFile(join(home, "run", "agni.pid"), { pid: child.pid, startedAt: new Date().toISOString() });
    writeLock(home, child.pid);
    const outcome = await stopDaemon(config(home), { timeoutMs: 600, home });
    expect(outcome.ok).toBe(true);
    expect(existsSync(serveLockPath(home))).toBe(false);
  }, 30_000);

  test("a lock that names another pid (a newer server's) is left alone", async () => {
    const home = fresh();
    mkdirSync(join(home, "run"), { recursive: true });
    const child = stubborn();
    await Bun.sleep(300);
    writePidFile(join(home, "run", "agni.pid"), { pid: child.pid, startedAt: new Date().toISOString() });
    writeLock(home, process.pid);
    const outcome = await stopDaemon(config(home), { timeoutMs: 600, home });
    expect(outcome.ok).toBe(true);
    expect(existsSync(serveLockPath(home))).toBe(true);
  }, 30_000);

  test("a pid file for a process that is already gone: its lock is cleaned up too", async () => {
    const home = fresh();
    mkdirSync(join(home, "run"), { recursive: true });
    const gone = Bun.spawn([process.execPath, "-e", "0"], { stdout: "ignore", stderr: "ignore" });
    await gone.exited;
    writePidFile(join(home, "run", "agni.pid"), { pid: gone.pid, startedAt: new Date().toISOString() });
    writeLock(home, gone.pid);
    const outcome = await stopDaemon(config(home), { timeoutMs: 600, home });
    expect(outcome).toMatchObject({ ok: true, message: "not running" });
    expect(existsSync(serveLockPath(home))).toBe(false);
  }, 30_000);
});
