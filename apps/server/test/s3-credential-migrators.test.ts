/**
 * S3-02: moving every plaintext credential into the vault, and back.
 *
 * One fixture home holds a credential in every old store: config.env (a catalog
 * key and two custom-endpoint keys), providers.json (a credentialed address and
 * an inline key), plugins.json (passwords, keys, tokens, client secret, an MCP
 * address), the database (OAuth tokens, one row rewritten several times so old
 * versions sit in free pages), and the ChatGPT accounts file. Every secret is a
 * distinct canary string. The vault migration is only ever run on this fixture.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db";
import { loadProviders } from "../src/models/providers";
import { ChatGPTAuth } from "../src/models/chatgpt-auth";
import { loadPluginsFile } from "../src/plugins/config";
import { readConnectionTokens, getConnectionFor } from "../src/plugins/store";
import {
  VaultError,
  lockVault,
  listVaultMigrators,
  runVaultExport,
  runVaultMigrations,
  unlockVault,
  type Vault,
} from "../src/secrets";
import "../src/secrets/migrate";
import { parseEnvFile } from "../src/home";
import { unlockVaultAtStart } from "../src/startup/s3-vault";

const C = {
  groq: "gsk_canary_groq_key_0000000001",
  custom1: "sk-canary-custom-key-one-0000002",
  custom2: "sk-canary-custom-key-two-0000003",
  inline: "sk-canary-inline-json-key-0000004",
  urlPass: "canary-url-password-0000005",
  urlParam: "canary-url-param-value-0000006",
  mailPass: "canary-mail-app-password-0000007",
  fcKey: "fc-canary-firecrawl-key-0000008",
  access: "ya29.canary-plugin-access-0000009",
  refresh: "1//canary-plugin-refresh-0000010",
  mcpKey: "canary-mcp-bearer-0000011",
  mcpUrl: "canary-mcp-path-secret-0000012",
  clientSecret: "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",
  dbAccess: "ya29.canary-db-access-0000014",
  dbRefresh: "1//canary-db-refresh-0000015",
  dbPassword: "canary-db-app-password-0000016",
  dbOldA: "ya29.canary-db-OLD-access-A-0000017",
  dbOldB: "ya29.canary-db-OLD-access-B-0000018",
  chatAccess: "canary-chatgpt-access-0000019",
  chatRefresh: "canary-chatgpt-refresh-0000020",
  chatId: "canary-chatgpt-id-token-0000021",
};
const CANARIES = Object.values(C);

const ENV_KEYS = ["AGNI_HOME", "AGNI_SECRETS_MODE", "AGNI_PLUGINS_PATH", "AGNI_PROVIDER_CONFIG_PATH", "AGNI_DB_PATH", "GROQ_API_KEY", "AGNI_CUSTOM_KEY_1", "AGNI_CUSTOM_KEY_2"];
const saved: Record<string, string | undefined> = {};
let parent = "";
let home = "";
/** The connection that wrote the fixture stays open, as the daemon's would: its write-ahead log keeps every old page version. */
let writer: Database | undefined;

