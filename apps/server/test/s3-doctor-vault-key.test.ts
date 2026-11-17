/**
 * Round 13: `agni doctor` says "ok" only when the server can unlock the vault, and a start-up that finds a vault but
 * no recorded mode says so. Throwaway homes, in-memory or passphrase keystores only (a small scrypt cost): nothing
 * here may reach the real credential store.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor } from "../src/cli/s3-doctor";
import { passphraseFileFromUnit } from "../src/service";
import { secureFile } from "../src/util/private-file";
import { unlockVaultAtStart } from "../src/startup/s3-vault";
import { VaultError, createMemoryKeyStore, createPassphraseKeyStore, lockVault, setKeyStoreOverride, unlockVault, type KeyStore } from "../src/secrets";

const PASSPHRASE = "correct horse battery staple";
const OTHER_PASSPHRASE = "a different long passphrase";

let roots: string[] = [];
const fresh = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "agni-dvkey-"));
  roots.push(dir);
  return dir;
};
beforeEach(() => {
  lockVault();
  setKeyStoreOverride(createMemoryKeyStore());
});
afterEach(() => {
  lockVault();
  setKeyStoreOverride(null);
  for (const dir of roots) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  roots = [];
});

/** A stand-in for the operating system's credential store: it keeps keys in memory but says it is `bun-secrets`. */
const osStyleKeyStore = (): KeyStore => ({ ...createMemoryKeyStore(), kind: "bun-secrets" });

/** A credential store that cannot be used, as on a headless Linux box with no Secret Service. */
const unavailableKeyStore = (): KeyStore => {
  const fail = async (): Promise<never> => {
    throw new VaultError("KEYSTORE_UNAVAILABLE", "The operating system's credential store could not be used (no Secret Service is running).");
  };
  return { kind: "bun-secrets", open: fail, create: fail, remove: async () => {} };
};

const passphraseStore = (passphrase: string | undefined): KeyStore =>
  createPassphraseKeyStore({ passphrase: () => passphrase, cost: { N: 1024, r: 8, p: 1 } });

/** Make a vault in `home` as `agni setup` leaves it: written, then closed. */
async function makeVault(home: string, keystore?: KeyStore): Promise<void> {
  await unlockVault({ home, env: {}, create: true, keystore });
  lockVault();
}

const config = (home: string, text: string): void => writeFileSync(join(home, "config.env"), text);
const text = (lines: string[]): string => lines.join("\n");

