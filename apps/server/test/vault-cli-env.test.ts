/**
 * S3-01 review fix 6: in vault mode the CLI commands that talk to the running
 * daemon (`daemon status`, `service status`, ...) get AGNI_TOKEN from the vault,
 * because `loadHomeEnv` no longer reads credentials from config.env.
 * Throwaway homes; the passphrase keystore (or an in-memory one) only.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanChildEnv } from "./child-env";
import { localDeviceToken } from "../src/daemon";
import { createMemoryKeyStore, isVaultUnlocked, lockVault, setKeyStoreOverride, unlockVault, type KeyStore } from "../src/secrets";
import { loadVaultEnvForCli } from "../src/startup/s3-vault";

const ENTRY = resolve(import.meta.dir, "../src/index.ts");
const TOKEN = "agni_device_token_canary_0123456789";
const PASSPHRASE = "correct horse battery staple";

let roots: string[] = [];
const fresh = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "agni-vcli-"));
  roots.push(dir);
  return dir;
};
beforeEach(() => {
  lockVault();
  setKeyStoreOverride(createMemoryKeyStore());
});
afterEach(() => {
  lockVault();
  for (const dir of roots) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  roots = [];
});

const forbiddenKeystore = (): KeyStore => ({
  kind: "memory",
  open: async () => { throw new Error("the keystore must not be touched"); },
  create: async () => { throw new Error("the keystore must not be touched"); },
  remove: async () => { throw new Error("the keystore must not be touched"); },
});

describe("loadVaultEnvForCli", () => {
  test("vault mode: AGNI_TOKEN comes from the vault, and only that variable", async () => {
    const home = fresh();
    const vault = await unlockVault({ home, create: true });
    vault.set("env/AGNI_TOKEN", TOKEN);
    vault.set("env/OPENROUTER_API_KEY", "sk-other");
    lockVault();
    const env: Record<string, string | undefined> = { AGNI_SECRETS_MODE: "vault" };
    expect(await loadVaultEnvForCli({ env, home })).toEqual(["AGNI_TOKEN"]);
    expect(localDeviceToken(env)).toBe(TOKEN);
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
  });

  test("a token already in the environment wins and the vault is not even opened", async () => {
    const home = fresh();
    setKeyStoreOverride(forbiddenKeystore());
    const env: Record<string, string | undefined> = { AGNI_SECRETS_MODE: "vault", AGNI_TOKEN: "from-shell" };
    expect(await loadVaultEnvForCli({ env, home })).toEqual([]);
    expect(env.AGNI_TOKEN).toBe("from-shell");
  });

  test("file mode, or no vault yet: nothing happens and the keystore is never touched", async () => {
    const home = fresh();
    setKeyStoreOverride(forbiddenKeystore());
    expect(await loadVaultEnvForCli({ env: {}, home })).toEqual([]);
    expect(await loadVaultEnvForCli({ env: { AGNI_SECRETS_MODE: "vault" }, home })).toEqual([]);
  });

  test("a vault that will not open does not stop the command: a warning with the reason, no token", async () => {
    const home = fresh();
    const keystore = createMemoryKeyStore();
    setKeyStoreOverride(keystore);
    const vault = await unlockVault({ home, create: true });
    vault.set("env/AGNI_TOKEN", TOKEN);
    lockVault();
    keystore.clear();
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const env: Record<string, string | undefined> = { AGNI_SECRETS_MODE: "vault" };
      expect(await loadVaultEnvForCli({ env, home })).toEqual([]);
      expect(env.AGNI_TOKEN).toBeUndefined();
      const printed = error.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(printed).toContain("DATA_KEY_MISSING");
      expect(printed).not.toContain(TOKEN);
    } finally {
      error.mockRestore();
    }
    expect(isVaultUnlocked()).toBe(false);
  });
});

describe("agni daemon status in vault mode (real child processes)", () => {
  const children = new Set<ReturnType<typeof Bun.spawn>>();
  afterEach(async () => {
    for (const child of children) child.kill();
    await Promise.all([...children].map((child) => child.exited));
    children.clear();
  });

  async function agni(home: string, port: number, args: string[]): Promise<{ code: number; out: string }> {
    const child = Bun.spawn([process.execPath, ENTRY, ...args], {
      cwd: tmpdir(),
      env: cleanChildEnv({ AGNI_HOME: home, AGNI_PORT: String(port), AGNI_KEYSTORE: "passphrase", AGNI_VAULT_PASSPHRASE_FILE: join(home, "..", "pp.txt") }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    children.add(child);
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const code = await child.exited;
    children.delete(child);
    return { code, out: out + err };
  }

  /** A stand-in for the daemon: answers /health and records what the Authorization header said. */
  function stubDaemon(): { port: number; seen: Array<string | null>; stop: () => void } {
    const seen: Array<string | null> = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        seen.push(request.headers.get("authorization"));
        return Response.json({ ok: true, v: 1, uptimeMs: 5000 });
      },
    });
    return { port: server.port as number, seen, stop: () => void server.stop(true) };
  }

  test("the stored device token is sent to /health; with the vault unreadable the status still prints, without it", async () => {
    const parent = fresh();
    writeFileSync(join(parent, "pp.txt"), `${PASSPHRASE}\n`);
    const home = join(parent, "home");
    await Bun.write(join(home, "config.env"), `AGNI_HOST=127.0.0.1\nAGNI_TOKEN=${TOKEN}\n`);
    const daemon = stubDaemon();
    try {
      // Not on the stub's port: migrate refuses while anything answers /health there (a server would hold the files open).
      const migrated = await agni(home, 1, ["vault", "migrate"]);
      expect(migrated.code).toBe(0);
      expect(migrated.out).toContain("config-env: 1 moved");

      const status = await agni(home, daemon.port, ["daemon", "status"]);
      expect(status.out).toContain("daemon: running");
      expect(status.out).not.toContain(TOKEN);
      expect(daemon.seen.at(-1)).toBe(`Bearer ${TOKEN}`);

      // Wrong passphrase: the command does not crash and does not invent a token.
      writeFileSync(join(parent, "pp.txt"), "a completely different passphrase\n");
      const before = daemon.seen.length;
      const degraded = await agni(home, daemon.port, ["daemon", "status"]);
      expect(degraded.out).toContain("daemon: running");
      expect(degraded.out).toContain("PASSPHRASE_REJECTED");
      expect(degraded.out).not.toContain(TOKEN);
      expect(daemon.seen.slice(before).every((header) => header === null)).toBe(true);
    } finally {
      daemon.stop();
    }
  }, 60_000);
});
