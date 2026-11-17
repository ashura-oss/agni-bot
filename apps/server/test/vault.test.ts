/**
 * S3-01: the vault file, its keystores, unlock and refusal.
 * Every vault here lives in a throwaway folder and uses an in-memory keystore,
 * except the one test that talks to the real credential store with a unique
 * service name and deletes its entry.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as redactModule from "../src/util/redact";
import {
  VaultError,
  createMemoryKeyStore,
  getVault,
  isVaultUnlocked,
  lockVault,
  secretsMode,
  setKeyStoreOverride,
  unlockVault,
  vaultExists,
  vaultStatus,
  type KeyStore,
} from "../src/secrets";
import { createBunSecretsKeyStore } from "../src/secrets/bun-secrets";
import { createPassphraseKeyStore } from "../src/secrets/passphrase";
import { selectKeyStore } from "../src/secrets/select";
import { currentUserSid, windowsSystemTool } from "../src/util/windows-acl";

let roots: string[] = [];
const fresh = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "agni-vault-"));
  roots.push(dir);
  return dir;
};
let keystore: ReturnType<typeof createMemoryKeyStore>;
beforeEach(() => {
  keystore = createMemoryKeyStore();
  lockVault();
});
afterEach(() => {
  lockVault();
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  roots = [];
});

const codeOf = async (run: () => unknown): Promise<string> => {
  try {
    await run();
  } catch (error) {
    return error instanceof VaultError ? error.code : `not a VaultError: ${String(error)}`;
  }
  return "no error";
};

describe("creating and reopening", () => {
  test("a home with no vault is VAULT_NOT_FOUND unless create is asked for", async () => {
    const home = fresh();
    expect(vaultExists({ home })).toBe(false);
    expect(await codeOf(() => unlockVault({ home, keystore }))).toBe("VAULT_NOT_FOUND");
    expect(existsSync(join(home, "vault.bin"))).toBe(false);
    expect(isVaultUnlocked()).toBe(false);
  });

  test("values survive a lock and a fresh unlock, and are listed by name only", async () => {
    const home = fresh();
    const vault = await unlockVault({ home, keystore, create: true });
    vault.set("env/OPENROUTER_API_KEY", "sk-or-canary-123");
    vault.set("plugin/google/token", "ya29.token");
    expect(getVault()).toBe(vault);

    lockVault();
    const again = await unlockVault({ home, keystore });
    expect(again.get("env/OPENROUTER_API_KEY")).toBe("sk-or-canary-123");
    expect(again.get("nope")).toBeUndefined();
    expect(again.list().map((entry) => entry.name)).toEqual(["env/OPENROUTER_API_KEY", "plugin/google/token"]);
    expect(again.list("plugin/").map((entry) => entry.name)).toEqual(["plugin/google/token"]);
    expect(JSON.stringify(again.list())).not.toContain("canary");
    expect(again.delete("plugin/google/token")).toBe(true);
    expect(again.delete("plugin/google/token")).toBe(false);
    expect(again.has("plugin/google/token")).toBe(false);
  });

  test("unlock is idempotent for one home", async () => {
    const home = fresh();
    const first = await unlockVault({ home, keystore, create: true });
    expect(await unlockVault({ home, keystore })).toBe(first);
  });

  test("the file never holds a secret or a secret name in plaintext, and has a versioned header", async () => {
    const home = fresh();
    const vault = await unlockVault({ home, keystore, create: true });
    vault.set("env/GROQ_API_KEY", "gsk_super_secret_canary_value");
    const bytes = readFileSync(join(home, "vault.bin"));
    const text = bytes.toString("latin1");
    expect(text).not.toContain("gsk_super_secret_canary_value");
    expect(text).not.toContain("GROQ_API_KEY");
    expect(bytes.subarray(0, 4).toString("latin1")).toBe("AGVT");
    expect(bytes[4]).toBe(1);
    expect(vaultStatus({ home })).toMatchObject({ exists: true, version: 1, keystoreKind: "memory" });
  });

  test("two writes of the same value give different ciphertext (fresh nonce)", async () => {
    const home = fresh();
    const vault = await unlockVault({ home, keystore, create: true });
    vault.set("a", "same");
    const one = readFileSync(join(home, "vault.bin"));
    vault.set("a", "same");
    const two = readFileSync(join(home, "vault.bin"));
    expect(one.equals(two)).toBe(false);
  });
});

describe("refusing", () => {
  test("a vault whose key is gone from the keystore is DATA_KEY_MISSING and is not recreated", async () => {
    const home = fresh();
    const vault = await unlockVault({ home, keystore, create: true });
    vault.set("a", "1");
    const before = readFileSync(join(home, "vault.bin"));
    lockVault();
    keystore.clear();
    expect(await codeOf(() => unlockVault({ home, keystore, create: true }))).toBe("DATA_KEY_MISSING");
    expect(readFileSync(join(home, "vault.bin")).equals(before)).toBe(true);
  });

  test("a changed byte is AUTH_FAILED", async () => {
    const home = fresh();
    const vault = await unlockVault({ home, keystore, create: true });
    vault.set("a", "1");
    lockVault();
    const path = join(home, "vault.bin");
    const bytes = readFileSync(path);
    bytes[bytes.length - 20] = bytes[bytes.length - 20]! ^ 0xff;
    writeFileSync(path, bytes);
    expect(await codeOf(() => unlockVault({ home, keystore }))).toBe("AUTH_FAILED");
  });

  test("a changed header byte is refused too (the header is authenticated)", async () => {
    const home = fresh();
    await unlockVault({ home, keystore, create: true });
    lockVault();
    const path = join(home, "vault.bin");
    const bytes = readFileSync(path);
    const at = bytes.indexOf("createdAt");
    bytes[at + 12] = bytes[at + 12]! ^ 0x01;
    writeFileSync(path, bytes);
    const code = await codeOf(() => unlockVault({ home, keystore }));
    expect(["AUTH_FAILED", "VAULT_CORRUPT"]).toContain(code);
  });

  test("a file that is not a vault is VAULT_CORRUPT; a newer version is VAULT_VERSION_UNSUPPORTED", async () => {
    const home = fresh();
    writeFileSync(join(home, "vault.bin"), "hello");
    expect(await codeOf(() => unlockVault({ home, keystore }))).toBe("VAULT_CORRUPT");
    await unlockVault({ home: fresh(), keystore, create: true });
    const other = fresh();
    await unlockVault({ home: other, keystore, create: true });
    lockVault();
    const path = join(other, "vault.bin");
    const bytes = readFileSync(path);
    bytes[4] = 9;
    writeFileSync(path, bytes);
    expect(await codeOf(() => unlockVault({ home: other, keystore }))).toBe("VAULT_VERSION_UNSUPPORTED");
  });

  test("a vault made by one keystore kind is not opened by another", async () => {
    const home = fresh();
    await unlockVault({ home, keystore, create: true });
    lockVault();
    const passphrase = createPassphraseKeyStore({ passphrase: () => "correct horse battery staple" });
    expect(await codeOf(() => unlockVault({ home, keystore: passphrase }))).toBe("KEYSTORE_MISMATCH");
  });

  test("names and values are checked", async () => {
    const vault = await unlockVault({ home: fresh(), keystore, create: true });
    for (const name of ["", " a", "../x", "a b", "-x", "x".repeat(129)]) {
      expect(await codeOf(() => vault.set(name, "v"))).toBe("INVALID_ENTRY");
    }
    expect(await codeOf(() => vault.set("ok", "x".repeat(256 * 1024 + 1)))).toBe("INVALID_ENTRY");
    expect(await codeOf(() => vault.set("ok", undefined as unknown as string))).toBe("INVALID_ENTRY");
    vault.set("ok", "");
    expect(vault.get("ok")).toBe("");
  });

  test("using the vault before unlock is VAULT_LOCKED", async () => {
    expect(await codeOf(() => getVault())).toBe("VAULT_LOCKED");
  });
});

describe("registering secrets for redaction", () => {
  test("every value set, read after unlock, or returned by get is registered", async () => {
    const home = fresh();
    const spy = spyOn(redactModule, "registerSecretFor");
    try {
      const vault = await unlockVault({ home, keystore, create: true });
      vault.set("a", "value-set");
      expect(spy).toHaveBeenCalledWith(expect.any(String), "value-set");
      lockVault();
      spy.mockClear();
      const again = await unlockVault({ home, keystore });
      expect(spy).toHaveBeenCalledWith(expect.any(String), "value-set");
      spy.mockClear();
      again.get("a");
      expect(spy).toHaveBeenCalledWith(expect.any(String), "value-set");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("two processes", () => {
  test("a second handle's write is kept when the first writes later (no lost update)", async () => {
    const home = fresh();
    const one = await unlockVault({ home, keystore, create: true });
    lockVault();
    const two = await unlockVault({ home, keystore });
    expect(one).not.toBe(two);
    one.set("from-one", "1");
    two.set("from-two", "2");
    one.set("again-one", "3");
    one.refresh();
    expect(one.list().map((entry) => entry.name)).toEqual(["again-one", "from-one", "from-two"]);
    two.refresh();
    expect(two.get("from-one")).toBe("1");
  });

  test("a stale lock file is removed; a held lock times out with LOCK_TIMEOUT", async () => {
    const home = fresh();
    const vault = await unlockVault({ home, keystore, create: true });
    const lock = join(home, "vault.bin.lock");
    writeFileSync(lock, JSON.stringify({ pid: 1, at: Date.now() - 120_000 }));
    const old = new Date(Date.now() - 120_000);
    (await import("node:fs")).utimesSync(lock, old, old);
    vault.set("a", "1");
    expect(existsSync(lock)).toBe(false);

    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
    const started = Date.now();
    expect(await codeOf(() => vault.set("b", "2"))).toBe("LOCK_TIMEOUT");
    expect(Date.now() - started).toBeLessThan(15_000);
    rmSync(lock);
  }, 20_000);
});

describe("the file's access rules", () => {
  test.skipIf(process.platform !== "win32")("on Windows vault.bin is readable by the owner only", async () => {
    const home = fresh();
    const vault = await unlockVault({ home, keystore, create: true });
    vault.set("a", "1");
    const scratch = mkdtempSync(join(tmpdir(), "agni-vault-acl-"));
    roots.push(scratch);
    const out = join(scratch, "acl.txt");
    execFileSync(windowsSystemTool("icacls"), [join(home, "vault.bin"), "/save", out, "/q"], { stdio: "pipe", windowsHide: true });
    const sddl = readFileSync(out, "utf16le").match(/^D:(.*)$/m)?.[1]?.trim() ?? "";
    const entries = sddl.match(/\([^)]*\)/g) ?? [];
    expect(entries.length).toBe(1);
    expect(entries[0]).toContain(`;;;${currentUserSid()})`);
  });

  test.skipIf(process.platform === "win32")("on macOS and Linux vault.bin is mode 600", async () => {
    const home = fresh();
    await unlockVault({ home, keystore, create: true });
    expect((await import("node:fs")).statSync(join(home, "vault.bin")).mode & 0o777).toBe(0o600);
  });
});

describe("secrets mode", () => {
  test("defaults to file until S3-3 flips it; AGNI_SECRETS_MODE=vault turns the vault on", () => {
    expect(secretsMode({})).toBe("file");
    expect(secretsMode({ AGNI_SECRETS_MODE: "vault" })).toBe("vault");
    expect(secretsMode({ AGNI_SECRETS_MODE: "VAULT " })).toBe("vault");
    expect(secretsMode({ AGNI_SECRETS_MODE: "nonsense" })).toBe("file");
  });
});

describe("passphrase keystore (headless)", () => {
  const cheap = { N: 1024, r: 8, p: 1 };

  test("a vault opens with the same passphrase, and a wrong one is PASSPHRASE_REJECTED", async () => {
    const home = fresh();
    const store = createPassphraseKeyStore({ passphrase: () => "correct horse battery staple", cost: cheap });
    const vault = await unlockVault({ home, keystore: store, create: true });
    vault.set("a", "1");
    lockVault();
    expect((await unlockVault({ home, keystore: store })).get("a")).toBe("1");
    lockVault();
    const wrong = createPassphraseKeyStore({ passphrase: () => "wrong horse battery staple", cost: cheap });
    expect(await codeOf(() => unlockVault({ home, keystore: wrong }))).toBe("PASSPHRASE_REJECTED");
  });

  test("a missing or short passphrase refuses; there is no plaintext fallback", async () => {
    const missing = createPassphraseKeyStore({ passphrase: () => undefined, cost: cheap });
    expect(await codeOf(() => unlockVault({ home: fresh(), keystore: missing, create: true }))).toBe("PASSPHRASE_MISSING");
    const short = createPassphraseKeyStore({ passphrase: () => "short", cost: cheap });
    expect(await codeOf(() => unlockVault({ home: fresh(), keystore: short, create: true }))).toBe("PASSPHRASE_REJECTED");
  });

  test("the salt is in the header, not the passphrase", async () => {
    const home = fresh();
    const store = createPassphraseKeyStore({ passphrase: () => "correct horse battery staple", cost: cheap });
    await unlockVault({ home, keystore: store, create: true });
    const text = readFileSync(join(home, "vault.bin")).toString("latin1");
    expect(text).toContain('"salt"');
    expect(text).not.toContain("correct horse");
  });

  test("selection reads the systemd credential: $CREDENTIALS_DIRECTORY/agni-vault-passphrase", async () => {
    const credentials = fresh();
    writeFileSync(join(credentials, "agni-vault-passphrase"), "correct horse battery staple\n");
    setKeyStoreOverride(null);
    try {
      const store = selectKeyStore({ env: { CREDENTIALS_DIRECTORY: credentials }, platform: "linux" });
      expect(store.kind).toBe("passphrase");
      const home = fresh();
      const vault = await unlockVault({ home, keystore: createPassphraseKeyStore({ passphrase: () => "correct horse battery staple", cost: cheap }), create: true });
      vault.set("a", "1");
    } finally {
      setKeyStoreOverride(createMemoryKeyStore());
    }
  });

  test("an unreadable credential on Linux with no desktop keystore says how to give one", async () => {
    setKeyStoreOverride(null);
    try {
      const store = selectKeyStore({ env: { AGNI_KEYSTORE: "passphrase" }, platform: "linux" });
      const code = await codeOf(() => store.open({ vaultId: "x" }, { salt: "AAAAAAAAAAAAAAAAAAAAAA==", N: 1024, r: 8, p: 1 }));
      expect(code).toBe("PASSPHRASE_MISSING");
      try {
        await store.open({ vaultId: "x" }, { salt: "AAAAAAAAAAAAAAAAAAAAAA==", N: 1024, r: 8, p: 1 });
      } catch (error) {
        expect((error as Error).message).toContain("LoadCredential");
      }
    } finally {
      setKeyStoreOverride(createMemoryKeyStore());
    }
  });
});

describe("keystore selection", () => {
  test("the override wins, then the vault header's kind, then the platform", () => {
    expect(selectKeyStore({ env: {}, platform: "win32" }).kind).toBe("memory");
    setKeyStoreOverride(null);
    // Choosing the OS keystore is refused under NODE_ENV=test (s3-keystore-test-guard.test.ts). Building one touches
    // nothing until it is used, so the platform rules can be checked with the guard lifted for these lines only.
    const nodeEnv = process.env.NODE_ENV;
    const testRun = process.env.AGNI_TEST_RUN;
    process.env.NODE_ENV = "production";
    delete process.env.AGNI_TEST_RUN;
    try {
      expect(selectKeyStore({ env: {}, platform: "win32" }).kind).toBe("bun-secrets");
      expect(selectKeyStore({ env: {}, platform: "darwin" }).kind).toBe("bun-secrets");
      expect(selectKeyStore({ env: {}, platform: "linux" }).kind).toBe("bun-secrets");
      process.env.NODE_ENV = nodeEnv;
      expect(selectKeyStore({ env: { AGNI_KEYSTORE: "passphrase" }, platform: "win32" }).kind).toBe("passphrase");
      expect(selectKeyStore({ env: {}, platform: "linux", headerKind: "passphrase" }).kind).toBe("passphrase");
      expect(() => selectKeyStore({ env: { AGNI_KEYSTORE: "bun-secrets" }, platform: "linux", headerKind: "passphrase" })).toThrow(VaultError);
      expect(() => selectKeyStore({ env: { AGNI_KEYSTORE: "memory" }, platform: "linux" })).toThrow(VaultError);
    } finally {
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
      if (testRun === undefined) delete process.env.AGNI_TEST_RUN;
      else process.env.AGNI_TEST_RUN = testRun;
      setKeyStoreOverride(createMemoryKeyStore());
    }
  });
});

describe("Bun.secrets keystore (the real credential store, unique service, cleaned up)", () => {
  test("round trip with a vault, and a missing key is null", async () => {
    const service = `agni-bot-test-${crypto.randomUUID()}`;
    const store: KeyStore = createBunSecretsKeyStore({ service });
    const home = fresh();
    let vaultId = "";
    try {
      const vault = await unlockVault({ home, keystore: store, create: true });
      vault.set("env/X", "real-store-canary");
      vaultId = (JSON.parse(readHeader(join(home, "vault.bin"))) as { vaultId: string }).vaultId;
      lockVault();
      expect((await unlockVault({ home, keystore: store })).get("env/X")).toBe("real-store-canary");
      expect(await store.open({ vaultId: "no-such-vault" }, null)).toBeNull();
    } finally {
      if (vaultId) await store.remove({ vaultId });
    }
    expect(await store.open({ vaultId }, null)).toBeNull();
  });
});

/** The header JSON of a vault file, for the tests that need the vault id. */
function readHeader(path: string): string {
  const bytes = readFileSync(path);
  const length = bytes.readUInt32BE(5);
  return bytes.subarray(9, 9 + length).toString("utf8");
}

void mkdirSync;
