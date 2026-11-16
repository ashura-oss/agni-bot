/**
 * Final review: a token that is refreshed replaces an earlier one. The replaced values stay
 * masked for a while (they may still be valid; see s3-redact-retire.test.ts) but only a bounded
 * number of them: without that, an access token refreshed hourly adds a registered secret (and
 * about fifty masked forms of it) every hour for as long as the server runs, until the registry
 * cap refuses.
 *
 * Each store is driven through its own public path, 1,000 times, and once the queue of replaced
 * values is full the size of the registry must not move. File mode and vault mode both.
 * Throwaway homes, in-memory keystore.
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
import { RETIRED_PER_SLOT, redact, releaseExpiredSecrets, secretCount } from "../src/util/redact";

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

describe.each(MODES)("%s", (_name, enter, rounds) => {
  test("plugins.json: refreshed OAuth tokens (1,000 in file mode) keep the registry the same size once the queue is full", async () => {
    await enter();
    const path = join(home, "plugins.json");
    const config = (i: number): PluginsFile => {
      const file = emptyPluginsFile();
      file.plugins["google-calendar"] = {
        account: "agent",
        enabled: true,
        auth: { kind: "oauth", access_token: `ya29.access-token-round-${i}-zzzz`, refresh_token: `1//refresh-token-round-${i}-zzzz`, expires_at: Date.now() + 3_600_000 },
      };
      return file;
    };
    savePluginsFile(path, config(0));
    for (let i = 1; i <= RETIRED_PER_SLOT + 2; i += 1) savePluginsFile(path, config(i));
    const settled = secretCount();
    for (let i = RETIRED_PER_SLOT + 3; i <= rounds; i += 1) savePluginsFile(path, config(i));
    expect(secretCount()).toBe(settled);
    // The newest value and the one it replaced are masked; one from far back is not.
    expect(redact(`ya29.access-token-round-${rounds}-zzzz`)).toBe("[redacted]");
    expect(redact(`ya29.access-token-round-${rounds - 1}-zzzz`)).toBe("[redacted]");
    expect(redact("ya29.access-token-round-5-zzzz")).toBe("ya29.access-token-round-5-zzzz");
  }, 120_000);

  test("plugins.json: removing a plugin keeps its secrets masked (a password has no expiry)", async () => {
    await enter();
    const path = join(home, "plugins.json");
    const withPlugin = emptyPluginsFile();
    withPlugin.plugins.gmail = { account: "agent", enabled: true, auth: { kind: "app-password", user: "a@example.com", pass: "gone-with-the-plugin-1234" } };
    const before = secretCount();
    savePluginsFile(path, withPlugin);
    expect(secretCount()).toBeGreaterThan(before);
    savePluginsFile(path, emptyPluginsFile());
    expect(redact("gone-with-the-plugin-1234")).toBe("[redacted]");
    // A password has no expiry: only the queue's age lets it go, so it is still masked a day later.
    releaseExpiredSecrets(Date.now() + 24 * 3_600_000);
    expect(redact("gone-with-the-plugin-1234")).toBe("[redacted]");
  });

  test("plugin connections: refreshed token blobs (1,000 in file mode) keep the registry the same size once the queue is full", async () => {
    await enter();
    const db = openDatabase(":memory:");
    try {
      const row = startPending(db, { pluginID: "gmail", account: "agent", scopes: [], capabilities: {} });
      completeConnect(db, row.id, { access_token: "access-round-0-zzzzzzzz", refresh_token: "refresh-round-0-zzzzzzzz" }, "a@example.com");
      const tokens = (i: number) => ({ access_token: `access-round-${i}-zzzzzzzz`, refresh_token: `refresh-round-${i}-zzzzzzzz`, expires_at: Date.now() + 3_600_000 });
      for (let i = 1; i <= RETIRED_PER_SLOT + 2; i += 1) updateTokens(db, row.id, tokens(i));
      const settled = secretCount();
      for (let i = RETIRED_PER_SLOT + 3; i <= rounds; i += 1) updateTokens(db, row.id, tokens(i));
      expect(secretCount()).toBe(settled);
      expect(redact(`access-round-${rounds}-zzzzzzzz`)).toBe("[redacted]");
      expect(redact(`access-round-${rounds - 1}-zzzzzzzz`)).toBe("[redacted]");
      expect(redact("access-round-3-zzzzzzzz")).toBe("access-round-3-zzzzzzzz");
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
  let clock = Date.now(); // the registry reads the real clock: a token's expiry is in the future, as it is in life
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
    const warmup = RETIRED_PER_SLOT + 2;
    for (let i = 1; i <= warmup; i += 1) {
      clock += 2 * 3_600_000; // past expiry, so the next call refreshes
      await auth.accessToken();
    }
    const settled = secretCount();
    for (let i = warmup + 1; i <= count; i += 1) {
      clock += 2 * 3_600_000;
      await auth.accessToken();
    }
    expect(secretCount()).toBe(settled);
    expect(redact(`chatgpt-access-round-${round}-zzzz`)).toBe("[redacted]");
    expect(redact(`chatgpt-access-round-${round - 1}-zzzz`)).toBe("[redacted]");
    expect(redact("chatgpt-access-round-4-zzzz")).toBe("chatgpt-access-round-4-zzzz");
  } finally {
    auth.stop();
  }
}