beforeEach(() => {
  for (const name of ENV_KEYS) saved[name] = process.env[name];
  for (const name of ENV_KEYS) delete process.env[name];
  lockVault();
  parent = mkdtempSync(join(tmpdir(), "agni-credmig-"));
  home = join(parent, "home");
});
afterEach(() => {
  writer?.close();
  writer = undefined;
  lockVault();
  for (const name of ENV_KEYS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  rmSync(parent, { recursive: true, force: true });
});

const PROVIDERS_JSON = {
  version: 1,
  models: { groq: "llama-x" },
  custom: [
    { id: "custom", label: "Gateway", baseUrl: `https://user:${C.urlPass}@gateway.example.com/v1?api_key=${C.urlParam}`, model: "m1", envKey: "AGNI_CUSTOM_KEY_1" },
    { id: "custom-2", label: "Second", baseUrl: "https://second.example.com/v1", model: "m2", envKey: "AGNI_CUSTOM_KEY_2", apiKey: C.inline },
  ],
};

const PLUGINS_JSON = {
  version: 1,
  oauthClients: { google: { clientID: "client-id-visible", clientSecret: C.clientSecret } },
  plugins: {
    gmail: { account: "agent", enabled: true, auth: { kind: "app-password", user: "agent@example.com", pass: C.mailPass }, label: "agent@example.com" },
    firecrawl: { account: "owner", enabled: true, auth: { kind: "api-key", key: C.fcKey, url: "http://localhost:3002" } },
    "google-calendar": { account: "agent", enabled: true, auth: { kind: "oauth", access_token: C.access, refresh_token: C.refresh, expires_at: 42 } },
    granola: { account: "owner", enabled: true, auth: { kind: "mcp", key: C.mcpKey, url: `https://mcp.example.com/s/${C.mcpUrl}` }, trustedTools: ["search"], local: true },
  },
};

const CHATGPT_JSON = JSON.stringify({
  version: 1,
  hostID: "urn:uuid:11111111-2222-3333-4444-555555555555",
  activeID: "acc1",
  accounts: [
    {
      id: "acc1", clientID: "client-1", subject: "sub-1", email: "owner@example.test", model: "m1",
      models: [{ id: "m1", label: "Model one", vision: false }],
      tokens: { accessToken: C.chatAccess, refreshToken: C.chatRefresh, idToken: C.chatId, expiresAt: Date.now() + 3_600_000, earliestRefreshAt: 0, scopes: ["resource.invoke", "chatgpt.tokens.use.direct"] },
      needsLogin: false, permissionDisabled: false, welcomed: false,
    },
  ],
});

/** Build the fixture home. Returns the ids of the two connection rows. */
function buildHome(): { calendarRow: string; gmailRow: string; pendingRow: string } {
  mkdirSync(join(home, "data", "chatgpt"), { recursive: true });
  writeFileSync(join(home, "config.env"), `AGNI_PORT=8787\nGROQ_API_KEY=${C.groq}\nAGNI_CUSTOM_KEY_1=${C.custom1}\nAGNI_CUSTOM_KEY_2=${C.custom2}\n`);
  writeFileSync(join(home, "providers.json"), `${JSON.stringify(PROVIDERS_JSON, null, 2)}\n`);
  writeFileSync(join(home, "plugins.json"), `${JSON.stringify(PLUGINS_JSON, null, 2)}\n`);
  writeFileSync(join(home, "data", "chatgpt", "accounts.json"), CHATGPT_JSON);

  const db = openDatabase(join(home, "data", "agni.sqlite"));
  writer = db;
  const insert = (id: string, plugin: string, account: string, status: string, tokens: string) =>
    db.run(
      "INSERT INTO plugin_connections (id, plugin_id, account, status, account_label, scopes, capabilities, tokens, error, grant_started_at, connected_at, updated_at) VALUES (?, ?, ?, ?, 'me', '[]', '[]', ?, NULL, 'now', 'now', 'now')",
      [id, plugin, account, status, tokens],
    );
  insert("plc_calendar", "calendar", "agent", "connected", JSON.stringify({ refresh_token: C.dbRefresh, access_token: C.dbAccess, expires_at: 1234 }));
  insert("plc_gmail", "gmail", "agent", "connected", JSON.stringify({ access_token: C.dbPassword }));
  insert("plc_pending", "drive", "owner", "pending", JSON.stringify({ state: "st_abc123" }));
  // Old token versions: rewrite the calendar row, with filler rows around it, so free pages hold earlier plaintext.
  for (let index = 0; index < 40; index += 1) db.run("INSERT INTO meta (key, value) VALUES (?, ?)", [`filler_${index}`, "x".repeat(900)]);
  for (const old of [C.dbOldA, C.dbOldB]) {
    db.run("UPDATE plugin_connections SET tokens = ? WHERE id = 'plc_calendar'", [JSON.stringify({ refresh_token: C.dbRefresh, access_token: old })]);
    db.run("DELETE FROM meta WHERE key LIKE 'filler_%'");
    for (let index = 0; index < 40; index += 1) db.run("INSERT INTO meta (key, value) VALUES (?, ?)", [`filler_${index}`, "y".repeat(900)]);
  }
  db.run("UPDATE plugin_connections SET tokens = ? WHERE id = 'plc_calendar'", [JSON.stringify({ refresh_token: C.dbRefresh, access_token: C.dbAccess, expires_at: 1234 })]);
  return { calendarRow: "plc_calendar", gmailRow: "plc_gmail", pendingRow: "plc_pending" };
}

const filesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? filesUnder(join(dir, name)) : [join(dir, name)]));

