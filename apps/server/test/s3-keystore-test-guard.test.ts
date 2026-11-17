/**
 * No test may reach the real operating-system credential store (Windows Credential Manager, macOS Keychain,
 * libsecret). The preload installs an in-memory keystore as the override; this is the second line: with the
 * override cleared and the run marked as a test run (the preload sets AGNI_TEST_RUN=1; `bun test` does not override a NODE_ENV that is already set, so NODE_ENV=test alone cannot be relied on), choosing the OS keystore under its default service refuses, so a test
 * that forgets the override (or a child process a test starts, which inherits NODE_ENV) cannot create or read
 * an entry. A test that wants the real store names its own unique service, as vault.test.ts does.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { VaultError, createMemoryKeyStore, setKeyStoreOverride } from "../src/secrets";
import { DEFAULT_KEYSTORE_SERVICE, createBunSecretsKeyStore } from "../src/secrets/bun-secrets";
import { selectKeyStore } from "../src/secrets/select";
import { vaultRefusalMessage } from "../src/startup/s3-vault";

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

describe("the OS keystore in a test run", () => {
  test("this run is marked as a test run by the preload, whatever NODE_ENV was when it started", () => {
    expect(process.env.AGNI_TEST_RUN).toBe("1");
  });

  test("a NODE_ENV that is not `test` does not switch the guard off", () => {
    const nodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(refusal(() => createBunSecretsKeyStore()).code).toBe("TEST_RUN");
      expect(refusal(() => selectKeyStore({ env: {}, platform: "win32" })).code).toBe("TEST_RUN");
    } finally {
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
    }
    expect(calls).toEqual([]);
  });

  test("NODE_ENV=test alone still counts as a test run", () => {
    const marker = process.env.AGNI_TEST_RUN;
    const nodeEnv = process.env.NODE_ENV;
    delete process.env.AGNI_TEST_RUN;
    process.env.NODE_ENV = "test";
    try {
      expect(refusal(() => createBunSecretsKeyStore()).code).toBe("TEST_RUN");
    } finally {
      if (marker !== undefined) process.env.AGNI_TEST_RUN = marker;
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
    }
  });

  test("the refusal says it is a test run, and is not told to the person as 'unlock the credential store'", () => {
    const error = refusal(() => createBunSecretsKeyStore());
    expect(error.code).toBe("TEST_RUN");
    expect(error.message).toMatch(/test run/i);
    expect(vaultRefusalMessage(error)).not.toMatch(/unlock/i);
  });

  test("selecting a keystore with the override cleared refuses, and the credential store is not touched", () => {
    const error = refusal(() => selectKeyStore({ env: {}, platform: "win32" }));
    expect(error).toBeInstanceOf(VaultError);
    expect(error.code).toBe("TEST_RUN");
    expect(calls).toEqual([]);
  });

  test("so does asking for it by name (AGNI_KEYSTORE=bun-secrets), on every platform", () => {
    for (const platform of ["win32", "darwin", "linux"] as const) {
      expect(refusal(() => selectKeyStore({ env: { AGNI_KEYSTORE: "bun-secrets" }, platform })).code).toBe("TEST_RUN");
    }
    expect(calls).toEqual([]);
  });

  test("creating one under the product's own service name refuses", () => {
    expect(refusal(() => createBunSecretsKeyStore()).code).toBe("TEST_RUN");
    expect(refusal(() => createBunSecretsKeyStore({ service: DEFAULT_KEYSTORE_SERVICE })).code).toBe("TEST_RUN");
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
