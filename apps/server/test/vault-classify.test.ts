/**
 * S3-01 review fix 1 (security V1): the vault uses the shared classifier from
 * `util/secret-names.ts` everywhere it decides "is this a secret?". Unknown
 * names are secret; a URL carrying credentials is secret whatever its name.
 * Throwaway homes only.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHomeEnv, parseEnvFile } from "../src/home";
import { log } from "../src/log";
import { providerKeyEnvNames } from "../src/models/providers";
import { createMemoryKeyStore, lockVault, unlockVault } from "../src/secrets";
import { secretClassifier, valueCarriesCredential } from "../src/secrets/classify";
import { importEnvFileSecrets, plaintextSecretNames } from "../src/secrets/env";
import { unlockVaultAtStart } from "../src/startup/s3-vault";
import { scrubbedShellEnv } from "../src/util/scrubbed-env";

let roots: string[] = [];
const fresh = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "agni-vclass-"));
  roots.push(dir);
  return dir;
};
beforeEach(() => lockVault());
afterEach(() => {
  lockVault();
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  roots = [];
});

/** A home with a providers.json naming one custom endpoint whose key variable has an odd name. */
function homeWithCustomProvider(envKey = "MY_WEIRD_THING"): string {
  const home = fresh();
  writeFileSync(
    join(home, "providers.json"),
    JSON.stringify({ version: 1, custom: [{ id: "custom", label: "Mine", baseUrl: "https://gw.example/v1", model: "m", envKey }] }),
  );
  return home;
}

describe("secretClassifier", () => {
  test("every name the shell scrub removes is a secret here too", () => {
    const home = homeWithCustomProvider("MY_WEIRD_THING");
    const env: Record<string, string> = { AGNI_HOME: home, AGNI_PROVIDER_CONFIG_PATH: join(home, "providers.json") };
    const candidates = [
      ...providerKeyEnvNames(),
      "FOO_API_KEY", "FOO_TOKEN", "FOO_SECRET", "FOO_PASSWORD", "AWS_SECRET_ACCESS_KEY", "SSH_PRIVATE_KEY",
      "AGNI_CUSTOM_KEY_1", "AGNI_CUSTOM_KEY_3", "MY_WEIRD_THING", "gh_token", "NPM_TOKEN",
    ];
    for (const name of candidates) env[name] = "sk-0123456789abcdef";
    env.AGNI_PORT = "8787";
    env.PATH = "/usr/bin";
    const kept = scrubbedShellEnv(env);
    const removed = Object.keys(env).filter((name) => !(name in kept));
    // The scrub really removed the interesting ones (so this test cannot pass vacuously).
    expect(removed).toEqual(expect.arrayContaining(["MY_WEIRD_THING", "AGNI_CUSTOM_KEY_3", "AWS_SECRET_ACCESS_KEY", ...providerKeyEnvNames()]));
    const isSecret = secretClassifier({ env, home });
    for (const name of removed) expect(isSecret(name, env[name]), name).toBe(true);
  });

  test("AGNI_CUSTOM_KEY_3, and a custom provider's own variable, are secrets", () => {
    const home = homeWithCustomProvider("MY_WEIRD_THING");
    const isSecret = secretClassifier({ env: { AGNI_HOME: home }, home });
    expect(isSecret("AGNI_CUSTOM_KEY_3", "x")).toBe(true);
    expect(isSecret("MY_WEIRD_THING", "x")).toBe(true);
  });

  test("a custom provider that reuses a plaintext-safe name still makes that name secret", () => {
    const home = homeWithCustomProvider("AGNI_PORT");
    expect(secretClassifier({ env: { AGNI_HOME: home }, home })("AGNI_PORT", "8787")).toBe(true);
  });

  test("a name nobody has heard of is a secret; known settings stay in config.env", () => {
    const home = fresh();
    const isSecret = secretClassifier({ env: { AGNI_HOME: home }, home });
    expect(isSecret("SOME_NEW_SETTING", "x")).toBe(true);
    expect(isSecret("GOOGLE_OAUTH_CLIENT_ID", "x")).toBe(true);
    for (const name of ["AGNI_SECRETS_MODE", "AGNI_PORT", "AGNI_HOST", "AGNI_MAX_OUTPUT_TOKENS", "AGNI_VAPID_PUBLIC_KEY"]) {
      expect(isSecret(name, "x"), name).toBe(false);
    }
  });

  test("the settings the vault needs in order to open stay in plaintext, whatever their spelling", () => {
    const home = fresh();
    const isSecret = secretClassifier({ env: { AGNI_HOME: home }, home });
    // AGNI_VAULT_PASSPHRASE_FILE has PASSPHRASE in its name: moving it into the vault would lock the vault forever.
    for (const name of ["AGNI_VAULT_PASSPHRASE_FILE", "AGNI_KEYSTORE", "AGNI_SECRETS_MODE", "AGNI_HOME"]) {
      expect(isSecret(name, "/etc/agni/pp"), name).toBe(false);
    }
  });

  test("a URL with a user name or password, or a credential in its query, is secret even under a known name", () => {
    const home = fresh();
    const isSecret = secretClassifier({ env: { AGNI_HOME: home }, home });
    expect(isSecret("AGNI_SEARXNG_URL", "https://searx.example/")).toBe(false);
    expect(isSecret("AGNI_SEARXNG_URL", "https://bob:hunter2@searx.example/")).toBe(true);
    expect(isSecret("AGNI_SEARXNG_URL", "https://bob@searx.example/")).toBe(true);
    for (const query of ["key=abc", "api_key=abc", "token=abc", "access_token=abc", "secret=abc", "password=abc", "sig=abc", "X-Amz-Signature=abc", "a=1&Token=abc"]) {
      expect(isSecret("AGNI_FIRECRAWL_URL", `https://fc.example/v1?${query}`), query).toBe(true);
    }
    expect(isSecret("AGNI_FIRECRAWL_URL", "https://fc.example/v1?region=eu&page=2")).toBe(false);
    // Not a URL: an @ sign alone proves nothing.
    expect(isSecret("AGNI_USER_FIRST_NAME", "ann@home")).toBe(false);
    expect(valueCarriesCredential("not a url ? key=1")).toBe(false);
  });
});