/** Every (file, canary) pair where the file holds the canary in clear. Looks at every byte of every file, including the database and its journal. */
function plaintextHits(): string[] {
  const hits: string[] = [];
  for (const file of filesUnder(home)) {
    const bytes = readFileSync(file);
    for (const [name, canary] of Object.entries(C)) if (bytes.includes(canary)) hits.push(`${file.slice(home.length + 1)}: ${name}`);
  }
  return hits;
}

const hashOf = (path: string): string => (existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : "missing");
const fixtureFiles = (): string[] => ["config.env", "providers.json", "plugins.json", "data/chatgpt/accounts.json"].map((name) => join(home, ...name.split("/")));

async function migrate(vault: Vault): Promise<Record<string, number>> {
  const db = new Database(join(home, "data", "agni.sqlite"), { readwrite: true });
  try {
    return Object.fromEntries((await runVaultMigrations(vault, { home, db })).map((result) => [result.name, result.count]));
  } finally {
    db.close();
  }
}

describe("registration", () => {
  test("loading the vault's migration module is enough to have every credential migrator registered", () => {
    expect(listVaultMigrators().map((migrator) => migrator.name)).toEqual(
      expect.arrayContaining(["config-env", "provider-endpoints", "plugin-secrets", "plugin-tokens", "chatgpt-accounts"]),
    );
    for (const name of ["provider-endpoints", "plugin-secrets", "plugin-tokens", "chatgpt-accounts"]) {
      expect(typeof listVaultMigrators().find((migrator) => migrator.name === name)?.export).toBe("function");
    }
  });
});

