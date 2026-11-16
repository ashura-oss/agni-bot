/**
 * S3-02: plugins.json in vault mode. The file keeps the settings (which
 * plugins, which account, enabled, labels) and none of the secrets; every
 * secret lives in the vault, and `loadPluginsFile` / `savePluginsFile` put them
 * back and take them out, so the service and the tools do not change.
 * Throwaway home, in-memory keystore.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearSecretsForTests, redact } from "../src/util/redact";

import {
  emptyPluginsFile,
  loadPluginsFile,
  removePlugin,
  savePluginsFile,
  type PluginsFile,
} from "../src/plugins/config";
import { firecrawlFromPlugins, mailCredentialsFromPlugins, pluginAccessToken } from "../src/plugins/credentials";
import { VaultError, lockVault, unlockVault, type Vault } from "../src/secrets";

const SECRETS = {
  mailPass: "canary-mail-app-password-1111",
  fcKey: "fc-canary-firecrawl-key-2222",
  access: "ya29.canary-access-3333",
  refresh: "1//canary-refresh-4444",
  mcpKey: "canary-mcp-bearer-5555",
  mcpUrl: "https://mcp.example.com/s/canary-path-secret-6666",
  clientSecret: "GOCSPX-canary-client-secret-7777",
};

let home = "";
let path = "";
let savedMode: string | undefined;
beforeEach(() => {
  savedMode = process.env.AGNI_SECRETS_MODE;
  delete process.env.AGNI_SECRETS_MODE;
  lockVault();
  home = mkdtempSync(join(tmpdir(), "agni-pluginsecrets-"));
  path = join(home, "plugins.json");
});
afterEach(() => {
  lockVault();
  if (savedMode === undefined) delete process.env.AGNI_SECRETS_MODE;
  else process.env.AGNI_SECRETS_MODE = savedMode;
  rmSync(home, { recursive: true, force: true });
});

async function vaultMode(): Promise<Vault> {
  const vault = await unlockVault({ home, create: true });
  process.env.AGNI_SECRETS_MODE = "vault";
  return vault;
}

function fullConfig(): PluginsFile {
  return {
    version: 1,
    oauthClients: { google: { clientID: "client-id-visible.apps.example.com", clientSecret: SECRETS.clientSecret } },
    plugins: {
      gmail: { account: "agent", enabled: true, auth: { kind: "app-password", user: "agent@example.com", pass: SECRETS.mailPass }, label: "agent@example.com", connectedAt: 1 },
      firecrawl: { account: "owner", enabled: true, auth: { kind: "api-key", key: SECRETS.fcKey, url: "http://localhost:3002" } },
      "google-calendar": {
        account: "agent",
        enabled: true,
        auth: { kind: "oauth", access_token: SECRETS.access, refresh_token: SECRETS.refresh, expires_at: 99 },
      },
      granola: { account: "owner", enabled: true, auth: { kind: "mcp", key: SECRETS.mcpKey, url: SECRETS.mcpUrl }, trustedTools: ["search"], local: true },
    },
  };
}

describe("vault mode: save", () => {
  test("no secret reaches plugins.json, in any byte of it or its temporary files", async () => {
    await vaultMode();
    savePluginsFile(path, fullConfig());
    const text = readFileSync(path, "utf8");
    for (const secret of Object.values(SECRETS)) expect(text).not.toContain(secret);
    // The settings stay where the owner can read and edit them.
    const onDisk = JSON.parse(text) as PluginsFile;
    expect(onDisk.plugins.gmail).toMatchObject({ account: "agent", enabled: true, label: "agent@example.com", auth: { kind: "app-password", user: "agent@example.com" } });
    expect(onDisk.plugins.granola).toMatchObject({ trustedTools: ["search"], local: true, auth: { kind: "mcp" } });
    expect(onDisk.plugins.firecrawl!.auth.url).toBe("http://localhost:3002");
    expect(onDisk.oauthClients!.google!.clientID).toBe("client-id-visible.apps.example.com");
  });

  test("every secret is in the vault under its own name", async () => {
    const vault = await vaultMode();
    savePluginsFile(path, fullConfig());
    expect(vault.get("plugin/gmail/pass")).toBe(SECRETS.mailPass);
    expect(vault.get("plugin/firecrawl/key")).toBe(SECRETS.fcKey);
    expect(vault.get("plugin/google-calendar/access_token")).toBe(SECRETS.access);
    expect(vault.get("plugin/google-calendar/refresh_token")).toBe(SECRETS.refresh);
    expect(vault.get("plugin/granola/key")).toBe(SECRETS.mcpKey);
    // An MCP URL can carry the secret in its path, so it is always kept in the vault.
    expect(vault.get("plugin/granola/url")).toBe(SECRETS.mcpUrl);
    expect(vault.get("plugin-oauth/google/clientSecret")).toBe(SECRETS.clientSecret);
    // Settings are not secrets and are not in the vault.
    expect(vault.has("plugin/gmail/user")).toBe(false);
    expect(vault.has("plugin/firecrawl/url")).toBe(false);
    expect(vault.has("plugin/google-calendar/expires_at")).toBe(false);
  });

  test("a self-hosted URL that carries a credential goes to the vault too", async () => {
    const vault = await vaultMode();
    const config = fullConfig();
    config.plugins.firecrawl!.auth.url = "https://user:hunter2hunter2@fc.example.com";
    savePluginsFile(path, config);
    expect(readFileSync(path, "utf8")).not.toContain("hunter2");
    expect(vault.get("plugin/firecrawl/url")).toBe("https://user:hunter2hunter2@fc.example.com");
  });

  test("with the vault locked the save is refused and the file is untouched", async () => {
    await vaultMode();
    savePluginsFile(path, emptyPluginsFile());
    const before = readFileSync(path, "utf8");
    lockVault();
    expect(() => savePluginsFile(path, fullConfig())).toThrow(VaultError);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

describe("vault mode: load", () => {
  test("a save then a load gives the whole config back", async () => {
    await vaultMode();
    const config = fullConfig();
    savePluginsFile(path, config);
    expect(loadPluginsFile(path)).toEqual(config);
  });

  test("the tools read their credentials through it", async () => {
    await vaultMode();
    savePluginsFile(path, fullConfig());
    expect(mailCredentialsFromPlugins(path, "agent")).toEqual({ user: "agent@example.com", pass: SECRETS.mailPass });
    expect(firecrawlFromPlugins(path)).toEqual({ key: SECRETS.fcKey, url: "http://localhost:3002" });
    // A token that is still valid is returned without a refresh round trip.
    const config = loadPluginsFile(path);
    config.plugins["google-calendar"]!.auth.expires_at = Date.now() + 3_600_000;
    savePluginsFile(path, config);
    expect(await pluginAccessToken(path, "google-calendar")).toBe(SECRETS.access);
  });

  test("a refreshed token is written to the vault, not back into the file", async () => {
    const vault = await vaultMode();
    savePluginsFile(path, fullConfig());
    const fetchStub = (async () => Response.json({ access_token: "ya29.canary-fresh-8888", expires_in: 3600 })) as unknown as typeof fetch;
    const token = await pluginAccessToken(path, "google-calendar", fetchStub);
    expect(token).toBe("ya29.canary-fresh-8888");
    expect(readFileSync(path, "utf8")).not.toContain("canary-fresh-8888");
    expect(vault.get("plugin/google-calendar/access_token")).toBe("ya29.canary-fresh-8888");
    expect(vault.get("plugin/google-calendar/refresh_token")).toBe(SECRETS.refresh);
  });

  test("with the vault locked a load shows the settings but no secrets, and a save is refused", async () => {
    await vaultMode();
    savePluginsFile(path, fullConfig());
    lockVault();
    const config = loadPluginsFile(path);
    expect(config.plugins.gmail!.auth.pass).toBeUndefined();
    expect(config.plugins.gmail!.auth.user).toBe("agent@example.com");
    // Saving it would erase the vault's copies, so it is refused.
    expect(() => savePluginsFile(path, config)).toThrow(VaultError);
  });
});

describe("vault mode: changes", () => {
  test("changing a secret replaces it; clearing one (a disconnect) deletes it", async () => {
    const vault = await vaultMode();
    const config = fullConfig();
    savePluginsFile(path, config);
    config.plugins.gmail!.auth.pass = "canary-new-password-9999";
    config.plugins["google-calendar"]!.auth = { kind: "oauth" };
    savePluginsFile(path, config);
    expect(vault.get("plugin/gmail/pass")).toBe("canary-new-password-9999");
    expect(vault.has("plugin/google-calendar/access_token")).toBe(false);
    expect(vault.has("plugin/google-calendar/refresh_token")).toBe(false);
    expect(loadPluginsFile(path).plugins["google-calendar"]!.auth).toEqual({ kind: "oauth" });
  });

  test("removing a plugin removes its secrets", async () => {
    const vault = await vaultMode();
    const config = fullConfig();
    savePluginsFile(path, config);
    removePlugin(config, "granola");
    savePluginsFile(path, config);
    expect(vault.list("plugin/granola/")).toEqual([]);
    expect(vault.has("plugin/gmail/pass")).toBe(true);
  });

  test("a secret still in the file (not migrated, or typed by hand) is used, and the next save moves it into the vault", async () => {
    const vault = await vaultMode();
    writeFileSync(path, JSON.stringify(fullConfig()));
    const config = loadPluginsFile(path);
    expect(config.plugins.gmail!.auth.pass).toBe(SECRETS.mailPass);
    savePluginsFile(path, config);
    expect(readFileSync(path, "utf8")).not.toContain(SECRETS.mailPass);
    expect(vault.get("plugin/gmail/pass")).toBe(SECRETS.mailPass);
  });

  test("an unreadable file is still never overwritten", async () => {
    await vaultMode();
    writeFileSync(path, "{ not json");
    const config = loadPluginsFile(path);
    expect(() => savePluginsFile(path, config)).toThrow(/refusing to overwrite/);
    expect(readFileSync(path, "utf8")).toBe("{ not json");
    expect(existsSync(`${path}.corrupt`)).toBe(true);
  });
});

describe("redaction", () => {
  test("every secret saved is registered, in file mode and in vault mode", async () => {
    savePluginsFile(path, fullConfig());
    for (const secret of Object.values(SECRETS)) expect(redact(secret)).toBe("[redacted]");
    clearSecretsForTests();
    await vaultMode();
    savePluginsFile(path, fullConfig());
    for (const secret of Object.values(SECRETS)) expect(redact(secret)).toBe("[redacted]");
  });
});

describe("a migration that stopped part way (file mode, vault present)", () => {
  test("a store the migration already emptied still reads its secrets from the vault", async () => {
    const vault = await unlockVault({ home, create: true }); // mode stays file: the run stopped before it was switched
    savePluginsFile(path, fullConfig()); // file mode: plaintext, so make the stripped file by hand
    const stripped = JSON.parse(readFileSync(path, "utf8")) as PluginsFile;
    delete stripped.plugins.gmail!.auth.pass;
    writeFileSync(path, JSON.stringify(stripped));
    vault.set("plugin/gmail/pass", SECRETS.mailPass);
    expect(loadPluginsFile(path).plugins.gmail!.auth.pass).toBe(SECRETS.mailPass);
    expect(mailCredentialsFromPlugins(path, "agent")).toEqual({ user: "agent@example.com", pass: SECRETS.mailPass });
  });

  test("a value in the file still wins over the vault's", async () => {
    const vault = await unlockVault({ home, create: true });
    vault.set("plugin/gmail/pass", "canary-stale-vault-value-0000");
    savePluginsFile(path, fullConfig());
    expect(loadPluginsFile(path).plugins.gmail!.auth.pass).toBe(SECRETS.mailPass);
  });
});

describe("file mode is unchanged", () => {
  test("secrets stay in plugins.json and nothing is written to a vault", async () => {
    const vault = await unlockVault({ home, create: true }); // a vault exists, but the mode is file
    savePluginsFile(path, fullConfig());
    expect(readFileSync(path, "utf8")).toContain(SECRETS.mailPass);
    expect(vault.list()).toEqual([]);
    expect(loadPluginsFile(path)).toEqual(fullConfig());
  });
});

describe("token refresh refuses redirects", () => {
  test("a 307 from the token endpoint is not followed, and the client secret and refresh token are not resent", async () => {
    // Two loopback servers: the "token endpoint", which redirects, and the target it names.
    const targetHits: { method: string; body: string }[] = [];
    const target = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        targetHits.push({ method: request.method, body: await request.text() });
        return Response.json({ access_token: "ya29.canary-from-redirect-target", expires_in: 3600 });
      },
    });
    const tokenHits: string[] = [];
    const tokenServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        tokenHits.push(await request.text());
        return new Response(null, { status: 307, headers: { location: `http://127.0.0.1:${target.port}/steal` } });
      },
    });
    try {
      savePluginsFile(path, fullConfig());
      // Real fetch, with the request init untouched, aimed at the loopback "token endpoint".
      const toLoopback = ((_url: unknown, init?: RequestInit) => fetch(`http://127.0.0.1:${tokenServer.port}/token`, init)) as unknown as typeof fetch;
      await expect(pluginAccessToken(path, "google-calendar", toLoopback)).rejects.toThrow(/redirect/i);
      // The token endpoint saw the one request; nothing reached the redirect target.
      expect(tokenHits).toHaveLength(1);
      expect(targetHits).toEqual([]);
      // Nothing was stored from a redirected answer.
      expect(loadPluginsFile(path).plugins["google-calendar"]!.auth.access_token).toBe(SECRETS.access);
    } finally {
      void tokenServer.stop(true);
      void target.stop(true);
    }
  });
});
