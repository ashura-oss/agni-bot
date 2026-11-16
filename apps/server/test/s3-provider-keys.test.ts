/**
 * S3-02: provider keys saved from Settings. File mode writes `config.env` as
 * before; vault mode writes the key to the vault (`env/<VARIABLE>`, the name
 * `applyVaultEnv` reads at start) and never to a plaintext file. Either way the
 * key is registered for redaction. A custom endpoint whose address carries a
 * credential keeps the full address in the vault and only a clean one in
 * `providers.json`.
 * Throwaway home, in-memory keystore.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as redactModule from "../src/util/redact";

// Record what is registered for redaction, and still call the real function (the test double
// forwards, so a test that runs after this one in the same process is not affected).
const registered: string[] = [];
const realRegister = redactModule.registerSecret;
mock.module("../src/util/redact", () => ({
  ...redactModule,
  registerSecret: (value: string) => {
    registered.push(value);
    realRegister(value);
  },
}));

import { HealthTracker } from "../src/models/health";
import { addProviderCredential, setProviderModel } from "../src/models/provider-settings";
import { loadCustomProviders, loadProviders } from "../src/models/providers";
import { Router } from "../src/models/router";
import { VaultError, lockVault, unlockVault, type Vault } from "../src/secrets";

const KEY = "gsk_canary_provider_key_0123456789";
const CUSTOM_KEY = "sk-canary-custom-key-9876543210";
const NAMES = ["AGNI_HOME", "AGNI_PROVIDER_CONFIG_PATH", "AGNI_SECRETS_MODE", "GROQ_API_KEY", "CEREBRAS_API_KEY", "AGNI_CUSTOM_KEY_1", "AGNI_CUSTOM_KEY_2"];
const saved: Record<string, string | undefined> = {};
let home = "";

beforeEach(() => {
  for (const name of NAMES) saved[name] = process.env[name];
  for (const name of NAMES) delete process.env[name];
  lockVault();
  registered.length = 0;
  home = mkdtempSync(join(tmpdir(), "agni-provkeys-"));
  process.env.AGNI_HOME = home;
});
afterEach(() => {
  lockVault();
  for (const name of NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  rmSync(home, { recursive: true, force: true });
});

const router = (): Router => new Router([], new HealthTracker());

async function vaultMode(): Promise<Vault> {
  const vault = await unlockVault({ home, create: true });
  process.env.AGNI_SECRETS_MODE = "vault";
  return vault;
}

/** Every file under `dir`, recursively. */
const filesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? filesUnder(join(dir, name)) : [join(dir, name)]));

/** The plaintext files under the home that contain `needle`. The vault is encrypted, so it never matches. */
const filesContaining = (needle: string): string[] => filesUnder(home).filter((file) => readFileSync(file).includes(needle));

describe("file mode", () => {
  test("the key goes to config.env as before, and is registered for redaction", async () => {
    const result = await addProviderCredential(router(), "groq", KEY);
    expect(result.ok).toBe(true);
    expect(readFileSync(join(home, "config.env"), "utf8")).toContain(KEY);
    expect(process.env.GROQ_API_KEY).toBe(KEY);
    expect(registered).toContain(KEY);
  });
});

describe("vault mode", () => {
  test("a provider key goes to the vault, is live in the router, and is in no plaintext file", async () => {
    const vault = await vaultMode();
    const live = router();
    const result = await addProviderCredential(live, "groq", KEY, "llama-x");
    expect(result.ok).toBe(true);
    expect(live.status().map((provider) => provider.id)).toContain("groq");
    expect(vault.get("env/GROQ_API_KEY")).toBe(KEY);
    expect(process.env.GROQ_API_KEY).toBe(KEY);
    expect(existsSync(join(home, "config.env"))).toBe(false);
    expect(filesContaining(KEY)).toEqual([]);
    expect(registered).toContain(KEY);
  });

  test("a second key is a second vault entry; config.env is never created", async () => {
    const vault = await vaultMode();
    await addProviderCredential(router(), "groq", KEY);
    await addProviderCredential(router(), "cerebras", `${KEY}-b`);
    expect(vault.list("env/").map((entry) => entry.name)).toEqual(["env/CEREBRAS_API_KEY", "env/GROQ_API_KEY"]);
    expect(existsSync(join(home, "config.env"))).toBe(false);
  });

  test("with the vault locked nothing is saved, nothing is applied, and the message holds no key", async () => {
    await vaultMode();
    lockVault();
    const result = await addProviderCredential(router(), "groq", KEY);
    expect(result).toMatchObject({ ok: false, code: "provider_storage" });
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(process.env.GROQ_API_KEY).toBeUndefined();
    expect(filesContaining(KEY)).toEqual([]);
    expect(existsSync(join(home, "config.env"))).toBe(false);
  });

  test("choosing a model still writes providers.json, which holds no secret", async () => {
    await vaultMode();
    const live = router();
    await addProviderCredential(live, "groq", KEY);
    const result = await setProviderModel(live, "groq", "some-model");
    expect(result.ok).toBe(true);
    expect(JSON.parse(readFileSync(join(home, "providers.json"), "utf8")).models.groq).toBe("some-model");
    expect(filesContaining(KEY)).toEqual([]);
  });
});