describe("migrate", () => {
  test("every credential moves, and the canary is in no plaintext byte anywhere under the home", async () => {
    buildHome();
    expect(plaintextHits().length).toBeGreaterThan(10); // the fixture really is plaintext first
    // ...including old token versions in the database's write-ahead log, which only a checkpoint removes.
    expect(plaintextHits()).toEqual(expect.arrayContaining([expect.stringMatching(/agni\.sqlite-wal: dbOld/)]));
    const vault = await unlockVault({ home, create: true });
    const counts = await migrate(vault);

    expect(counts).toMatchObject({ "config-env": 3, "provider-endpoints": 2, "plugin-secrets": 7, "plugin-tokens": 2, "chatgpt-accounts": 1 });
    expect(plaintextHits()).toEqual([]);
    // Nothing else changed shape: the settings are still there to read.
    expect(readFileSync(join(home, "config.env"), "utf8")).toContain("AGNI_PORT=8787");
    expect(JSON.parse(readFileSync(join(home, "plugins.json"), "utf8")).plugins.granola).toMatchObject({ trustedTools: ["search"], local: true });
    expect(existsSync(join(home, "data", "chatgpt", "accounts.json"))).toBe(false);
  });

  test("the vault holds every value, readable by the name each store uses", async () => {
    buildHome();
    const vault = await unlockVault({ home, create: true });
    await migrate(vault);
    expect(vault.get("env/GROQ_API_KEY")).toBe(C.groq);
    expect(vault.get("env/AGNI_CUSTOM_KEY_1")).toBe(C.custom1);
    expect(vault.get("env/AGNI_CUSTOM_KEY_2")).toBe(C.custom2);
    expect(vault.get("provider-url/custom")).toContain(C.urlPass);
    expect(vault.get("plugin/gmail/pass")).toBe(C.mailPass);
    expect(vault.get("plugin/granola/url")).toContain(C.mcpUrl);
    expect(vault.get("plugin-oauth/google/clientSecret")).toBe(C.clientSecret);
    expect(JSON.parse(vault.get("plugin-token/plc_calendar")!)).toEqual({ refresh_token: C.dbRefresh, access_token: C.dbAccess, expires_at: 1234 });
    expect(JSON.parse(vault.get("chatgpt/accounts")!).accounts[0].tokens.accessToken).toBe(C.chatAccess);
  });

  test("the database rows keep a reference only; the pending sign-in's state is not a credential and is left", async () => {
    const rows = buildHome();
    const vault = await unlockVault({ home, create: true });
    await migrate(vault);
    const db = new Database(join(home, "data", "agni.sqlite"));
    const calendar = db.query<{ tokens: string | null; token_ref: string | null }, [string]>("SELECT tokens, token_ref FROM plugin_connections WHERE id = ?").get(rows.calendarRow)!;
    expect(calendar).toEqual({ tokens: null, token_ref: "plugin-token/plc_calendar" });
    const pending = db.query<{ tokens: string | null; token_ref: string | null }, [string]>("SELECT tokens, token_ref FROM plugin_connections WHERE id = ?").get(rows.pendingRow)!;
    expect(pending).toEqual({ tokens: JSON.stringify({ state: "st_abc123" }), token_ref: null });
    db.close();
  });

  test("it is idempotent: a second run moves nothing and changes no file", async () => {
    buildHome();
    const vault = await unlockVault({ home, create: true });
    await migrate(vault);
    const before = fixtureFiles().map(hashOf);
    const again = await migrate(vault);
    expect(again).toEqual({ "config-env": 0, "provider-endpoints": 0, "plugin-secrets": 0, "plugin-tokens": 0, "chatgpt-accounts": 0 });
    expect(fixtureFiles().map(hashOf)).toEqual(before);
    expect(plaintextHits()).toEqual([]);
  });
});

describe("then serve: every credential reads back through the code that uses it", () => {
  test("after a restart (vault locked and unlocked from disk)", async () => {
    const rows = buildHome();
    let vault = await unlockVault({ home, create: true });
    await migrate(vault);
    lockVault();

    // The start-up path: mode from config.env, vault opened, `env/<NAME>` entries become variables.
    process.env.AGNI_HOME = home;
    process.env.AGNI_SECRETS_MODE = "vault";
    const started = await unlockVaultAtStart({ env: process.env as Record<string, string | undefined>, home });
    expect(started).toMatchObject({ mode: "vault", unlocked: true });
    vault = await unlockVault({ home });

    const providers = loadProviders(process.env as Record<string, string | undefined>);
    expect(providers.find((provider) => provider.id === "groq")?.apiKey).toBe(C.groq);
    const custom = providers.find((provider) => provider.id === "custom")!;
    expect(custom.apiKey).toBe(C.custom1);
    expect(custom.baseUrl).toBe(`https://user:${C.urlPass}@gateway.example.com/v1?api_key=${C.urlParam}`);
    expect(providers.find((provider) => provider.id === "custom-2")?.apiKey).toBe(C.custom2);

    const plugins = loadPluginsFile(join(home, "plugins.json"));
    expect(plugins).toEqual(PLUGINS_JSON as never);

    const db = new Database(join(home, "data", "agni.sqlite"));
    const row = getConnectionFor(db as never, "calendar", "agent")!;
    expect(readConnectionTokens(row)).toEqual({ refresh_token: C.dbRefresh, access_token: C.dbAccess, expires_at: 1234 });
    expect(readConnectionTokens(getConnectionFor(db as never, "gmail", "agent")!)).toEqual({ access_token: C.dbPassword });
    expect(rows.calendarRow).toBe(row.id);
    db.close();

    const chatgpt = new ChatGPTAuth({ filePath: join(home, "data", "chatgpt", "accounts.json"), fetchFn: fetch });
    try {
      expect(await chatgpt.accessToken()).toBe(C.chatAccess);
    } finally {
      chatgpt.stop();
    }
    expect(vault.list().length).toBeGreaterThan(10);
  });
});