describe("agni doctor: the vault's own key (the report is ok only when the server can unlock)", () => {
  test("a vault whose key is not in the credential store is an error", async () => {
    const home = fresh();
    config(home, "AGNI_SECRETS_MODE=vault\n");
    await makeVault(home, osStyleKeyStore());
    // The credential store works and answers; it just has no key for this vault (another account, a deleted entry).
    const report = await runDoctor({ home, env: {}, keystore: osStyleKeyStore() });
    const out = text(report.lines);
    expect(out).toMatch(/vault key:\s+cannot unlock \(DATA_KEY_MISSING\)/);
    expect(out).toContain("the server will refuse to start");
    expect(report.ok).toBe(false);
  });

  test("a vault the keystore can open is ok, and the report says so", async () => {
    const home = fresh();
    config(home, "AGNI_SECRETS_MODE=vault\n");
    const store = osStyleKeyStore();
    await makeVault(home, store);
    const report = await runDoctor({ home, env: {}, keystore: store });
    expect(text(report.lines)).toMatch(/vault key:\s+can unlock/);
    expect(report.ok).toBe(true);
  });

  test("file mode with a vault.bin and no keystore is not ok: the server refuses to start", async () => {
    const home = fresh();
    config(home, "AGNI_SECRETS_MODE=file\n");
    await makeVault(home, osStyleKeyStore());
    const report = await runDoctor({ home, env: {}, keystore: unavailableKeyStore() });
    const out = text(report.lines);
    expect(out).toMatch(/vault key:\s+cannot unlock \(KEYSTORE_UNAVAILABLE\)/);
    expect(out).toContain("the server will refuse to start");
    expect(report.ok).toBe(false);
  });

  test("file mode with no vault.bin and no keystore stays ok", async () => {
    const home = fresh();
    config(home, "AGNI_SECRETS_MODE=file\n");
    const report = await runDoctor({ home, env: {}, keystore: unavailableKeyStore() });
    expect(report.ok).toBe(true);
    expect(text(report.lines)).not.toContain("vault key:");
  });

  test("a passphrase that does not open the vault is an error; the right one is ok", async () => {
    const home = fresh();
    config(home, "AGNI_SECRETS_MODE=vault\n");
    await makeVault(home, passphraseStore(PASSPHRASE));
    const wrong = await runDoctor({ home, env: {}, keystore: passphraseStore(OTHER_PASSPHRASE) });
    expect(text(wrong.lines)).toMatch(/vault key:\s+cannot unlock \(PASSPHRASE_REJECTED\)/);
    expect(wrong.ok).toBe(false);
    const right = await runDoctor({ home, env: {}, keystore: passphraseStore(PASSPHRASE) });
    expect(text(right.lines)).toMatch(/vault key:\s+can unlock/);
    expect(right.ok).toBe(true);
  });

  test("the check writes nothing: the vault, the folder and the key store are as they were", async () => {
    const home = fresh();
    config(home, "AGNI_SECRETS_MODE=vault\n");
    const store = createMemoryKeyStore();
    await makeVault(home, store);
    const bytes = readFileSync(join(home, "vault.bin"));
    const stamp = statSync(join(home, "vault.bin")).mtimeMs;
    const names = readdirSync(home).sort();
    const keys = store.size();
    const report = await runDoctor({ home, env: {}, keystore: store });
    expect(report.ok).toBe(true);
    expect(readFileSync(join(home, "vault.bin")).equals(bytes)).toBe(true);
    expect(statSync(join(home, "vault.bin")).mtimeMs).toBe(stamp);
    expect(readdirSync(home).sort()).toEqual(names);
    expect(store.size()).toBe(keys);
  });

  test("no secret value is printed", async () => {
    const home = fresh();
    config(home, "AGNI_SECRETS_MODE=vault\n");
    const store = createMemoryKeyStore();
    await unlockVault({ home, env: {}, create: true, keystore: store }).then((vault) => vault.set("env/GROQ_API_KEY", "gsk_vault_value_long_enough_123"));
    lockVault();
    const report = await runDoctor({ home, env: {}, keystore: store });
    expect(text(report.lines)).not.toContain("gsk_vault_value_long_enough_123");
  });
});

