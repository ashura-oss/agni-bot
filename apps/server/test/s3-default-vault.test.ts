/**
 * Round 12: the vault is the default for a fresh install. `agni setup` decides (and records) the secrets mode of a
 * home that has none; a home that already has one, or already holds data, keeps what it has. `agni doctor` reports
 * which mode is active and which keystore backs it. Throwaway homes, in-memory or passphrase keystores only: nothing
 * here may reach the real credential store.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanChildEnv } from "./test-child-env";
import { chooseSecretsMode, prepareHome } from "../src/cli/s3-setup";
import { runDoctor } from "../src/cli/s3-doctor";
import { s3Commands } from "../src/cli/s3-commands";
import { probeKeyStore } from "../src/secrets/probe";
import { homeIsFresh, recordedSecretsMode } from "../src/secrets/setup-mode";
import { VaultError, createMemoryKeyStore, lockVault, setKeyStoreOverride, vaultExists, type KeyStore } from "../src/secrets";
import { isOwnerOnlyFile } from "../src/util/private-file";
import { unlockVaultAtStart, vaultRefusalMessage } from "../src/startup/s3-vault";

const ENTRY = resolve(import.meta.dir, "../src/index.ts");
const ENV_EXAMPLE = resolve(import.meta.dir, "../../../infra/env.example");
const PASSPHRASE = "correct horse battery staple";

let roots: string[] = [];
const fresh = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "agni-dvault-"));
  roots.push(dir);
  return dir;
};
beforeEach(() => {
  lockVault();
  setKeyStoreOverride(createMemoryKeyStore());
  process.exitCode = 0;
});
afterEach(() => {
  lockVault();
  process.exitCode = 0;
  for (const dir of roots) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  roots = [];
});

/** A credential store that cannot be used, as on a headless Linux box with no Secret Service. */
const unavailableKeyStore = (): KeyStore => {
  const fail = async (): Promise<never> => {
    throw new VaultError("KEYSTORE_UNAVAILABLE", "The operating system's credential store could not be used (no Secret Service is running). Start one.");
  };
  return { kind: "bun-secrets", open: fail, create: fail, remove: async () => {} };
};

/** A keystore that fails the test when anything touches it. */
const forbiddenKeyStore = (): KeyStore => {
  const fail = async (): Promise<never> => {
    throw new Error("the keystore must not be touched");
  };
  return { kind: "memory", open: fail, create: fail, remove: fail };
};

const configOf = (home: string): string => readFileSync(join(home, "config.env"), "utf8");

describe("homeIsFresh and recordedSecretsMode", () => {
  test("an empty folder, and one with only the template config.env, are fresh", () => {
    const home = fresh();
    expect(homeIsFresh(home, {})).toBe(true);
    writeFileSync(join(home, "config.env"), readFileSync(ENV_EXAMPLE, "utf8"));
    expect(homeIsFresh(home, {})).toBe(true);
  });

  test("a vault, a database, a plaintext credential, plugins or a recorded mode each make a home not fresh", () => {
    const withFile = (relative: string, contents = "x"): string => {
      const home = fresh();
      mkdirSync(join(home, relative, ".."), { recursive: true });
      writeFileSync(join(home, relative), contents);
      return home;
    };
    expect(homeIsFresh(withFile("vault.bin"), {})).toBe(false);
    expect(homeIsFresh(withFile("data/agni.sqlite"), {})).toBe(false);
    expect(homeIsFresh(withFile("agni.sqlite"), {})).toBe(false);
    expect(homeIsFresh(withFile("plugins.json", "{}"), {})).toBe(false);
    expect(homeIsFresh(withFile("providers.json", "{}"), {})).toBe(false);
    expect(homeIsFresh(withFile("config.env", "GROQ_API_KEY=gsk_something_long_enough_123\n"), {})).toBe(false);
    expect(homeIsFresh(withFile("config.env", "AGNI_SECRETS_MODE=file\n"), {})).toBe(false);
  });

  test("the recorded mode comes from the environment first, then config.env, else nothing", () => {
    const home = fresh();
    expect(recordedSecretsMode(home, {})).toBeUndefined();
    writeFileSync(join(home, "config.env"), "AGNI_SECRETS_MODE=file\n");
    expect(recordedSecretsMode(home, {})).toEqual({ mode: "file", source: "config.env" });
    expect(recordedSecretsMode(home, { AGNI_SECRETS_MODE: "vault" })).toEqual({ mode: "vault", source: "environment" });
  });
});

