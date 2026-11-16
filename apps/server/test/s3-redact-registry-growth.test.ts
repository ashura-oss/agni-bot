/**
 * Final review: a token that is refreshed replaces an earlier one, and the old
 * value must stop being registered for redaction. Without that, an access token
 * refreshed hourly adds a registered secret (and about fifty masked forms of it)
 * every hour for as long as the server runs, until the registry cap refuses.
 *
 * Each store is driven through its own public path, 1,000 times, and the size of
 * the registry must not move. File mode and vault mode both. Throwaway homes,
 * in-memory keystore.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db";
import { ChatGPTAuth } from "../src/models/chatgpt-auth";
import { emptyPluginsFile, savePluginsFile, type PluginsFile } from "../src/plugins/config";
import { completeConnect, deleteConnection, startPending, updateTokens } from "../src/plugins/store";
import { lockVault, unlockVault } from "../src/secrets";
import { redact, rememberSecretsAt, secretCount } from "../src/util/redact";

const ROUNDS = 1_000;
// A vault write is an encrypted, fsynced file replace (about 60 ms): 1,000 of them per store is minutes.
// Vault mode runs fewer rounds; the registry's behaviour does not depend on how many.
const VAULT_ROUNDS = 60;

let home = "";
let savedMode: string | undefined;
beforeEach(() => {
  savedMode = process.env.AGNI_SECRETS_MODE;
  delete process.env.AGNI_SECRETS_MODE;
  lockVault();
  home = mkdtempSync(join(tmpdir(), "agni-regrowth-"));
});
afterEach(() => {
  lockVault();
  if (savedMode === undefined) delete process.env.AGNI_SECRETS_MODE;
  else process.env.AGNI_SECRETS_MODE = savedMode;
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function vaultMode(): Promise<void> {
  await unlockVault({ home, create: true });
  process.env.AGNI_SECRETS_MODE = "vault";
}

const MODES = [
  ["file mode", async () => {}, ROUNDS],
  ["vault mode", vaultMode, VAULT_ROUNDS],
] as const;

describe("rememberSecretsAt", () => {
  test("a slot's new values replace its old ones, and a value two slots hold stays until both let go", () => {
    const base = secretCount();
    rememberSecretsAt("a", "value-one-aaaaaaaa", "shared-value-bbbbbbbb");
    rememberSecretsAt("b", "shared-value-bbbbbbbb");
    expect(redact("x value-one-aaaaaaaa y")).toContain("[redacted]");
    rememberSecretsAt("a", "value-two-cccccccc");
    expect(redact("x value-one-aaaaaaaa y")).toBe("x value-one-aaaaaaaa y"); // the replaced value is no longer masked
    expect(redact("x shared-value-bbbbbbbb y")).toBe("x [redacted] y"); // slot b still holds it
    rememberSecretsAt("b");
    expect(redact("x shared-value-bbbbbbbb y")).toBe("x shared-value-bbbbbbbb y");
    rememberSecretsAt("a");
    expect(secretCount()).toBe(base);
  });
});

describe.each(MODES)("%s", (_name, enter, rounds) => {
  test("plugins.json: refreshed OAuth tokens (1,000 in file mode) keep the registry the same size", async () => {
    await enter();
    const path = join(home, "plugins.json");
    const config = (i: number): PluginsFile => {
      const file = emptyPluginsFile();
      file.plugins["google-calendar"] = {
        account: "agent",
        enabled: true,
        auth: { kind: "oauth", access_token: `ya29.access-token-round-${i}-zzzz`, refresh_token: `1//refresh-token-round-${i}-zzzz`, expires_at: i },
      };
      return file;
    };
    savePluginsFile(path, config(0));
    const settled = secretCount();
    for (let i = 1; i <= rounds; i += 1) savePluginsFile(path, config(i));
    expect(secretCount()).toBe(settled);
    // The newest value is still masked; one from far back is not.
    expect(redact(`ya29.access-token-round-${rounds}-zzzz`)).toBe("[redacted]");
    expect(redact("ya29.access-token-round-5-zzzz")).toBe("ya29.access-token-round-5-zzzz");
  }, 120_000);

  test("plugins.json: removing a plugin stops masking its secrets", async () => {
    await enter();
    const path = join(home, "plugins.json");
    const withPlugin = emptyPluginsFile();
    withPlugin.plugins.gmail = { account: "agent", enabled: true, auth: { kind: "app-password", user: "a@example.com", pass: "gone-with-the-plugin-1234" } };
    const before = secretCount();
    savePluginsFile(path, withPlugin);
    expect(secretCount()).toBeGreaterThan(before);
    savePluginsFile(path, emptyPluginsFile());
    expect(secretCount()).toBe(before);
  });

  test("plugin connections: refreshed token blobs (1,000 in file mode) keep the registry the same size", async () => {
    await enter();
    const db = openDatabase(":memory:");
    try {
      const row = startPending(db, { pluginID: "gmail", account: "agent", scopes: [], capabilities: {} });
      completeConnect(db, row.id, { access_token: "access-round-0-zzzzzzzz", refresh_token: "refresh-round-0-zzzzzzzz" }, "a@example.com");
      const settled = secretCount();
      for (let i = 1; i <= rounds; i += 1) updateTokens(db, row.id, { access_token: `access-round-${i}-zzzzzzzz`, refresh_token: `refresh-round-${i}-zzzzzzzz`, expires_at: i });
      expect(secretCount()).toBe(settled);
      expect(redact(`access-round-${rounds}-zzzzzzzz`)).toBe("[redacted]");
      expect(redact("access-round-3-zzzzzzzz")).toBe("access-round-3-zzzzzzzz");
      deleteConnection(db, row.id);
      expect(redact(`access-round-${rounds}-zzzzzzzz`)).toBe(`access-round-${rounds}-zzzzzzzz`);
    } finally {
      db.close();
    }
  }, 120_000);

  test("ChatGPT accounts saved to disk: token refreshes keep the registry the same size", async () => {
    await enter();
    await chatgptRefreshes(join(home, "data", "chatgpt", "accounts.json"), Math.min(rounds, 40));
  }, 120_000);
});

describe("ChatGPT accounts", () => {
  test("1,000 token refreshes keep the registry the same size", async () => {
    await chatgptRefreshes(join(home, "data", "chatgpt", "accounts.json"), ROUNDS, false);
  }, 120_000);
});

/** Refresh the one account's tokens `count` times, with a fake token endpoint, and check the registry stops growing. */
async function chatgptRefreshes(path: string, count: number, persist = true): Promise<void> {
  let clock = 1_000_000;
  let round = 0;
  const fetchFn = (async () =>
    new Response(
      JSON.stringify({
        access_token: `chatgpt-access-round-${++round}-zzzz`,
        refresh_token: `chatgpt-refresh-round-${round}-zzzz`,
        token_type: "bearer",
        expires_in: 3600,
        scope: "resource.invoke chatgpt.tokens.use.direct",
      }),
      { headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
  mkdirSync(join(home, "data", "chatgpt"), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      hostID: "urn:uuid:11111111-2222-3333-4444-555555555555",
      activeID: "acc1",
      accounts: [
        {
          id: "acc1", clientID: "client-1", subject: "sub-1", email: "owner@example.test", model: "m1",
          models: [{ id: "m1", label: "Model one", vision: false }],
          tokens: { accessToken: "chatgpt-access-round-0-zzzz", refreshToken: "chatgpt-refresh-round-0-zzzz", idToken: "chatgpt-id-token-fixed-zzzz", expiresAt: clock, earliestRefreshAt: 0, scopes: ["resource.invoke", "chatgpt.tokens.use.direct"] },
          needsLogin: false, permissionDisabled: false, welcomed: false,
        },
      ],
    }),
  );
  const auth = new ChatGPTAuth({ filePath: path, fetchFn, now: () => clock });
  // A disk save costs about 50 ms here (an ACL call per write), so the 1,000-round run keeps the accounts in memory only.
  if (!persist) (auth as unknown as { options: { filePath: string | null } }).options.filePath = null;
  try {
    await auth.accessToken();
    const settled = secretCount();
    for (let i = 1; i <= count; i += 1) {
      clock += 2 * 3_600_000; // past expiry, so the next call refreshes
      await auth.accessToken();
    }
    expect(secretCount()).toBe(settled);
    expect(redact(`chatgpt-access-round-${round}-zzzz`)).toBe("[redacted]");
    expect(redact("chatgpt-access-round-4-zzzz")).toBe("chatgpt-access-round-4-zzzz");
  } finally {
    auth.stop();
  }
}
