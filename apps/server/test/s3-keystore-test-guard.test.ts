/**
 * No test may reach the real operating-system credential store (Windows Credential Manager, macOS Keychain,
 * libsecret). The preload installs an in-memory keystore as the override; this is the second line: with the
 * override cleared and NODE_ENV=test, choosing the OS keystore under its default service refuses, so a test
 * that forgets the override (or a child process a test starts, which inherits NODE_ENV) cannot create or read
 * an entry. A test that wants the real store names its own unique service, as vault.test.ts does.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { VaultError, createMemoryKeyStore, setKeyStoreOverride } from "../src/secrets";
import { DEFAULT_KEYSTORE_SERVICE, createBunSecretsKeyStore } from "../src/secrets/bun-secrets";
import { selectKeyStore } from "../src/secrets/select";

type Secrets = { get: (...args: unknown[]) => Promise<unknown>; set: (...args: unknown[]) => Promise<unknown>; delete: (...args: unknown[]) => Promise<unknown> };

let calls: string[] = [];
let realSecrets: unknown;
beforeEach(() => {
  calls = [];
  realSecrets = (Bun as unknown as { secrets?: unknown }).secrets;
  const spy: Secrets = {
    get: async () => (calls.push("get"), null),
    set: async () => (calls.push("set"), undefined),
    delete: async () => (calls.push("delete"), false),
  };
  (Bun as unknown as { secrets: unknown }).secrets = spy; // the property is writable, its methods are not
  setKeyStoreOverride(null);
});
afterEach(() => {
  (Bun as unknown as { secrets: unknown }).secrets = realSecrets;
  setKeyStoreOverride(createMemoryKeyStore());
});

const refusal = (run: () => unknown): VaultError => {
  try {
    run();
  } catch (error) {
    return error as VaultError;
  }
  throw new Error("expected a refusal, but nothing was thrown");
};

describe("the OS keystore under NODE_ENV=test", () => {
  test("this run is a test run", () => {
    expect(process.env.NODE_ENV).toBe("test");
  });

  test("selecting a keystore with the override cleared refuses, and the credential store is not touched", () => {
    const error = refusal(() => selectKeyStore({ env: {}, platform: "win32" }));
    expect(error).toBeInstanceOf(VaultError);
    expect(error.code).toBe("KEYSTORE_UNAVAILABLE");
    expect(calls).toEqual([]);
  });

  test("so does asking for it by name (AGNI_KEYSTORE=bun-secrets), on every platform", () => {
    for (const platform of ["win32", "darwin", "linux"] as const) {
      expect(refusal(() => selectKeyStore({ env: { AGNI_KEYSTORE: "bun-secrets" }, platform })).code).toBe("KEYSTORE_UNAVAILABLE");
    }
    expect(calls).toEqual([]);
  });

  test("creating one under the product's own service name refuses", () => {
    expect(refusal(() => createBunSecretsKeyStore()).code).toBe("KEYSTORE_UNAVAILABLE");
    expect(refusal(() => createBunSecretsKeyStore({ service: DEFAULT_KEYSTORE_SERVICE })).code).toBe("KEYSTORE_UNAVAILABLE");
    expect(calls).toEqual([]);
  });

  test("a test that names its own service still gets a store (nothing is called until it is used)", () => {
    expect(createBunSecretsKeyStore({ service: `agni-bot-test-${crypto.randomUUID()}` }).kind).toBe("bun-secrets");
    expect(calls).toEqual([]);
  });

  test("a passphrase keystore is unaffected", () => {
    expect(selectKeyStore({ env: { AGNI_KEYSTORE: "passphrase" }, platform: "win32" }).kind).toBe("passphrase");
  });

  test("with the override set, it is returned as it was", () => {
    const memory = createMemoryKeyStore();
    setKeyStoreOverride(memory);
    expect(selectKeyStore({ env: {}, platform: "win32" })).toBe(memory);
  });
});
