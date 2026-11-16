/**
 * S3-01 item 5: `loadHomeEnv` keeps loading non-secret settings from
 * config.env; in vault mode the secrets come from the vault instead.
 * Also the config.env helpers that move secrets in and out of the vault.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHomeEnv } from "../src/home";
import { createMemoryKeyStore, lockVault, unlockVault, VaultError } from "../src/secrets";
import {
  applyVaultEnv,
  exportEnvEntries,
  importEnvFileSecrets,
  plaintextSecretNames,
  setEnvFileValues,
} from "../src/secrets/env";
import { isSecretEnvName } from "../src/secrets/mode";

let roots: string[] = [];
const fresh = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "agni-venv-"));
  roots.push(dir);
  return dir;
};
beforeEach(() => lockVault());
afterEach(() => {
  lockVault();
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  roots = [];
});

describe("which names are secrets", () => {
  test("keys, tokens, secrets and passwords are; ids, public keys, limits and paths are not", () => {
    for (const name of ["GROQ_API_KEY", "OPENROUTER_API_KEY", "GOOGLE_OAUTH_CLIENT_SECRET", "GMAIL_APP_PASSWORD", "AGNI_TOKEN", "AGNI_FIRECRAWL_API_KEY", "AGNI_VAPID_PRIVATE_KEY", "MY_SERVICE_PASSPHRASE"]) {
      expect(isSecretEnvName(name)).toBe(true);
    }
    for (const name of ["AGNI_HOST", "AGNI_PORT", "GOOGLE_OAUTH_CLIENT_ID", "AGNI_MAX_OUTPUT_TOKENS", "AGNI_VAPID_PUBLIC_KEY", "AGNI_VAULT_PASSPHRASE_FILE", "AGNI_SECRETS_MODE", "AGNI_VISION_MODELS"]) {
      expect(isSecretEnvName(name)).toBe(false);
    }
  });
});

describe("loadHomeEnv", () => {
  const configEnv = "AGNI_PORT=9999\nGROQ_API_KEY=gsk_plain\nGOOGLE_OAUTH_CLIENT_ID=id-1\nGMAIL_APP_PASSWORD=pw\n";

  test("file mode (the default): secrets are loaded from config.env as before", () => {
    const home = fresh();
    writeFileSync(join(home, "config.env"), configEnv);
    const env: Record<string, string | undefined> = { AGNI_HOME: home };
    loadHomeEnv(env);
    expect(env).toMatchObject({ AGNI_PORT: "9999", GROQ_API_KEY: "gsk_plain", GOOGLE_OAUTH_CLIENT_ID: "id-1", GMAIL_APP_PASSWORD: "pw" });
  });

  test("vault mode set in the shell: only non-secret settings are loaded from config.env", () => {
    const home = fresh();
    writeFileSync(join(home, "config.env"), configEnv);
    const env: Record<string, string | undefined> = { AGNI_HOME: home, AGNI_SECRETS_MODE: "vault" };
    loadHomeEnv(env);
    expect(env.AGNI_PORT).toBe("9999");
    expect(env.GOOGLE_OAUTH_CLIENT_ID).toBe("id-1");
    expect(env.GROQ_API_KEY).toBeUndefined();
    expect(env.GMAIL_APP_PASSWORD).toBeUndefined();
  });

  test("vault mode set inside config.env itself counts", () => {
    const home = fresh();
    writeFileSync(join(home, "config.env"), `AGNI_SECRETS_MODE=vault\n${configEnv}`);
    const env: Record<string, string | undefined> = { AGNI_HOME: home };
    loadHomeEnv(env);
    expect(env.AGNI_SECRETS_MODE).toBe("vault");
    expect(env.GROQ_API_KEY).toBeUndefined();
  });

  test("a secret already in the shell environment is still honoured in vault mode", () => {
    const home = fresh();
    writeFileSync(join(home, "config.env"), configEnv);
    const env: Record<string, string | undefined> = { AGNI_HOME: home, AGNI_SECRETS_MODE: "vault", GROQ_API_KEY: "from-shell" };
    loadHomeEnv(env);
    expect(env.GROQ_API_KEY).toBe("from-shell");
  });
});

describe("plaintext left in config.env", () => {
  test("is reported by name, never by value, and empty template lines are ignored", () => {
    const home = fresh();
    writeFileSync(join(home, "config.env"), "GROQ_API_KEY=gsk_x\nGMAIL_APP_PASSWORD=\nAGNI_PORT=1\n");
    expect(plaintextSecretNames(join(home, "config.env"))).toEqual(["GROQ_API_KEY"]);
    expect(plaintextSecretNames(join(home, "missing.env"))).toEqual([]);
  });
});

describe("applyVaultEnv", () => {
  test("fills env/<NAME> entries into unset variables only", async () => {
    const vault = await unlockVault({ home: fresh(), keystore: createMemoryKeyStore(), create: true });
    vault.set("env/GROQ_API_KEY", "from-vault");
    vault.set("env/OTHER_API_KEY", "other");
    vault.set("plugin/google", "not-an-env-entry");
    const env: Record<string, string | undefined> = { OTHER_API_KEY: "shell-wins" };
    expect(applyVaultEnv(env, vault)).toEqual(["GROQ_API_KEY"]);
    expect(env).toEqual({ GROQ_API_KEY: "from-vault", OTHER_API_KEY: "shell-wins" });
  });
});

describe("moving secrets between config.env and the vault", () => {
  const original = "# keys\nAGNI_PORT=9999\nGROQ_API_KEY=gsk_canary_1\nGMAIL_APP_PASSWORD=\"has space\"\nGOOGLE_OAUTH_CLIENT_ID=id-1\n";

  test("import: secrets move into the vault, the file keeps everything else, a backup is made first", async () => {
    const home = fresh();
    const vault = await unlockVault({ home, keystore: createMemoryKeyStore(), create: true });
    const file = join(home, "config.env");
    writeFileSync(file, original);
    const backupDir = join(home, "backups", "b1");
    const moved = importEnvFileSecrets(vault, file, backupDir);
    expect(moved.sort()).toEqual(["GMAIL_APP_PASSWORD", "GROQ_API_KEY"]);
    expect(vault.get("env/GROQ_API_KEY")).toBe("gsk_canary_1");
    expect(vault.get("env/GMAIL_APP_PASSWORD")).toBe("has space");
    const after = readFileSync(file, "utf8");
    expect(after).not.toContain("gsk_canary_1");
    expect(after).not.toContain("has space");
    expect(after).toContain("# keys");
    expect(after).toContain("AGNI_PORT=9999");
    expect(after).toContain("GOOGLE_OAUTH_CLIENT_ID=id-1");
    expect(readFileSync(join(backupDir, "config.env"), "utf8")).toBe(original);
  });

  test("import is idempotent: a second run moves nothing and changes nothing", async () => {
    const home = fresh();
    const vault = await unlockVault({ home, keystore: createMemoryKeyStore(), create: true });
    const file = join(home, "config.env");
    writeFileSync(file, original);
    importEnvFileSecrets(vault, file, join(home, "b1"));
    const once = readFileSync(file, "utf8");
    expect(importEnvFileSecrets(vault, file, join(home, "b2"))).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe(once);
    expect(existsSync(join(home, "b2"))).toBe(false);
  });

  test("a failure leaves config.env exactly as it was", async () => {
    const home = fresh();
    const vault = await unlockVault({ home, keystore: createMemoryKeyStore(), create: true });
    const file = join(home, "config.env");
    writeFileSync(file, original);
    const realSet = vault.set.bind(vault);
    let calls = 0;
    vault.set = (name: string, value: string) => {
      if (++calls === 2) throw new VaultError("WRITE_FAILED", "disk full");
      realSet(name, value);
    };
    expect(() => importEnvFileSecrets(vault, file, join(home, "b1"))).toThrow(/disk full/);
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  test("export writes the vault's env entries back, and only on request", async () => {
    const home = fresh();
    const vault = await unlockVault({ home, keystore: createMemoryKeyStore(), create: true });
    const file = join(home, "config.env");
    writeFileSync(file, original);
    importEnvFileSecrets(vault, file, join(home, "b1"));
    expect(exportEnvEntries(vault, file)).toBe(2);
    expect(parse(readFileSync(file, "utf8"))).toMatchObject({ GROQ_API_KEY: "gsk_canary_1", GMAIL_APP_PASSWORD: "has space", AGNI_PORT: "9999" });
    // Exporting again replaces the lines instead of repeating them.
    expect(exportEnvEntries(vault, file)).toBe(2);
    expect(readFileSync(file, "utf8").match(/^GROQ_API_KEY=/gm)?.length).toBe(1);
  });

  test("setEnvFileValues replaces, appends, and quotes what needs it", () => {
    const home = fresh();
    const file = join(home, "config.env");
    writeFileSync(file, "A=1\n# c\nB=2\n");
    setEnvFileValues(file, { A: "x y", C: "z#1" });
    expect(readFileSync(file, "utf8")).toBe('A="x y"\n# c\nB=2\nC="z#1"\n');
    expect(() => setEnvFileValues(file, { D: `both ' and "` })).toThrow(VaultError);
  });
});

import { parseEnvFile as parse } from "../src/home";