describe("export reverses it", () => {
  test("every store is plaintext again, equal to what it was", async () => {
    buildHome();
    const originalEnv = parseEnvFile(readFileSync(join(home, "config.env"), "utf8"));
    const vault = await unlockVault({ home, create: true });
    await migrate(vault);
    expect(plaintextHits()).toEqual([]);

    const db = new Database(join(home, "data", "agni.sqlite"), { readwrite: true });
    try {
      const results = await runVaultExport(vault, { home, db });
      expect(Object.fromEntries(results.map((result) => [result.name, result.count]))).toMatchObject({
        "provider-endpoints": 1,
        "plugin-secrets": 7,
        "plugin-tokens": 2,
        "chatgpt-accounts": 1,
      });
    } finally {
      db.close();
    }

    expect(parseEnvFile(readFileSync(join(home, "config.env"), "utf8"))).toMatchObject(originalEnv);
    const providers = JSON.parse(readFileSync(join(home, "providers.json"), "utf8"));
    expect(providers.custom[0].baseUrl).toBe(PROVIDERS_JSON.custom[0]!.baseUrl);
    expect(JSON.parse(readFileSync(join(home, "plugins.json"), "utf8"))).toEqual(PLUGINS_JSON);
    expect(readFileSync(join(home, "data", "chatgpt", "accounts.json"), "utf8")).toBe(CHATGPT_JSON);
    const check = new Database(join(home, "data", "agni.sqlite"));
    expect(JSON.parse(check.query<{ tokens: string }, []>("SELECT tokens FROM plugin_connections WHERE id = 'plc_calendar'").get()!.tokens)).toEqual({
      refresh_token: C.dbRefresh,
      access_token: C.dbAccess,
      expires_at: 1234,
    });
    expect(check.query<{ token_ref: string | null }, []>("SELECT token_ref FROM plugin_connections WHERE id = 'plc_calendar'").get()!.token_ref).toBeNull();
    check.close();
  });
});

/** A vault that forwards to the real one, except where a test says to fail. */
function flaky(real: Vault, behaviour: { failSetAfter?: number; tamperGet?: boolean }): Vault {
  let sets = 0;
  return {
    path: real.path,
    keystoreKind: real.keystoreKind,
    get: (name) => {
      const value = real.get(name);
      return behaviour.tamperGet && value !== undefined && !name.startsWith("env/") ? `${value}-tampered` : value;
    },
    set: (name, value) => {
      if (behaviour.failSetAfter !== undefined && sets >= behaviour.failSetAfter) throw new VaultError("WRITE_FAILED", "the disk went away");
      sets += 1;
      real.set(name, value);
    },
    delete: (name) => real.delete(name),
    list: (prefix) => real.list(prefix),
    has: (name) => real.has(name),
    refresh: () => real.refresh(),
  };
}