describe("chooseSecretsMode: a fresh home", () => {
  test("starts in vault mode: the vault is made, the mode is recorded, and the message names the mode and the backend", async () => {
    const home = fresh();
    const result = await chooseSecretsMode({ home, env: {} });
    expect(result.mode).toBe("vault");
    expect(result.reason).toBe("fresh");
    expect(vaultExists({ home })).toBe(true);
    expect(configOf(home)).toMatch(/^AGNI_SECRETS_MODE=vault$/m);
    expect(result.message).toContain("secrets mode: vault");
    expect(result.message).toContain(join(home, "vault.bin"));
  });

  test("with no keystore: file mode, owner-only config.env, and a message saying why and how to enable the vault later", async () => {
    const home = fresh();
    const result = await chooseSecretsMode({ home, env: {}, keystore: unavailableKeyStore(), platform: "linux", now: new Date("2026-11-17T10:00:00Z") });
    expect(result.mode).toBe("file");
    expect(result.reason).toBe("keystore-unavailable");
    expect(vaultExists({ home })).toBe(false);
    // printed: the mode, the reason, and the way to the vault, in two sentences
    expect(result.message).toContain("secrets mode: file");
    expect(result.message).toContain("no Secret Service is running");
    expect(result.message).toContain("agni vault migrate");
    expect(result.message).toMatch(/passphrase|Secret Service|keyring/i);
    expect(result.message.split(/(?<=\.)\s+/).length).toBe(2);
    // recorded: the mode, and the reason with the date
    const config = configOf(home);
    expect(config).toMatch(/^AGNI_SECRETS_MODE=file$/m);
    expect(config).toContain("2026-11-17");
    expect(config).toContain("no Secret Service is running");
    // private
    if (process.platform !== "win32") expect(statSync(join(home, "config.env")).mode & 0o777).toBe(0o600);
    expect(isOwnerOnlyFile(join(home, "config.env"))).toBe(true);
  });

  test("a missing passphrase counts as no keystore", async () => {
    const home = fresh();
    const missing: KeyStore = {
      kind: "passphrase",
      open: async () => { throw new VaultError("PASSPHRASE_MISSING", "The vault needs a passphrase to unlock and none was provided."); },
      create: async () => { throw new VaultError("PASSPHRASE_MISSING", "The vault needs a passphrase to unlock and none was provided."); },
      remove: async () => {},
    };
    const result = await chooseSecretsMode({ home, env: {}, keystore: missing, platform: "linux" });
    expect(result.mode).toBe("file");
    expect(result.message).toContain("passphrase");
  });

  test("a failure that is not about the keystore being unavailable is an error, not a downgrade", async () => {
    const home = fresh();
    const broken: KeyStore = {
      kind: "bun-secrets",
      open: async () => null,
      create: async () => { throw new VaultError("DATA_KEY_MISSING", "the credential store is damaged"); },
      remove: async () => {},
    };
    await expect(chooseSecretsMode({ home, env: {}, keystore: broken })).rejects.toThrow("damaged");
    expect(existsSync(join(home, "config.env"))).toBe(false);
  });

  test("a mistyped AGNI_KEYSTORE is an error, not a downgrade", async () => {
    const home = fresh();
    await expect(chooseSecretsMode({ home, env: { AGNI_KEYSTORE: "keychain" } })).rejects.toThrow("AGNI_KEYSTORE");
    expect(existsSync(join(home, "config.env"))).toBe(false);
  });
});

