/**
 * Final review blocker: `agni vault migrate` and `agni vault export` rewrite
 * the database and the credential files, so they must not run while the
 * daemon has them open. The check is read-only: the pid file and a liveness
 * probe, nothing is signalled or stopped.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { daemonRunningRefusal } from "../src/cli/s3-vault";
import { loadConfig } from "../src/config";

const ENTRY = resolve(import.meta.dir, "../src/index.ts");
const PASSPHRASE = "correct horse battery staple";
const CANARY = "gsk_guard_canary_0123456789";

let roots: string[] = [];
const fresh = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "agni-vguard-"));
  roots.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  roots = [];
});

/** A pid that belonged to a process that has exited. */
async function deadPid(): Promise<number> {
  const child = Bun.spawn([process.execPath, "-e", "0"], { stdout: "ignore", stderr: "ignore" });
  await child.exited;
  return child.pid;
}

function writePid(home: string, pid: number): void {
  mkdirSync(join(home, "run"), { recursive: true });
  writeFileSync(join(home, "run", "agni.pid"), JSON.stringify({ pid }));
}

async function runVault(home: string, parent: string, args: string[]): Promise<{ code: number; printed: string }> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || /^AGNI_|API_KEY|TOKEN|SECRET|PASSWORD|^GROQ|^CEREBRAS|^NVIDIA|^OPENROUTER/i.test(name)) continue;
    env[name] = value;
  }
  const child = Bun.spawn([process.execPath, ENTRY, "vault", ...args], {
    cwd: tmpdir(),
    env: { ...env, AGNI_HOME: home, AGNI_KEYSTORE: "passphrase", AGNI_VAULT_PASSPHRASE_FILE: join(parent, "pp.txt") },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code: await child.exited, printed: out + err };
}

/** A config whose port nothing listens on, so the /health probe never reaches a real server on this machine. */
const quiet = { ...loadConfig(), host: "127.0.0.1", port: 1 };

describe("daemonRunningRefusal", () => {
  test("a pid file naming a live process refuses, and says to stop the daemon first", async () => {
    const home = fresh();
    writePid(home, process.pid);
    const message = await daemonRunningRefusal({ pidPath: join(home, "run", "agni.pid"), home, config: quiet });
    expect(message).toBeDefined();
    expect(message).toContain("stop the daemon first");
    expect(message).toContain("agni daemon stop");
  });

  test("no pid file: nothing refuses", async () => {
    const home = fresh();
    expect(await daemonRunningRefusal({ pidPath: join(home, "run", "agni.pid"), home, config: quiet })).toBeUndefined();
  });

  test("a stale pid file (the process is gone) does not refuse", async () => {
    const home = fresh();
    writePid(home, await deadPid());
    expect(await daemonRunningRefusal({ pidPath: join(home, "run", "agni.pid"), home, config: quiet })).toBeUndefined();
  });
});