describe("custom endpoints in vault mode", () => {
  test("the endpoint is in providers.json without a key; the key is in the vault", async () => {
    const vault = await vaultMode();
    const live = router();
    const result = await addProviderCredential(live, "custom", CUSTOM_KEY, "my-model", { baseUrl: "https://gateway.example.com/v1", label: "Gateway" });
    expect(result.ok).toBe(true);
    expect(vault.get("env/AGNI_CUSTOM_KEY_1")).toBe(CUSTOM_KEY);
    expect(loadCustomProviders(process.env)).toMatchObject([{ id: "custom", baseUrl: "https://gateway.example.com/v1", envKey: "AGNI_CUSTOM_KEY_1" }]);
    expect(filesContaining(CUSTOM_KEY)).toEqual([]);
    expect(registered).toContain(CUSTOM_KEY);
  });

  test("an address that carries a credential is kept whole in the vault and cleaned in the file", async () => {
    const vault = await vaultMode();
    const full = "https://user:canary-url-password@gateway.example.com/v1?api_key=canary-url-param";
    const result = await addProviderCredential(router(), "custom", CUSTOM_KEY, "my-model", { baseUrl: full });
    expect(result.ok).toBe(true);
    expect(vault.get("provider-url/custom")).toBe(full);
    const file = readFileSync(join(home, "providers.json"), "utf8");
    expect(file).not.toContain("canary-url-password");
    expect(file).not.toContain("canary-url-param");
    expect(JSON.parse(file).custom[0].baseUrl).toBe("https://gateway.example.com/v1");
    // The router is built from the full address.
    const providers = loadProviders({ ...process.env, AGNI_CUSTOM_KEY_1: CUSTOM_KEY });
    expect(providers.find((provider) => provider.id === "custom")!.baseUrl).toBe(full);
    expect(filesContaining("canary-url-password")).toEqual([]);
  });

  test("an address the owner edited by hand wins over the vault's copy of the old one", async () => {
    await vaultMode();
    await addProviderCredential(router(), "custom", CUSTOM_KEY, "my-model", { baseUrl: "https://user:canary-url-password@gateway.example.com/v1" });
    const path = join(home, "providers.json");
    const file = JSON.parse(readFileSync(path, "utf8"));
    file.custom[0].baseUrl = "https://elsewhere.example.org/v1";
    writeFileSync(path, JSON.stringify(file));
    const providers = loadProviders({ ...process.env, AGNI_CUSTOM_KEY_1: CUSTOM_KEY });
    expect(providers.find((provider) => provider.id === "custom")!.baseUrl).toBe("https://elsewhere.example.org/v1");
  });

  test("with the vault locked the full address is not available and the provider falls back to the clean one", async () => {
    await vaultMode();
    const full = "https://user:canary-url-password@gateway.example.com/v1";
    await addProviderCredential(router(), "custom", CUSTOM_KEY, "my-model", { baseUrl: full });
    lockVault();
    const providers = loadProviders({ ...process.env, AGNI_CUSTOM_KEY_1: CUSTOM_KEY });
    // Never the credentialed address from anywhere but the vault.
    expect(providers.find((provider) => provider.id === "custom")?.baseUrl ?? "").not.toContain("canary-url-password");
  });
});

describe("a key typed by the owner in vault mode is not stored by a failed save", () => {
  test("a refused vault write leaves the live environment as it was", async () => {
    const vault = await vaultMode();
    const original = vault.set.bind(vault);
    vault.set = () => {
      throw new VaultError("WRITE_FAILED", "the vault file could not be written");
    };
    const result = await addProviderCredential(router(), "groq", KEY);
    vault.set = original;
    expect(result).toMatchObject({ ok: false, code: "provider_storage" });
    expect(process.env.GROQ_API_KEY).toBeUndefined();
    expect(filesContaining(KEY)).toEqual([]);
  });
});

describe("file mode: replacement characters in a key", () => {
  test("a key with $& and $' replaces an existing line exactly and leaves the other lines alone", async () => {
    const before = ['# keep this comment', 'OTHER_SETTING="a b"', 'GROQ_API_KEY="old-value"', 'LAST_LINE=1', ""].join("\n");
    writeFileSync(join(home, "config.env"), before);
    const tricky = "gsk_pre$&mid$'post$`end$$tail";
    const result = await addProviderCredential(router(), "groq", tricky);
    expect(result.ok).toBe(true);
    const after = readFileSync(join(home, "config.env"), "utf8");
    expect(after).toBe(['# keep this comment', 'OTHER_SETTING="a b"', `GROQ_API_KEY=${JSON.stringify(tricky)}`, 'LAST_LINE=1', ""].join("\n"));
    expect(process.env.GROQ_API_KEY).toBe(tricky);
  });
});