describe("chooseSecretsMode: a home that already has a mode or data", () => {
  test("a recorded file mode is kept, and nothing is touched", async () => {
    const home = fresh();
    const text = "AGNI_SECRETS_MODE=file\nGROQ_API_KEY=gsk_something_long_enough_123\n";
    writeFileSync(join(home, "config.env"), text);
    const result = await chooseSecretsMode({ home, env: {}, keystore: forbiddenKeyStore() });
    expect(result.mode).toBe("file");
    expect(result.reason).toBe("recorded");
    expect(configOf(home)).toBe(text);
    expect(vaultExists({ home })).toBe(false);
    expect(result.message).toContain("agni vault migrate");
  });

  test("a recorded vault mode is kept, and nothing is touched", async () => {
    const home = fresh();
    writeFileSync(join(home, "config.env"), "AGNI_SECRETS_MODE=vault\n");
    const result = await chooseSecretsMode({ home, env: {}, keystore: forbiddenKeyStore() });
    expect(result.mode).toBe("vault");
    expect(result.reason).toBe("recorded");
    expect(configOf(home)).toBe("AGNI_SECRETS_MODE=vault\n");
  });

  test("a mode set in the environment is kept, and nothing is written", async () => {
    const home = fresh();
    const result = await chooseSecretsMode({ home, env: { AGNI_SECRETS_MODE: "file" }, keystore: forbiddenKeyStore() });
    expect(result.mode).toBe("file");
    expect(result.reason).toBe("recorded");
    expect(existsSync(join(home, "config.env"))).toBe(false);
  });

  test("an install that predates the vault (plaintext keys, no mode recorded) stays in file mode, byte for byte", async () => {
    const home = fresh();
    const text = "GROQ_API_KEY=gsk_something_long_enough_123\n# my notes\nAGNI_PORT=9000\n";
    writeFileSync(join(home, "config.env"), text);
    const result = await chooseSecretsMode({ home, env: {}, keystore: forbiddenKeyStore() });
    expect(result.mode).toBe("file");
    expect(result.reason).toBe("existing");
    expect(configOf(home)).toBe(text);
    expect(vaultExists({ home })).toBe(false);
    expect(result.message).toContain("agni vault migrate");
  });

  test("a database with no credentials in config.env is still an existing install", async () => {
    const home = fresh();
    mkdirSync(join(home, "data"));
    writeFileSync(join(home, "data", "agni.sqlite"), "");
    const result = await chooseSecretsMode({ home, env: {}, keystore: forbiddenKeyStore() });
    expect(result.mode).toBe("file");
    expect(result.reason).toBe("existing");
  });
});

describe("prepareHome (what `agni setup` does before it starts anything)", () => {
  test("a fresh home gets config.env from the template, the vault, and the recorded mode", async () => {
    const home = fresh();
    const result = await prepareHome({ home, env: {}, envExample: ENV_EXAMPLE });
    expect(result.created).toBe(true);
    expect(result.secrets.mode).toBe("vault");
    const config = configOf(home);
    expect(config).toContain("AGNI_PORT=8787");
    expect(config).toMatch(/^AGNI_SECRETS_MODE=vault$/m);
    expect(isOwnerOnlyFile(join(home, "config.env"))).toBe(true);
  });

  test("with no keystore the same call ends in file mode with an owner-only config.env", async () => {
    const home = fresh();
    const result = await prepareHome({ home, env: {}, envExample: ENV_EXAMPLE, keystore: unavailableKeyStore() });
    expect(result.secrets.mode).toBe("file");
    expect(configOf(home)).toMatch(/^AGNI_SECRETS_MODE=file$/m);
    expect(isOwnerOnlyFile(join(home, "config.env"))).toBe(true);
  });

  test("a second run changes nothing", async () => {
    const home = fresh();
    await prepareHome({ home, env: {}, envExample: ENV_EXAMPLE });
    const before = configOf(home);
    const again = await prepareHome({ home, env: {}, envExample: ENV_EXAMPLE, keystore: forbiddenKeyStore() });
    expect(again.created).toBe(false);
    expect(again.secrets.reason).toBe("recorded");
    expect(configOf(home)).toBe(before);
  });
});

