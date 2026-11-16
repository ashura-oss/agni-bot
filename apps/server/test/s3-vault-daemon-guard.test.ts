/**
 * Final review blocker: `agni vault migrate` and `agni vault export` rewrite
 * the database and the credential files, so they must not run while the
 * daemon has them open. The check is read-only: the pid file and a liveness
 * probe, nothing is signalled or stopped.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { daemonRunningRefusal } from "../src/cli/s3-vault";

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

describe("daemonRunningRefusal", () => {
  test("a pid file naming a live process refuses, and says to stop the daemon first", () => {
    const home = fresh();
    writePid(home, process.pid);
    const message = daemonRunningRefusal(join(home, "run", "agni.pid"));
    expect(message).toBeDefined();
    expect(message).toContain("stop the daemon first");
    expect(message).toContain("agni daemon stop");
  });

  test("no pid file: nothing refuses", () => {
    expect(daemonRunningRefusal(join(fresh(), "run", "agni.pid"))).toBeUndefined();
  });

  test("a stale pid file (the process is gone) does not refuse", async () => {
    const home = fresh();
    writePid(home, await deadPid());
    expect(daemonRunningRefusal(join(home, "run", "agni.pid"))).toBeUndefined();
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