describe("a failure part way leaves the old files in place", () => {
  const migratorNames = ["provider-endpoints", "plugin-secrets", "plugin-tokens", "chatgpt-accounts"];
  const sources = (): Record<string, string[]> => ({
    "provider-endpoints": [join(home, "providers.json")],
    "plugin-secrets": [join(home, "plugins.json")],
    "chatgpt-accounts": [join(home, "data", "chatgpt", "accounts.json")],
    "plugin-tokens": [],
  });

  test.each(migratorNames)("%s: the vault cannot be written at all", async (name) => {
    buildHome();
    const real = await unlockVault({ home, create: true });
    const files = sources()[name]!;
    const before = files.map(hashOf);
    const db = new Database(join(home, "data", "agni.sqlite"), { readwrite: true });
    const rowsBefore = db.query("SELECT id, tokens, token_ref FROM plugin_connections ORDER BY id").all();
    const migrator = listVaultMigrators().find((entry) => entry.name === name)!;
    await expect(Promise.resolve().then(() => migrator.migrate(flaky(real, { failSetAfter: 0 }), { home, backupDir: join(parent, "bk"), db }))).rejects.toThrow();
    expect(files.map(hashOf)).toEqual(before);
    expect(db.query("SELECT id, tokens, token_ref FROM plugin_connections ORDER BY id").all()).toEqual(rowsBefore);
    db.close();
  });

  test.each(migratorNames)("%s: the vault cannot read back what was written", async (name) => {
    buildHome();
    const real = await unlockVault({ home, create: true });
    const files = sources()[name]!;
    const before = files.map(hashOf);
    const db = new Database(join(home, "data", "agni.sqlite"), { readwrite: true });
    const rowsBefore = db.query("SELECT id, tokens, token_ref FROM plugin_connections ORDER BY id").all();
    const migrator = listVaultMigrators().find((entry) => entry.name === name)!;
    await expect(Promise.resolve().then(() => migrator.migrate(flaky(real, { tamperGet: true }), { home, backupDir: join(parent, "bk"), db }))).rejects.toThrow();
    expect(files.map(hashOf)).toEqual(before);
    expect(db.query("SELECT id, tokens, token_ref FROM plugin_connections ORDER BY id").all()).toEqual(rowsBefore);
    db.close();
  });

  test("tokens: a crash between the vault copy and the column change leaves the column whole, and a rerun finishes", async () => {
    buildHome();
    const vault = await unlockVault({ home, create: true });
    const db = new Database(join(home, "data", "agni.sqlite"), { readwrite: true });
    // The update that would empty the column fails, as a crash at that moment would.
    db.exec("CREATE TRIGGER crash BEFORE UPDATE OF tokens ON plugin_connections BEGIN SELECT RAISE(ABORT, 'crash'); END;");
    const migrator = listVaultMigrators().find((entry) => entry.name === "plugin-tokens")!;
    await expect(Promise.resolve().then(() => migrator.migrate(vault, { home, backupDir: join(parent, "bk"), db }))).rejects.toThrow();
    expect(db.query<{ tokens: string | null }, []>("SELECT tokens FROM plugin_connections WHERE id = 'plc_calendar'").get()!.tokens).toContain(C.dbRefresh);
    db.exec("DROP TRIGGER crash");
    expect(await migrator.migrate(vault, { home, backupDir: join(parent, "bk"), db })).toBe(2);
    expect(db.query<{ tokens: string | null }, []>("SELECT tokens FROM plugin_connections WHERE id = 'plc_calendar'").get()!.tokens).toBeNull();
    db.close();
  });

  test("a stop in the middle of the whole run leaves every unfinished store plaintext and usable, and the rerun completes", async () => {
    buildHome();
    const real = await unlockVault({ home, create: true });
    const db = new Database(join(home, "data", "agni.sqlite"), { readwrite: true });
    // Allow a few writes, then fail: some migrators finish, one fails, the rest never run.
    await expect(runVaultMigrations(flaky(real, { failSetAfter: 5 }), { home, db })).rejects.toThrow();
    const stillPlaintext = plaintextHits();
    expect(stillPlaintext.length).toBeGreaterThan(0);
    // Whatever is still plaintext is a store that was not touched at all, never one half rewritten.
    for (const path of fixtureFiles()) {
      if (existsSync(path)) expect(() => (path.endsWith(".json") ? JSON.parse(readFileSync(path, "utf8")) : parseEnvFile(readFileSync(path, "utf8")))).not.toThrow();
    }
    const results = await runVaultMigrations(real, { home, db });
    db.close();
    expect(results.length).toBeGreaterThan(0);
    expect(plaintextHits()).toEqual([]);
  });

  test("tokens: the database exists but was not handed over, so the run stops instead of silently skipping it", async () => {
    buildHome();
    const vault = await unlockVault({ home, create: true });
    const migrator = listVaultMigrators().find((entry) => entry.name === "plugin-tokens")!;
    await expect(Promise.resolve().then(() => migrator.migrate(vault, { home, backupDir: join(parent, "bk") }))).rejects.toThrow(/agni migrate/);
  });

  test("tokens: with no database at all there is nothing to move", async () => {
    const vault = await unlockVault({ home, create: true });
    const migrator = listVaultMigrators().find((entry) => entry.name === "plugin-tokens")!;
    expect(await migrator.migrate(vault, { home, backupDir: join(parent, "bk") })).toBe(0);
  });

  test("tokens: a database that has not been upgraded to migration 62 is refused with the way forward", async () => {
    mkdirSync(join(home, "data"), { recursive: true });
    const old = new Database(join(home, "data", "agni.sqlite"));
    old.exec("CREATE TABLE plugin_connections (id TEXT PRIMARY KEY, plugin_id TEXT, account TEXT, status TEXT, tokens TEXT)");
    old.run("INSERT INTO plugin_connections VALUES ('a', 'calendar', 'agent', 'connected', ?)", [JSON.stringify({ access_token: C.dbAccess })]);
    const vault = await unlockVault({ home, create: true });
    const migrator = listVaultMigrators().find((entry) => entry.name === "plugin-tokens")!;
    await expect(Promise.resolve().then(() => migrator.migrate(vault, { home, backupDir: join(parent, "bk"), db: old }))).rejects.toThrow(/agni migrate/);
    old.close();
  });
});