describe("a server in vault mode whose keystore goes away (unchanged: it fails closed)", () => {
  test("start refuses with the keystore's reason and does not read plaintext keys instead", async () => {
    const home = fresh();
    await chooseSecretsMode({ home, env: {} });
    expect(configOf(home)).toMatch(/^AGNI_SECRETS_MODE=vault$/m);
    // The machine loses its credential store, and someone leaves a plaintext key in config.env.
    setKeyStoreOverride({ ...unavailableKeyStore(), kind: "memory" });
    writeFileSync(join(home, "config.env"), `${configOf(home)}GROQ_API_KEY=gsk_something_long_enough_123
`);
    const env: Record<string, string | undefined> = { AGNI_SECRETS_MODE: "vault" };
    const error = await unlockVaultAtStart({ home, env }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VaultError);
    expect((error as VaultError).code).toBe("KEYSTORE_UNAVAILABLE");
    expect(vaultRefusalMessage(error)).toContain("does not fall back to plaintext");
    expect(env.GROQ_API_KEY).toBeUndefined();
  });
});

describe("probeKeyStore", () => {
  test("a working keystore reports its kind and backend", async () => {
    const probe = await probeKeyStore({ env: {} });
    expect(probe.available).toBe(true);
    if (probe.available) expect(probe.kind).toBe("memory");
  });

  test("an unavailable one reports why, and does not throw", async () => {
    const probe = await probeKeyStore({ env: {}, keystore: unavailableKeyStore() });
    expect(probe.available).toBe(false);
    if (!probe.available) expect(probe.reason).toContain("no Secret Service is running");
  });

  test("the passphrase backend without a passphrase file is unavailable", async () => {
    setKeyStoreOverride(null);
    const probe = await probeKeyStore({ env: { AGNI_KEYSTORE: "passphrase" } });
    expect(probe.available).toBe(false);
    if (!probe.available) expect(probe.code).toBe("PASSPHRASE_MISSING");
  });
});

