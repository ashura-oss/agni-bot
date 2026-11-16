/**
 * The redaction registry owns the life of a secret: it counts holders by value, so a value
 * stays masked while anything still holds it. A store that lets go of a value (a refreshed
 * token's slot, a vault entry that was overwritten) must not unmask a value another holder
 * (a vault entry, an environment variable, a provider key) still has.
 *
 * Throwaway home, in-memory keystore.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rememberSecrets } from "../src/credentials/vault-mode";
import { lockVault, unlockVault } from "../src/secrets";
import { redact, registerSecretsFromEnv, rememberSecretsAt } from "../src/util/redact";

let home = "";
beforeEach(() => {
  lockVault();
  home = mkdtempSync(join(tmpdir(), "agni-holders-"));
});
afterEach(() => {
  lockVault();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const masked = (value: string): boolean => redact(`before ${value} after`) === "before [redacted] after";

describe("a value two holders hold stays masked until both let go", () => {
  test("a slot and a vault entry: releasing the slot keeps the value masked", async () => {
    const vault = await unlockVault({ home, create: true });
    const shared = "shared-by-slot-and-vault-0123";
    vault.set("env/SOME_API_KEY", shared);
    rememberSecretsAt("plugin-connection:one", shared);
    rememberSecretsAt("plugin-connection:one");
    expect(masked(shared)).toBe(true);
  });

  test("a slot and a vault entry: deleting the vault entry keeps a value the slot holds masked", async () => {
    const vault = await unlockVault({ home, create: true });
    const shared = "shared-by-slot-and-vault-4567";
    vault.set("env/SOME_API_KEY", shared);
    rememberSecretsAt("plugin-connection:one", shared);
    vault.delete("env/SOME_API_KEY");
    expect(masked(shared)).toBe(true);
  });

  test("a slot and an environment variable", () => {
    const shared = "shared-by-slot-and-env-0123";
    registerSecretsFromEnv(["SOME_API_KEY"], { SOME_API_KEY: shared });
    rememberSecretsAt("chatgpt:host:acc1", shared);
    rememberSecretsAt("chatgpt:host:acc1");
    expect(masked(shared)).toBe(true);
  });

  test("a slot and a provider key (registered and never let go)", () => {
    const shared = "shared-by-slot-and-key-0123";
    rememberSecrets(shared);
    rememberSecretsAt("plugins.json:gmail:pass", shared);
    rememberSecretsAt("plugins.json:gmail:pass");
    expect(masked(shared)).toBe(true);
  });

  test("two slots", () => {
    const shared = "shared-by-two-slots-0123456";
    rememberSecretsAt("a", shared);
    rememberSecretsAt("b", shared);
    rememberSecretsAt("a");
    expect(masked(shared)).toBe(true);
  });
});
