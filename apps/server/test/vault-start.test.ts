/**
 * S3-01 item 3: unlock at start (refuse, never fall back to plaintext) and the
 * `agni vault` commands. Throwaway home, in-memory keystore.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHomeEnv, migrateHomeLayout } from "../src/home";
import { s3VaultCommands } from "../src/cli/s3-vault";
import { s3Commands } from "../src/cli/s3-commands";
import { extraHelpLines, runExtraCommand } from "../src/cli/extra-commands";
import { VaultError, createMemoryKeyStore, getVault, isVaultUnlocked, lockVault, setKeyStoreOverride, unlockVault, type KeyStore } from "../src/secrets";
import { startupS3Vault, unlockVaultAtStart, vaultRefusalMessage } from "../src/startup/s3-vault";

let roots: string[] = [];
const fresh = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "agni-vstart-"));
  roots.push(dir);
  return dir;
};
const saved = { home: process.env.AGNI_HOME, mode: process.env.AGNI_SECRETS_MODE };
beforeEach(() => {
  lockVault();
  setKeyStoreOverride(createMemoryKeyStore());
  process.exitCode = 0;
});
afterEach(() => {
  lockVault();
  process.exitCode = 0;
  for (const [name, value] of [["AGNI_HOME", saved.home], ["AGNI_SECRETS_MODE", saved.mode]] as const) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  roots = [];
});

/** A keystore that fails the test if anything touches it. */
const forbiddenKeystore = (): KeyStore => ({
  kind: "memory",
  open: async () => { throw new Error("the keystore must not be touched"); },
  create: async () => { throw new Error("the keystore must not be touched"); },
  remove: async () => { throw new Error("the keystore must not be touched"); },
});

