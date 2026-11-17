/**
 * Secrets that are already in the stores when the server starts must be masked, not only the ones
 * saved after it started (Sprint 3 fix round). `loadPluginsFile` and `readConnectionTokens` register
 * what they load; in vault mode the connection's blob is one JSON entry, so the tokens inside it are
 * registered too, not only the blob.
 *
 * Throwaway homes, in-memory keystore. The registry is emptied before each load, like a fresh process.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db";
import { loadPluginsFile, savePluginsFile, type PluginsFile } from "../src/plugins/config";
import { completeConnect, getConnectionFor, readConnectionTokens, startPending } from "../src/plugins/store";
import { lockVault, unlockVault } from "../src/secrets";
import { redact } from "../src/util/redact";
import { clearSecretsForTests } from "../src/util/redact-core";

const masked = (value: string): boolean => redact(`before ${value} after`) === "before [redacted] after";

const S = {
  imapPass: "startup-canary-imap-password-1111",
  mcpKey: "startup-canary-mcp-bearer-2222",
  mcpUrl: "https://mcp.example.com/s/startup-canary-path-secret-3333",
  access: "ya29.startup-canary-access-4444",
  refresh: "1//startup-canary-refresh-5555",
};

let home = "";
let savedMode: string | undefined;
beforeEach(() => {
  savedMode = process.env.AGNI_SECRETS_MODE;
  delete process.env.AGNI_SECRETS_MODE;
  lockVault();
  home = mkdtempSync(join(tmpdir(), "agni-startupredact-"));
});
afterEach(() => {
  lockVault();
  if (savedMode === undefined) delete process.env.AGNI_SECRETS_MODE;
  else process.env.AGNI_SECRETS_MODE = savedMode;
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const config = (): PluginsFile => ({
  version: 1,
  plugins: {
    gmail: { account: "agent", enabled: true, auth: { kind: "app-password", user: "agent@example.com", pass: S.imapPass } },
    granola: { account: "owner", enabled: true, auth: { kind: "mcp", key: S.mcpKey, url: S.mcpUrl } },
  },
});

describe("plugins.json at startup", () => {
  test("file mode: loading the file masks an IMAP password, an MCP key and an MCP key-bearing URL", () => {
    const path = join(home, "plugins.json");
    writeFileSync(path, JSON.stringify(config()));
    clearSecretsForTests();
    loadPluginsFile(path);
    expect(masked(S.imapPass)).toBe(true);
    expect(masked(S.mcpKey)).toBe(true);
    expect(masked(S.mcpUrl)).toBe(true);
  });

  test("vault mode: loading the file masks the same three (they come from the vault)", async () => {
    const path = join(home, "plugins.json");
    await unlockVault({ home, create: true });
    process.env.AGNI_SECRETS_MODE = "vault";
    savePluginsFile(path, config());
    clearSecretsForTests();
    const loaded = loadPluginsFile(path);
    expect(loaded.plugins.gmail!.auth.pass).toBe(S.imapPass);
    expect(masked(S.imapPass)).toBe(true);
    expect(masked(S.mcpKey)).toBe(true);
    expect(masked(S.mcpUrl)).toBe(true);
  });

  test("a file that cannot be parsed registers nothing and throws nothing", () => {
    const path = join(home, "plugins.json");
    writeFileSync(path, "{not json");
    clearSecretsForTests();
    expect(() => loadPluginsFile(path)).not.toThrow();
  });
});

describe("a plugin connection's tokens at startup", () => {
  const tokens = { access_token: S.access, refresh_token: S.refresh, expires_at: Date.now() + 3_600_000 };

  test("file mode: reading a row masks its access token and refresh token", () => {
    const db = openDatabase(":memory:");
    const row = startPending(db, { pluginID: "google-calendar", account: "agent", scopes: [], capabilities: {} });
    completeConnect(db, row.id, tokens, "agent@example.com");
    clearSecretsForTests();
    const reread = getConnectionFor(db, "google-calendar", "agent")!;
    expect(readConnectionTokens(reread).access_token).toBe(S.access);
    expect(masked(S.access)).toBe(true);
    expect(masked(S.refresh)).toBe(true);
  });

  test("vault mode: reading a row masks the tokens inside the vault's JSON blob, not only the blob", async () => {
    await unlockVault({ home, create: true });
    process.env.AGNI_SECRETS_MODE = "vault";
    const db = openDatabase(":memory:");
    const row = startPending(db, { pluginID: "google-calendar", account: "agent", scopes: [], capabilities: {} });
    completeConnect(db, row.id, tokens, "agent@example.com");
    clearSecretsForTests();
    const reread = getConnectionFor(db, "google-calendar", "agent")!;
    expect(reread.token_ref).not.toBeNull();
    expect(readConnectionTokens(reread).refresh_token).toBe(S.refresh);
    expect(masked(S.access)).toBe(true);
    expect(masked(S.refresh)).toBe(true);
  });
});
