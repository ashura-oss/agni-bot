/**
 * `agni vault migrate` and `agni vault export` rewrite the database and the credential files. Once their checks pass they
 * take the serve lock and hold it until they finish, so a `serve` started meanwhile is refused by its own lock check instead
 * of opening files that are being rewritten.
 *
 * Both run in this process (the preload's in-memory keystore, a throwaway AGNI_HOME). At the moment a command reports its
 * first result, which is after the rewriting and before it lets go, the test starts a real `serve` on the same home and
 * records what it says.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanChildEnv } from "./child-env";
import { s3VaultCommands } from "../src/cli/s3-vault";
import { lockVault } from "../src/secrets";
import { serveLockPath, serveLockState } from "../src/startup/s3-serve-lock";

const ENTRY = resolve(import.meta.dir, "../src/index.ts");
const CANARY = "gsk_holds_lock_canary_0123456789";
const ENV_KEYS = ["AGNI_HOME", "AGNI_PORT", "AGNI_SECRETS_MODE", "AGNI_KEYSTORE", "AGNI_PLUGINS_PATH", "AGNI_PROVIDER_CONFIG_PATH", "AGNI_DB_PATH", "GROQ_API_KEY"];
const saved: Record<string, string | undefined> = {};
let parent = "";
let home = "";
let exitCode: typeof process.exitCode;

beforeEach(() => {
  for (const name of ENV_KEYS) saved[name] = process.env[name];
  for (const name of ENV_KEYS) delete process.env[name];
  exitCode = process.exitCode;
  lockVault();
  parent = mkdtempSync(join(tmpdir(), "agni-vholds-"));
  home = join(parent, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.env"), `AGNI_HOST=127.0.0.1\nGROQ_API_KEY=${CANARY}\n`);
  process.env.AGNI_HOME = home;
  process.env.AGNI_PORT = "1"; // nothing answers /health there, so only the lock can stop a `serve`
});
afterEach(() => {
  lockVault();
  process.exitCode = exitCode;
  for (const name of ENV_KEYS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  rmSync(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** What a `serve` on this home printed, started at the moment `probe` is called. */
function serveNow(): { code: number | null; printed: string } {
  const result = Bun.spawnSync([process.execPath, ENTRY, "serve"], {
    cwd: tmpdir(),
    env: cleanChildEnv({ AGNI_HOME: home, AGNI_PORT: "18999", AGNI_KEYSTORE: "passphrase", AGNI_VAULT_PASSPHRASE_FILE: join(parent, "pp.txt") }),
    stdin: "ignore",
    timeout: 25_000,
    killSignal: "SIGKILL",
  });
  return { code: result.exitCode, printed: `${result.stdout.toString()}${result.stderr.toString()}` };
}

/** Run a vault command in this process; at its first result line (the rewriting is done, the lock is still to be let go of) start a `serve`. */
async function runVaultCommand(args: string[], resultLine: RegExp): Promise<{ serve?: { code: number | null; printed: string }; lockDuring?: ReturnType<typeof serveLockState>; printed: string[] }> {
  const printed: string[] = [];
  const original = console.log;
  let serve: { code: number | null; printed: string } | undefined;
  let lockDuring: ReturnType<typeof serveLockState> | undefined;
  console.log = (...parts: unknown[]) => {
    const line = parts.map(String).join(" ");
    printed.push(line);
    if (!serve && resultLine.test(line)) {
      lockDuring = serveLockState({ home });
      serve = serveNow();
    }
  };
  try {
    await s3VaultCommands.commands.vault!(args);
  } finally {
    console.log = original;
  }
  return { serve, lockDuring, printed };
}

describe("vault migrate and export hold the serve lock while they run", () => {
  test("migrate: a serve started meanwhile is refused by the lock, and the lock is gone afterwards", async () => {
    writeFileSync(join(parent, "pp.txt"), "unused\n");
    const { serve, lockDuring, printed } = await runVaultCommand(["migrate"], /: \d+ moved$/);
    expect(printed.join("\n")).toContain("done.");
    expect(lockDuring).toEqual(expect.objectContaining({ state: "held", pid: process.pid }));
    expect(serve).toBeDefined();
    expect(serve!.code).not.toBe(0);
    expect(serve!.printed).toContain("another Agni server");
    expect(serve!.printed).toContain(`delete ${serveLockPath(home)} if no Agni server is running`);
    expect(existsSync(serveLockPath(home))).toBe(false);
    expect(readFileSync(join(home, "config.env"), "utf8")).not.toContain(CANARY);
  }, 90_000);

  test("export: the same", async () => {
    writeFileSync(join(parent, "pp.txt"), "unused\n");
    await runVaultCommand(["migrate"], /^$/); // a vault to export
    expect(existsSync(serveLockPath(home))).toBe(false);
    const { serve, lockDuring, printed } = await runVaultCommand(["export", "--yes", "--non-interactive"], /: \d+ written$/);
    expect(printed.join("\n")).toContain("exported.");
    expect(lockDuring).toEqual(expect.objectContaining({ state: "held", pid: process.pid }));
    expect(serve).toBeDefined();
    expect(serve!.code).not.toBe(0);
    expect(serve!.printed).toContain("another Agni server");
    expect(existsSync(serveLockPath(home))).toBe(false);
    expect(readFileSync(join(home, "config.env"), "utf8")).toContain(CANARY);
  }, 90_000);

  test("a live server's lock stops migrate before it touches anything, and the lock stays that server's", async () => {
    // A live process other than this one stands in for the server.
    const other = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 60000)"], { stdout: "ignore", stderr: "ignore" });
    try {
      writeFileSync(serveLockPath(home), `${JSON.stringify({ pid: other.pid, startedAt: new Date().toISOString(), token: "theirs" })}\n`);
      const configBefore = readFileSync(join(home, "config.env"), "utf8");
      process.exitCode = undefined;
      await s3VaultCommands.commands.vault!(["migrate"]);
      expect(String(process.exitCode)).toBe("1");
      expect(readFileSync(join(home, "config.env"), "utf8")).toBe(configBefore);
      expect(JSON.parse(readFileSync(serveLockPath(home), "utf8")).token).toBe("theirs");
    } finally {
      other.kill();
      await other.exited;
    }
  });
});