describe("agni doctor", () => {
  const text = (lines: string[]): string => lines.join("\n");

  test("vault mode: says so, names the keystore backend, and warns about nothing", async () => {
    const home = fresh();
    writeFileSync(join(home, "config.env"), "AGNI_SECRETS_MODE=vault\n");
    const report = await runDoctor({ home, env: {} });
    expect(text(report.lines)).toMatch(/secrets mode:\s+vault/);
    expect(text(report.lines)).toContain("recorded in config.env");
    expect(text(report.lines)).toMatch(/keystore:\s+memory/);
    expect(text(report.lines)).not.toContain("warning");
    expect(report.ok).toBe(true);
  });

  test("file mode where the vault would work: warns, and names the command", async () => {
    const home = fresh();
    writeFileSync(join(home, "config.env"), "GROQ_API_KEY=gsk_something_long_enough_123\n");
    const report = await runDoctor({ home, env: {} });
    const out = text(report.lines);
    expect(out).toMatch(/secrets mode:\s+file/);
    expect(out).toContain("warning: file mode is active, but the vault would work on this machine");
    expect(out).toContain("agni vault migrate");
    expect(out).toContain("GROQ_API_KEY");
    expect(out).not.toContain("gsk_something_long_enough_123");
    expect(report.ok).toBe(true);
  });

  test("file mode where there is no keystore: shows why none, and does not warn", async () => {
    const home = fresh();
    writeFileSync(join(home, "config.env"), "AGNI_SECRETS_MODE=file\n");
    const report = await runDoctor({ home, env: {}, keystore: unavailableKeyStore() });
    const out = text(report.lines);
    expect(out).toMatch(/keystore:\s+none/);
    expect(out).toContain("no Secret Service is running");
    expect(out).not.toContain("warning");
    expect(report.ok).toBe(true);
  });

  test("vault mode where the keystore is gone: an error, and the report is not ok", async () => {
    const home = fresh();
    writeFileSync(join(home, "config.env"), "AGNI_SECRETS_MODE=vault\n");
    const report = await runDoctor({ home, env: {}, keystore: unavailableKeyStore() });
    const out = text(report.lines);
    expect(out).toMatch(/keystore:\s+none/);
    expect(out).toContain("error: vault mode is active but the keystore is not available");
    expect(report.ok).toBe(false);
  });

  test("a mode no one recorded is shown as file, with the reason", async () => {
    const home = fresh();
    mkdirSync(join(home, "data"));
    writeFileSync(join(home, "data", "agni.sqlite"), "");
    const report = await runDoctor({ home, env: {} });
    expect(text(report.lines)).toMatch(/secrets mode:\s+file \(no mode recorded/);
  });

  test("the command is registered, listed in help, and sets a failing exit code when the report is not ok", async () => {
    expect(Object.keys(s3Commands.commands)).toContain("doctor");
    expect(s3Commands.help.join("\n")).toContain("doctor");
  });
});

describe("the agni command line, with the passphrase keystore (no credential store is touched)", () => {
  async function agni(home: string, parent: string, args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; out: string }> {
    const child = Bun.spawn([process.execPath, ENTRY, ...args], {
      cwd: tmpdir(),
      env: cleanChildEnv({ AGNI_HOME: home, AGNI_KEYSTORE: "passphrase", ...extraEnv }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code: await child.exited, out: out + err };
  }

  test("doctor on a home in vault mode with a passphrase keystore", async () => {
    const parent = fresh();
    const home = join(parent, "home");
    mkdirSync(home);
    writeFileSync(join(home, "config.env"), "AGNI_SECRETS_MODE=vault\n");
    writeFileSync(join(parent, "pp.txt"), PASSPHRASE, { mode: 0o600 });
    const { code, out } = await agni(home, parent, ["doctor"], { AGNI_VAULT_PASSPHRASE_FILE: join(parent, "pp.txt") });
    expect(out).toMatch(/secrets mode:\s+vault/);
    expect(out).toMatch(/keystore:\s+passphrase/);
    expect(code).toBe(0);
  });

  test("doctor on a vault-mode home whose passphrase is missing fails, and says why", async () => {
    const parent = fresh();
    const home = join(parent, "home");
    mkdirSync(home);
    writeFileSync(join(home, "config.env"), "AGNI_SECRETS_MODE=vault\n");
    const { code, out } = await agni(home, parent, ["doctor"]);
    expect(out).toMatch(/keystore:\s+none/);
    expect(out).toContain("error: vault mode is active but the keystore is not available");
    expect(code).toBe(1);
  });

  test("setup --prepare-only on a fresh home chooses the vault, records it, and starts nothing", async () => {
    const parent = fresh();
    const home = join(parent, "home");
    writeFileSync(join(parent, "pp.txt"), PASSPHRASE, { mode: 0o600 });
    const { code, out } = await agni(home, parent, ["setup", "--prepare-only"], { AGNI_VAULT_PASSPHRASE_FILE: join(parent, "pp.txt") });
    expect(out).toContain("secrets mode: vault");
    expect(code).toBe(0);
    expect(existsSync(join(home, "vault.bin"))).toBe(true);
    expect(configOf(home)).toMatch(/^AGNI_SECRETS_MODE=vault$/m);
    expect(existsSync(join(home, "run"))).toBe(false);
    expect(existsSync(join(home, "logs"))).toBe(false);
  });

  test("setup --prepare-only with no passphrase prints the file-mode message and records it", async () => {
    const parent = fresh();
    const home = join(parent, "home");
    const { code, out } = await agni(home, parent, ["setup", "--prepare-only"]);
    expect(out).toContain("secrets mode: file");
    expect(out).toContain("agni vault migrate");
    expect(code).toBe(0);
    expect(existsSync(join(home, "vault.bin"))).toBe(false);
    expect(configOf(home)).toMatch(/^AGNI_SECRETS_MODE=file$/m);
    expect(isOwnerOnlyFile(join(home, "config.env"))).toBe(true);
  });

  test("doctor after that setup shows the mode setup recorded", async () => {
    const parent = fresh();
    const home = join(parent, "home");
    await agni(home, parent, ["setup", "--prepare-only"]);
    const { out } = await agni(home, parent, ["doctor"]);
    expect(out).toMatch(/secrets mode:\s+file/);
    expect(out).toContain("recorded in config.env");
    expect(out).not.toContain("warning");
  });
});
