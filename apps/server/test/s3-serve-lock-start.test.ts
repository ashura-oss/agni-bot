/**
 * `serve` (and only `serve`) treats a lock as stale when its pid is alive but nothing listens where the lock says the server
 * does: a pid reused after a hard kill (Windows `daemon stop`, a crash, a reboot) must not block `serve` for good.
 * `vault migrate` and `export` never do this: they stay fail closed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServeLockError, serveLockPath, serveLockState } from "../src/startup/s3-serve-lock";
import { acquireServeLockAtStart } from "../src/startup/s3-serve-start";

let roots: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
const fresh = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "agni-slstart-"));
  roots.push(dir);
  return dir;
};
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const dir of roots) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  roots = [];
});

/** A live process other than this one, standing in for the reused pid. */
async function liveOther(): Promise<number> {
  const child = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 120000)"], { stdout: "ignore", stderr: "ignore" });
  cleanups.push(async () => {
    child.kill();
    await child.exited;
  });
  return child.pid;
}

function lock(home: string, pid: number, extra: Record<string, unknown> = {}): string {
  const text = `${JSON.stringify({ pid, startedAt: new Date().toISOString(), token: "theirs", ...extra })}\n`;
  writeFileSync(serveLockPath(home), text);
  return text;
}

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = server.port as number;
  await server.stop(true);
  return port;
}

const quick = { silentForMs: 400, pollMs: 100 };

describe("acquireServeLockAtStart", () => {
  test("no lock: takes it", async () => {
    const home = fresh();
    const held = await acquireServeLockAtStart({ home, ...quick });
    expect(serveLockState({ home })).toEqual(expect.objectContaining({ state: "held", pid: process.pid }));
    held.release();
  });

  test("a live pid whose recorded address refuses connections is stale: serve takes the lock over", async () => {
    const home = fresh();
    lock(home, await liveOther(), { host: "127.0.0.1", port: await closedPort() });
    const held = await acquireServeLockAtStart({ home, ...quick });
    expect(JSON.parse(readFileSync(serveLockPath(home), "utf8")).pid).toBe(process.pid);
    held.release();
  });

  test("a live pid whose recorded address answers /health is a running server: refused, lock untouched", async () => {
    const home = fresh();
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ ok: true, v: 2, uptimeMs: 1 }) });
    cleanups.push(() => server.stop(true));
    const text = lock(home, await liveOther(), { host: "127.0.0.1", port: server.port });
    await expect(acquireServeLockAtStart({ home, ...quick })).rejects.toThrow(ServeLockError);
    expect(readFileSync(serveLockPath(home), "utf8")).toBe(text);
  });

  test("a recorded address that accepts connections but never answers is not called stale (a wedged server still owns the port)", async () => {
    const home = fresh();
    const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {} } });
    cleanups.push(() => listener.stop(true));
    const text = lock(home, await liveOther(), { host: "127.0.0.1", port: listener.port });
    await expect(acquireServeLockAtStart({ home, ...quick })).rejects.toThrow(ServeLockError);
    expect(readFileSync(serveLockPath(home), "utf8")).toBe(text);
  });

  test("a live pid with no recorded address cannot be told from a server still starting: refused, and the message says how to clear it", async () => {
    const home = fresh();
    const text = lock(home, await liveOther());
    await expect(acquireServeLockAtStart({ home, ...quick })).rejects.toThrow(/delete .*serve\.lock if no Agni server is running/);
    expect(readFileSync(serveLockPath(home), "utf8")).toBe(text);
  });

  test("a wildcard bind address is probed on loopback", async () => {
    const home = fresh();
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ ok: true, v: 2, uptimeMs: 1 }) });
    cleanups.push(() => server.stop(true));
    lock(home, await liveOther(), { host: "0.0.0.0", port: server.port });
    await expect(acquireServeLockAtStart({ home, ...quick })).rejects.toThrow(ServeLockError);
  });

  test("a lock that is replaced while the probe runs is not removed: it is a different server's", async () => {
    const home = fresh();
    const pid = await liveOther();
    lock(home, pid, { host: "127.0.0.1", port: await closedPort() });
    const swap = setTimeout(() => lock(home, pid, { token: "swapped", host: "127.0.0.1", port: 1 }), 150);
    cleanups.push(() => clearTimeout(swap));
    await expect(acquireServeLockAtStart({ home, ...quick })).rejects.toThrow(ServeLockError);
    expect(JSON.parse(readFileSync(serveLockPath(home), "utf8")).token).toBe("swapped");
  });
});

describe("which recorded hosts allow a takeover (fail closed)", () => {
  test("a live `localhost` bind keeps the lock, wherever this machine puts it (Windows/Bun: ::1 only)", async () => {
    const home = fresh();
    const server = Bun.serve({ port: 0, hostname: "localhost", fetch: () => Response.json({ ok: true, v: 2, uptimeMs: 1 }) });
    cleanups.push(() => server.stop(true));
    const text = lock(home, await liveOther(), { host: "localhost", port: server.port });
    await expect(acquireServeLockAtStart({ home, ...quick })).rejects.toThrow(ServeLockError);
    expect(readFileSync(serveLockPath(home), "utf8")).toBe(text);
  });

  test("`localhost` with nothing listening on 127.0.0.1 or ::1 is stale: taken over", async () => {
    const home = fresh();
    lock(home, await liveOther(), { host: "localhost", port: await closedPort() });
    const held = await acquireServeLockAtStart({ home, ...quick });
    expect(JSON.parse(readFileSync(serveLockPath(home), "utf8")).pid).toBe(process.pid);
    held.release();
  });

  test("an IP literal that refuses is stale: an IPv6 literal too", async () => {
    const home = fresh();
    lock(home, await liveOther(), { host: "::1", port: await closedPort() });
    const held = await acquireServeLockAtStart({ home, ...quick });
    expect(JSON.parse(readFileSync(serveLockPath(home), "utf8")).pid).toBe(process.pid);
    held.release();
  });

  test("a live bind on an IPv6 literal keeps the lock", async () => {
    const home = fresh();
    const server = Bun.serve({ port: 0, hostname: "::1", fetch: () => Response.json({ ok: true, v: 2, uptimeMs: 1 }) });
    cleanups.push(() => server.stop(true));
    const text = lock(home, await liveOther(), { host: "::1", port: server.port });
    await expect(acquireServeLockAtStart({ home, ...quick })).rejects.toThrow(ServeLockError);
    expect(readFileSync(serveLockPath(home), "utf8")).toBe(text);
  });

  test.each(["0.0.0.0", "::", "[::]"])("a wildcard (%s) is never taken over, even when nothing listens: the message says which file to delete", async (host) => {
    const home = fresh();
    const text = lock(home, await liveOther(), { host, port: await closedPort() });
    await expect(acquireServeLockAtStart({ home, ...quick })).rejects.toThrow(/delete .*serve\.lock if no Agni server is running/);
    expect(readFileSync(serveLockPath(home), "utf8")).toBe(text);
  });

  test.each(["agni.example", "my-machine", "agni.localhost"])("a host name (%s) is never taken over, even when nothing listens", async (host) => {
    const home = fresh();
    const text = lock(home, await liveOther(), { host, port: await closedPort() });
    await expect(acquireServeLockAtStart({ home, ...quick })).rejects.toThrow(/delete .*serve\.lock if no Agni server is running/);
    expect(readFileSync(serveLockPath(home), "utf8")).toBe(text);
  });
});