describe("daemonRunningRefusal: the serve lock", () => {
  test("a lock held by a live process refuses with no pid file", async () => {
    const home = fresh();
    writeFileSync(join(home, "serve.lock"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const message = await daemonRunningRefusal({ pidPath: join(home, "run", "agni.pid"), home, config: quiet });
    expect(message).toContain("stop the daemon first");
    expect(message).toContain(String(process.pid));
  });

  test("a lock that cannot be read refuses (fail closed), and says how to clear it", async () => {
    const home = fresh();
    writeFileSync(join(home, "serve.lock"), "{garbage");
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(home, "serve.lock"), old, old); // it has sat there: not a server in the middle of writing it
    const message = await daemonRunningRefusal({ pidPath: join(home, "run", "agni.pid"), home, config: quiet });
    expect(message).toContain("cannot be read");
    expect(message).toContain("delete that file");
  });

  test("a lock written a moment ago and not finished is a server starting: refuses, and says so", async () => {
    const home = fresh();
    writeFileSync(join(home, "serve.lock"), "");
    const message = await daemonRunningRefusal({ pidPath: join(home, "run", "agni.pid"), home, config: quiet });
    expect(message).toContain("is starting");
    expect(message).toContain("stop the daemon first");
  });

  test("a live pid's lock says which file to delete when no server is running (a pid reused after a hard kill)", async () => {
    const home = fresh();
    writeFileSync(join(home, "serve.lock"), JSON.stringify({ pid: process.pid, startedAt: new Date(Date.now() - 400 * 24 * 3600 * 1000).toISOString() }));
    const message = await daemonRunningRefusal({ pidPath: join(home, "run", "agni.pid"), home, config: quiet });
    expect(message).toContain(`delete ${join(home, "serve.lock")}`);
  });

  test("a stale lock does not refuse", async () => {
    const home = fresh();
    writeFileSync(join(home, "serve.lock"), JSON.stringify({ pid: await deadPid(), startedAt: new Date().toISOString() }));
    expect(await daemonRunningRefusal({ pidPath: join(home, "run", "agni.pid"), home, config: quiet })).toBeUndefined();
  });
});

describe("agni vault migrate / export while the daemon is running (real child process)", () => {
  async function setup(): Promise<{ parent: string; home: string; configEnv: string }> {
    const parent = fresh();
    writeFileSync(join(parent, "pp.txt"), `${PASSPHRASE}\n`);
    const home = join(parent, "home");
    mkdirSync(home, { recursive: true });
    const configEnv = `AGNI_HOST=127.0.0.1\nGROQ_API_KEY=${CANARY}\n`;
    writeFileSync(join(home, "config.env"), configEnv);
    writePid(home, process.pid); // this test process stands in for the daemon: it is alive
    return { parent, home, configEnv };
  }

  test("migrate stops before touching anything", async () => {
    const { parent, home, configEnv } = await setup();
    const { code, printed } = await runVault(home, parent, ["migrate"]);
    expect(code).not.toBe(0);
    expect(printed).toContain("stop the daemon first");
    expect(printed).not.toContain(CANARY);
    expect(readFileSync(join(home, "config.env"), "utf8")).toBe(configEnv);
  }, 60_000);

  test("export stops before touching anything", async () => {
    const { parent, home, configEnv } = await setup();
    const { code, printed } = await runVault(home, parent, ["export", "--yes", "--non-interactive"]);
    expect(code).not.toBe(0);
    expect(printed).toContain("stop the daemon first");
    expect(readFileSync(join(home, "config.env"), "utf8")).toBe(configEnv);
  }, 60_000);
});

describe("agni vault migrate / export while a server runs that no pid file names", () => {
  // `serve` in the foreground, or under a login service, never writes the pid file.
  const children = new Set<ReturnType<typeof Bun.spawn>>();
  afterEach(async () => {
    for (const child of children) child.kill();
    await Promise.all([...children].map((child) => child.exited));
    children.clear();
  });

  async function freePort(): Promise<number> {
    const server = Bun.serve({ port: 0, fetch: () => new Response("") });
    const port = server.port as number;
    await server.stop(true);
    return port;
  }

  function envFor(home: string, parent: string, port: number): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (value === undefined || /^AGNI_|API_KEY|TOKEN|SECRET|PASSWORD|^GROQ|^CEREBRAS|^NVIDIA|^OPENROUTER/i.test(name)) continue;
      env[name] = value;
    }
    return { ...env, AGNI_HOME: home, AGNI_PORT: String(port), AGNI_KEYSTORE: "passphrase", AGNI_VAULT_PASSPHRASE_FILE: join(parent, "pp.txt") };
  }

  function homeWithConfig(): { parent: string; home: string; configEnv: string } {
    const parent = fresh();
    writeFileSync(join(parent, "pp.txt"), `${PASSPHRASE}\n`);
    const home = join(parent, "home");
    mkdirSync(home, { recursive: true });
    const configEnv = `AGNI_HOST=127.0.0.1\nGROQ_API_KEY=${CANARY}\n`;
    writeFileSync(join(home, "config.env"), configEnv);
    return { parent, home, configEnv };
  }

  async function startServe(home: string, parent: string, port: number): Promise<ReturnType<typeof Bun.spawn>> {
    const child = Bun.spawn([process.execPath, ENTRY, "serve"], { cwd: tmpdir(), env: envFor(home, parent, port), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    children.add(child);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) })).ok) return child;
      } catch {
        // not listening yet
      }
      await Bun.sleep(150);
    }
    throw new Error("the server did not come up");
  }

  async function vaultCommand(home: string, parent: string, port: number, args: string[]): Promise<{ code: number; printed: string }> {
    const child = Bun.spawn([process.execPath, ENTRY, "vault", ...args], { cwd: tmpdir(), env: envFor(home, parent, port), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code: await child.exited, printed: out + err };
  }

  test("a foreground serve (no pid file) stops migrate and export", async () => {
    const { parent, home, configEnv } = homeWithConfig();
    const port = await freePort();
    await startServe(home, parent, port);
    expect(existsSync(join(home, "run", "agni.pid"))).toBe(false);
    // What stops them is the lock the running serve holds: it is there for as long as the server runs.
    expect(existsSync(join(home, "serve.lock"))).toBe(true);
    const migrate = await vaultCommand(home, parent, port, ["migrate"]);
    expect(migrate.code).not.toBe(0);
    expect(migrate.printed).toContain("stop the daemon first");
    expect(migrate.printed).not.toContain(CANARY);
    const exported = await vaultCommand(home, parent, port, ["export", "--yes", "--non-interactive"]);
    expect(exported.code).not.toBe(0);
    expect(exported.printed).toContain("stop the daemon first");
    expect(readFileSync(join(home, "config.env"), "utf8")).toBe(configEnv);
  }, 90_000);

  test("something answering /health on the port stops migrate even with no pid file and no lock", async () => {
    const { parent, home, configEnv } = homeWithConfig();
    const stub = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ ok: true, v: 2, uptimeMs: 1 }) });
    try {
      const migrate = await vaultCommand(home, parent, stub.port as number, ["migrate"]);
      expect(migrate.code).not.toBe(0);
      expect(migrate.printed).toContain("stop the daemon first");
      expect(readFileSync(join(home, "config.env"), "utf8")).toBe(configEnv);
    } finally {
      await stub.stop(true);
    }
  }, 60_000);

  test("after a server was killed (its lock is left behind) export is not refused, and serve starts again", async () => {
    const { parent, home } = homeWithConfig();
    const port = await freePort();
    const first = await startServe(home, parent, port);
    first.kill(); // no exit handler runs: the lock file stays
    await first.exited;
    children.delete(first);
    const exported = await vaultCommand(home, parent, port, ["export", "--yes", "--non-interactive"]);
    expect(exported.printed).not.toContain("stop the daemon first");
    await startServe(home, parent, port);
  }, 90_000);
});