describe("agni doctor: a headless server whose service is given the passphrase as a systemd credential", () => {
  const unit = (file?: string): string =>
    ["[Service]", 'ExecStart="/usr/bin/bun" "/opt/agni/index.ts" serve', ...(file ? [`LoadCredential=agni-vault-passphrase:${file}`] : []), "Restart=always", ""].join("\n");

  async function headless(): Promise<{ home: string; parent: string; passphraseFile: string }> {
    const parent = fresh();
    const home = join(parent, "home");
    mkdirSync(home);
    config(home, "AGNI_SECRETS_MODE=vault\n");
    await makeVault(home, passphraseStore(PASSPHRASE));
    const passphraseFile = join(parent, "pp.txt");
    writeFileSync(passphraseFile, PASSPHRASE, { mode: 0o600 });
    secureFile(passphraseFile);
    return { home, parent, passphraseFile };
  }
  // No test keystore: the passphrase keystore reads the file for real.
  beforeEach(() => setKeyStoreOverride(null));

  test("the passphrase file is read from the installed unit when this shell has none, and the vault is checked with it", async () => {
    const { home, parent, passphraseFile } = await headless();
    const unitPath = join(parent, "agni.service");
    writeFileSync(unitPath, unit(passphraseFile));
    const report = await runDoctor({ home, env: {}, platform: "linux", unitPath });
    const out = text(report.lines);
    expect(out).toMatch(/vault key:\s+can unlock/);
    expect(out).toContain("installed service unit");
    expect(report.ok).toBe(true);
  });

  test("a wrong passphrase in the unit's file is still an error", async () => {
    const { home, parent } = await headless();
    const bad = join(parent, "bad.txt");
    writeFileSync(bad, OTHER_PASSPHRASE, { mode: 0o600 });
    secureFile(bad);
    const unitPath = join(parent, "agni.service");
    writeFileSync(unitPath, unit(bad));
    const report = await runDoctor({ home, env: {}, platform: "linux", unitPath });
    expect(text(report.lines)).toMatch(/vault key:\s+cannot unlock \(PASSPHRASE_REJECTED\)/);
    expect(report.ok).toBe(false);
  });

  test("an installed unit that passes no passphrase is an error: the service could not unlock", async () => {
    const { home, parent } = await headless();
    const unitPath = join(parent, "agni.service");
    writeFileSync(unitPath, unit());
    const report = await runDoctor({ home, env: {}, platform: "linux", unitPath });
    const out = text(report.lines);
    expect(out).toContain("LoadCredential=");
    expect(out).toContain("the server will refuse to start");
    expect(report.ok).toBe(false);
  });

  test("with no unit and no passphrase file in this shell, it says it cannot check from here and does not fail", async () => {
    const { home, parent } = await headless();
    const report = await runDoctor({ home, env: {}, platform: "linux", unitPath: join(parent, "no-such.service") });
    const out = text(report.lines);
    expect(out).toMatch(/vault key:\s+not checked from this shell/);
    expect(out).toContain("LoadCredential=");
    expect(out).not.toContain("will refuse to start");
    expect(report.ok).toBe(true);
  });

  test("a passphrase file named in this shell is used, with or without a unit", async () => {
    const { home, parent, passphraseFile } = await headless();
    const report = await runDoctor({ home, env: { AGNI_VAULT_PASSPHRASE_FILE: passphraseFile }, platform: "linux", unitPath: join(parent, "no-such.service") });
    expect(text(report.lines)).toMatch(/vault key:\s+can unlock/);
    expect(report.ok).toBe(true);
  });

  test("passphraseFileFromUnit reads the credential line the unit writer makes, and nothing else", () => {
    expect(passphraseFileFromUnit(unit("/home/me/pp.txt"))).toBe("/home/me/pp.txt");
    expect(passphraseFileFromUnit("[Service]\nLoadCredential=agni-vault-passphrase:/srv/100%%/pp\n")).toBe("/srv/100%/pp");
    expect(passphraseFileFromUnit(unit())).toBeUndefined();
    expect(passphraseFileFromUnit("LoadCredential=other-thing:/x\n")).toBeUndefined();
  });
});

describe("a vault.bin with no recorded mode", () => {
  test("doctor warns, and still reports ok", async () => {
    const home = fresh();
    const store = createMemoryKeyStore();
    await makeVault(home, store);
    const report = await runDoctor({ home, env: {}, keystore: store });
    const out = text(report.lines);
    expect(out).toContain("warning: vault.bin exists but no secrets mode is recorded");
    expect(out).toContain("AGNI_SECRETS_MODE=vault");
    expect(report.ok).toBe(true);
  });

  test("doctor does not warn when a mode is recorded", async () => {
    const home = fresh();
    config(home, "AGNI_SECRETS_MODE=file\n");
    const store = createMemoryKeyStore();
    await makeVault(home, store);
    const report = await runDoctor({ home, env: {}, keystore: store });
    expect(text(report.lines)).not.toContain("no secrets mode is recorded");
  });

  test("start-up warns once in the log, and not when a mode is recorded", async () => {
    const home = fresh();
    await makeVault(home);
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await unlockVaultAtStart({ home, env: {} });
      expect(spy.mock.calls.map((call) => call.join(" ")).filter((line) => line.includes("vault.bin exists but no secrets mode is recorded")).length).toBe(1);
      lockVault();
      spy.mockClear();
      await unlockVaultAtStart({ home, env: { AGNI_SECRETS_MODE: "file" } });
      expect(spy.mock.calls.map((call) => call.join(" ")).filter((line) => line.includes("no secrets mode is recorded")).length).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(existsSync(join(home, "vault.bin"))).toBe(true);
  });
});
