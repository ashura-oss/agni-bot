/**
 * S3-9 item 3: the redaction registry follows the vault. A value that is
 * overwritten or deleted stops being registered (so an hourly OAuth refresh
 * does not grow it for ever); the registry is big enough for a real home; and a
 * full registry still throws rather than leave a secret unmasked.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryKeyStore, lockVault, unlockVault } from "../src/secrets";
import { MAX_SECRETS, redact, registerSecret, registerSecretFor, secretCount, unregisterSecret } from "../src/util/redact";

let roots: string[] = [];
const extra: string[] = [];
const fresh = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "agni-vreg-"));
  roots.push(dir);
  return dir;
};
const masked = (value: string): boolean => !redact(`before ${value} after`).includes(value);

beforeEach(() => lockVault());
afterEach(() => {
  lockVault();
  for (const value of extra.splice(0)) unregisterSecret(value);
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  roots = [];
});

async function open() {
  return unlockVault({ home: fresh(), keystore: createMemoryKeyStore(), create: true });
}

describe("the registry follows the vault", () => {
  test("a value in the vault is masked; once overwritten, the old value is not and the new one is", async () => {
    const vault = await open();
    vault.set("env/GROQ_API_KEY", "gsk_old_value_0123456789");
    expect(masked("gsk_old_value_0123456789")).toBe(true);
    vault.set("env/GROQ_API_KEY", "gsk_new_value_9876543210");
    expect(masked("gsk_new_value_9876543210")).toBe(true);
    expect(redact("x gsk_old_value_0123456789 y")).toBe("x gsk_old_value_0123456789 y");
  });

  test("a deleted entry's value stops being registered", async () => {
    const vault = await open();
    vault.set("plugin/mail/password", "hunter2-hunter2-hunter2");
    expect(masked("hunter2-hunter2-hunter2")).toBe(true);
    const before = secretCount();
    expect(vault.delete("plugin/mail/password")).toBe(true);
    expect(secretCount()).toBe(before - 1);
    expect(redact("x hunter2-hunter2-hunter2 y")).toBe("x hunter2-hunter2-hunter2 y");
  });

  test("a value another entry still holds stays registered when one of them goes", async () => {
    const vault = await open();
    vault.set("env/A_TOKEN", "shared-secret-value-123");
    vault.set("env/B_TOKEN", "shared-secret-value-123");
    vault.delete("env/A_TOKEN");
    expect(masked("shared-secret-value-123")).toBe(true);
    vault.set("env/B_TOKEN", "a-different-value-45678");
    expect(redact("x shared-secret-value-123 y")).toBe("x shared-secret-value-123 y");
  });

  // Each write of the vault file sets an owner-only ACL on Windows (two child processes), so a day of refreshes takes a few seconds there.
  test("hourly token refreshes do not grow the registry", async () => {
    const vault = await open();
    vault.set("plugin/google/tokens", JSON.stringify({ access: "ya29.refresh-0000000000", refresh: "1//refresh-token-value" }));
    const baseline = secretCount();
    for (let hour = 1; hour <= 25; hour++) {
      vault.set("plugin/google/tokens", JSON.stringify({ access: `ya29.refresh-${String(hour).padStart(10, "0")}`, refresh: "1//refresh-token-value" }));
    }
    expect(secretCount()).toBe(baseline);
  }, 60_000);

  test("a change made by another process is dropped on the next reload", async () => {
    const home = fresh();
    const keystore = createMemoryKeyStore();
    const here = await unlockVault({ home, keystore, create: true });
    here.set("env/X_API_KEY", "key-before-other-process-1");
    // A second process (a CLI command) opens the same vault and replaces the value.
    lockVault();
    const there = await unlockVault({ home, keystore });
    there.set("env/X_API_KEY", "key-after-other-process-22");
    // In its own process this daemon still has the old value registered, under its vault entry's hold
    // (both vaults here are one process, so the second one's write let go of that hold: put it back).
    registerSecretFor(`vault:${here.path}:env/X_API_KEY`, "key-before-other-process-1");
    here.refresh({ force: true });
    expect(here.get("env/X_API_KEY")).toBe("key-after-other-process-22");
    expect(redact("x key-before-other-process-1 y")).toBe("x key-before-other-process-1 y");
    expect(masked("key-after-other-process-22")).toBe(true);
  });
});

describe("capacity", () => {
  test("the registry holds ten thousand secrets", () => {
    expect(MAX_SECRETS).toBe(10_000);
  });

  test("a full registry still throws, so a secret is never left unmasked", () => {
    const room = MAX_SECRETS - secretCount();
    for (let i = 0; i < room; i++) {
      const value = `vreg-filler-${i}-${"z".repeat(10)}`;
      extra.push(value);
      registerSecret(value);
    }
    expect(secretCount()).toBe(MAX_SECRETS);
    expect(() => registerSecret("one-secret-too-many-vreg-1")).toThrow(/secret/i);
  });
});