describe("malformed stores", () => {
  test("a plugins.json that is not valid JSON stops the run and is left exactly as it is", async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "plugins.json"), `{ "version": 1, "plugins": { "gmail": { "auth": { "pass": "${C.mailPass}"`);
    const before = hashOf(join(home, "plugins.json"));
    const vault = await unlockVault({ home, create: true });
    const migrator = listVaultMigrators().find((entry) => entry.name === "plugin-secrets")!;
    await expect(Promise.resolve().then(() => migrator.migrate(vault, { home, backupDir: join(parent, "bk") }))).rejects.toThrow(/plugins\.json/);
    expect(hashOf(join(home, "plugins.json"))).toBe(before);
  });

  test("a ChatGPT accounts file that is not valid JSON is not moved and not deleted", async () => {
    mkdirSync(join(home, "data", "chatgpt"), { recursive: true });
    writeFileSync(join(home, "data", "chatgpt", "accounts.json"), '{"version":1,"accounts":[{"tokens":');
    const before = hashOf(join(home, "data", "chatgpt", "accounts.json"));
    const vault = await unlockVault({ home, create: true });
    const migrator = listVaultMigrators().find((entry) => entry.name === "chatgpt-accounts")!;
    await expect(Promise.resolve().then(() => migrator.migrate(vault, { home, backupDir: join(parent, "bk") }))).rejects.toThrow(/ChatGPT/);
    expect(hashOf(join(home, "data", "chatgpt", "accounts.json"))).toBe(before);
    expect(vault.has("chatgpt/accounts")).toBe(false);
  });

  test("a custom entry holding a key but no variable name to put it under stops the run", async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "providers.json"), JSON.stringify({ version: 1, custom: [{ id: "custom", baseUrl: "https://x.example.com/v1", apiKey: C.inline }] }));
    const vault = await unlockVault({ home, create: true });
    const migrator = listVaultMigrators().find((entry) => entry.name === "provider-endpoints")!;
    await expect(Promise.resolve().then(() => migrator.migrate(vault, { home, backupDir: join(parent, "bk") }))).rejects.toThrow(/custom/);
  });
});