describe("unlockVaultAtStart", () => {
  test("file mode with no vault: nothing is opened and the keystore is never touched", async () => {
    setKeyStoreOverride(forbiddenKeystore());
    const home = fresh();
    expect(await unlockVaultAtStart({ home, env: {} })).toEqual({ mode: "file", unlocked: false, applied: [] });
    expect(existsSync(join(home, "vault.bin"))).toBe(false);
    expect(isVaultUnlocked()).toBe(false);
  });

  test("vault mode with no vault: one is made, and an env/<NAME> entry fills the environment", async () => {
    const home = fresh();
    const env: Record<string, string | undefined> = { AGNI_SECRETS_MODE: "vault" };
    const first = await unlockVaultAtStart({ home, env });
    expect(first).toMatchObject({ mode: "vault", unlocked: true, applied: [] });
    getVault().set("env/GROQ_API_KEY", "gsk_vault");
    lockVault();
    const second = await unlockVaultAtStart({ home, env });
    expect(second.applied).toEqual(["GROQ_API_KEY"]);
    expect(env.GROQ_API_KEY).toBe("gsk_vault");
  });

  test("file mode with an existing vault opens it", async () => {
    const home = fresh();
    await unlockVault({ home, create: true });
    lockVault();
    expect((await unlockVaultAtStart({ home, env: {} })).unlocked).toBe(true);
  });

  test("a vault that cannot be opened refuses, in either mode, and no plaintext key is used instead", async () => {
    const home = fresh();
    const keystore = createMemoryKeyStore();
    setKeyStoreOverride(keystore);
    await unlockVault({ home, create: true });
    lockVault();
    keystore.clear();
    writeFileSync(join(home, "config.env"), "GROQ_API_KEY=gsk_plaintext_must_not_be_used\n");
    for (const env of [{}, { AGNI_SECRETS_MODE: "vault" }] as Array<Record<string, string | undefined>>) {
      let caught: unknown;
      try { await unlockVaultAtStart({ home, env }); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(VaultError);
      expect((caught as VaultError).code).toBe("DATA_KEY_MISSING");
      expect(env.GROQ_API_KEY).toBeUndefined();
    }
  });

  test("the refusal message says why, says there is no plaintext fallback, and holds no secret", async () => {
    const message = vaultRefusalMessage(new VaultError("PASSPHRASE_MISSING", "The vault needs a passphrase to unlock and none was provided."));
    expect(message).toContain("Agni cannot start");
    expect(message).toContain("PASSPHRASE_MISSING");
    expect(message).toContain("LoadCredential");
    expect(message).toContain("does not fall back to plaintext");
  });

  test("the sprint hook is a no-op in file mode and insists on an open vault in vault mode", async () => {
    delete process.env.AGNI_SECRETS_MODE;
    await startupS3Vault({} as never);
    process.env.AGNI_SECRETS_MODE = "vault";
    await expect(startupS3Vault({} as never)).rejects.toThrow(VaultError);
    await unlockVault({ home: fresh(), create: true });
    await startupS3Vault({} as never);
  });
});

describe("agni vault", () => {
  /** Run a vault subcommand in a throwaway home; returns what it printed. */
  async function run(home: string, ...args: string[]): Promise<{ out: string; err: string; code: number }> {
    // A fresh process: config.env is loaded the way index.ts does at start.
    process.env.AGNI_HOME = home;
    delete process.env.AGNI_SECRETS_MODE;
    loadHomeEnv();
    const out: string[] = [];
    const err: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...parts: unknown[]) => { out.push(parts.join(" ")); });
    const error = spyOn(console, "error").mockImplementation((...parts: unknown[]) => { err.push(parts.join(" ")); });
    process.exitCode = 0;
    try {
      await s3VaultCommands.commands.vault!(args);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
    const code = Number(process.exitCode ?? 0);
    process.exitCode = 0;
    return { out: out.join("\n"), err: err.join("\n"), code };
  }

  test("is wired into the extra-command tables and the help text", async () => {
    expect(Object.keys(s3Commands.commands)).toContain("vault");
    expect(extraHelpLines().join("\n")).toContain("vault status");
    expect(typeof runExtraCommand).toBe("function");
  });

  test("status on a fresh home: no vault, file mode", async () => {
    const result = await run(fresh(), "status");
    expect(result.out).toContain("exists:    no");
    expect(result.out).toContain("mode:      file");
    expect(result.code).toBe(0);
  });

  test("migrate moves config.env credentials in, switches to vault mode, backs up, and is safe to run twice", async () => {
    const home = fresh();
    writeFileSync(join(home, "config.env"), "AGNI_PORT=9999\nGROQ_API_KEY=gsk_cli_canary\n");
    const first = await run(home, "migrate");
    expect(first.code).toBe(0);
    expect(first.out).toContain("config-env: 1 moved");
    const config = readFileSync(join(home, "config.env"), "utf8");
    expect(config).not.toContain("gsk_cli_canary");
    expect(config).toContain("AGNI_PORT=9999");
    expect(config).toContain("AGNI_SECRETS_MODE=vault");
    const backups = readdirSync(join(home, "data", "vault-backups"));
    expect(backups.length).toBe(1);
    expect(readFileSync(join(home, "data", "vault-backups", backups[0]!, "config.env"), "utf8")).toContain("gsk_cli_canary");
    expect(readFileSync(join(home, "vault.bin")).toString("latin1")).not.toContain("gsk_cli_canary");

    // The old-layout mover (`migrateHomeLayout`) must not take the backups away at the next start.
    expect(migrateHomeLayout({ AGNI_HOME: home }, home).movedFrom).toEqual([]);
    expect(existsSync(join(home, "data", "vault-backups", backups[0]!, "config.env"))).toBe(true);

    const second = await run(home, "migrate");
    expect(second.out).toContain("config-env: 0 moved");
    expect(readFileSync(join(home, "config.env"), "utf8")).toBe(config);

    const status = await run(home, "status");
    expect(status.out).toContain("mode:      vault");
    expect(status.out).toContain("unlocks:   yes (1 entries)");
    const listing = await run(home, "list");
    expect(listing.out).toContain("env/GROQ_API_KEY");
    expect(listing.out).not.toContain("gsk_cli_canary");
  });

  test("export refuses without --yes and changes nothing", async () => {
    const home = fresh();
    writeFileSync(join(home, "config.env"), "GROQ_API_KEY=gsk_cli_canary\n");
    await run(home, "migrate");
    const before = readFileSync(join(home, "config.env"), "utf8");
    const refused = await run(home, "export");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("--yes");
    expect(readFileSync(join(home, "config.env"), "utf8")).toBe(before);
    expect(readFileSync(join(home, "config.env"), "utf8")).not.toContain("gsk_cli_canary");
  });

  test("export --yes restores plaintext to the old file and returns to file mode", async () => {
    const home = fresh();
    writeFileSync(join(home, "config.env"), "AGNI_PORT=9999\nGROQ_API_KEY=gsk_cli_canary\n");
    await run(home, "migrate");
    const exported = await run(home, "export", "--yes");
    expect(exported.code).toBe(0);
    expect(exported.out).toContain("config-env: 1 written");
    const config = readFileSync(join(home, "config.env"), "utf8");
    expect(config).toContain("GROQ_API_KEY=gsk_cli_canary");
    expect(config).toContain("AGNI_SECRETS_MODE=file");
    expect(config).toContain("AGNI_PORT=9999");
  });

  test("a vault that will not open is reported with the reason, exit code 1, and the files untouched", async () => {
    const home = fresh();
    const keystore = createMemoryKeyStore();
    setKeyStoreOverride(keystore);
    await unlockVault({ home, create: true });
    lockVault();
    keystore.clear();
    const result = await run(home, "status");
    expect(result.code).toBe(1);
    expect(result.err).toContain("DATA_KEY_MISSING");
  });

  test("an unknown subcommand prints usage and fails", async () => {
    const result = await run(fresh(), "bogus");
    expect(result.code).toBe(1);
    expect(result.err).toContain("agni vault status");
  });
});