describe("loadHomeEnv in vault mode", () => {
  test("unknown names, custom provider variables and credential URLs are not loaded from config.env; known settings are", () => {
    const home = homeWithCustomProvider("MY_WEIRD_THING");
    writeFileSync(
      join(home, "config.env"),
      [
        "AGNI_PORT=9999",
        "AGNI_CUSTOM_KEY_3=ck3",
        "MY_WEIRD_THING=weird",
        "UNHEARD_OF=unheard",
        "AWS_SECRET_ACCESS_KEY=aws",
        "AGNI_SEARXNG_URL=https://u:p@searx.example/",
        "AGNI_FIRECRAWL_URL=https://fc.example/",
        "",
      ].join("\n"),
    );
    const env: Record<string, string | undefined> = { AGNI_HOME: home, AGNI_SECRETS_MODE: "vault" };
    loadHomeEnv(env);
    expect(env.AGNI_PORT).toBe("9999");
    expect(env.AGNI_FIRECRAWL_URL).toBe("https://fc.example/");
    for (const name of ["AGNI_CUSTOM_KEY_3", "MY_WEIRD_THING", "UNHEARD_OF", "AWS_SECRET_ACCESS_KEY", "AGNI_SEARXNG_URL"]) {
      expect(env[name], name).toBeUndefined();
    }
  });

  test("AGNI_SECRETS_MODE written in config.env still switches the mode (it is not hidden by the classifier)", () => {
    const home = fresh();
    writeFileSync(join(home, "config.env"), "AGNI_SECRETS_MODE=vault\nUNHEARD_OF=x\n");
    const env: Record<string, string | undefined> = { AGNI_HOME: home };
    loadHomeEnv(env);
    expect(env.AGNI_SECRETS_MODE).toBe("vault");
    expect(env.UNHEARD_OF).toBeUndefined();
  });
});

describe("moving config.env into the vault", () => {
  const original = [
    "# settings",
    "AGNI_PORT=9999",
    "AGNI_CUSTOM_KEY_3=canary-ck3",
    "MY_WEIRD_THING=canary-weird",
    "UNHEARD_OF=canary-unheard",
    "AGNI_SEARXNG_URL=https://u:canary-pw@searx.example/",
    "AGNI_FIRECRAWL_URL=https://fc.example/",
    "",
  ].join("\n");

  test("unknown names, custom provider variables and credential URLs move into the vault; known settings stay", async () => {
    const home = homeWithCustomProvider("MY_WEIRD_THING");
    const vault = await unlockVault({ home, keystore: createMemoryKeyStore(), create: true });
    const file = join(home, "config.env");
    writeFileSync(file, original);
    const moved = importEnvFileSecrets(vault, file);
    expect(moved.sort()).toEqual(["AGNI_CUSTOM_KEY_3", "AGNI_SEARXNG_URL", "MY_WEIRD_THING", "UNHEARD_OF"]);
    expect(vault.get("env/MY_WEIRD_THING")).toBe("canary-weird");
    expect(vault.get("env/AGNI_SEARXNG_URL")).toBe("https://u:canary-pw@searx.example/");
    const after = readFileSync(file, "utf8");
    expect(after).not.toContain("canary");
    expect(parseEnvFile(after)).toEqual({ AGNI_PORT: "9999", AGNI_FIRECRAWL_URL: "https://fc.example/" });
  });

  test("the plaintext warning lists those names, never values", async () => {
    const home = homeWithCustomProvider("MY_WEIRD_THING");
    writeFileSync(join(home, "config.env"), original);
    const warn = spyOn(log, "warn").mockImplementation(() => {});
    try {
      const env: Record<string, string | undefined> = { AGNI_SECRETS_MODE: "vault" };
      await unlockVaultAtStart({ home, env });
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]?.[0]);
      for (const name of ["AGNI_CUSTOM_KEY_3", "MY_WEIRD_THING", "UNHEARD_OF", "AGNI_SEARXNG_URL"]) expect(message).toContain(name);
      expect(message).not.toContain("AGNI_PORT");
      expect(message).not.toContain("canary");
    } finally {
      warn.mockRestore();
    }
    expect(plaintextSecretNames(join(home, "config.env")).sort()).toEqual(["AGNI_CUSTOM_KEY_3", "AGNI_SEARXNG_URL", "MY_WEIRD_THING", "UNHEARD_OF"]);
  });
});
