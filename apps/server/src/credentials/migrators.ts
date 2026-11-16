/**
 * Moving the old plaintext credential stores into the vault, and back (S3-02).
 * `register.ts` lists these with the vault's migrators; `agni vault migrate`
 * runs them and `agni vault export --yes` reverses them.
 *
 * Every migrator follows the same order, so a failure at any point leaves the
 * old store whole:
 *   1. read the old store, and refuse (throw) if it cannot be understood;
 *   2. put each secret in the vault and read it back, comparing;
 *   3. only then rewrite the old store without the secrets (one atomic,
 *      owner-only write), or remove it.
 * No backup copy is made: a copy of a plaintext store under AGNI_HOME would hold
 * every secret in the clear. The old store is the backup until step 3, and
 * `agni vault export` is the way back. Each one is idempotent: after step 3 a
 * second run finds nothing to move and returns 0.
 *
 * Each returns how many secrets (or rows, or files) it moved.
 */
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { log } from "../log";
import { VaultError, type Vault, type VaultMigrationContext } from "../secrets/types";
import {
  applyPluginSecrets,
  collectPluginSecrets,
  stripPluginSecrets,
  writePluginsFileText,
  type PluginsFile,
} from "../plugins/config";
import { writePrivateFileSync } from "../util/private-file";
import { baseUrlCarriesCredential, sanitizeBaseUrl } from "./provider-urls";
import { entryName, eraseFile, rememberSecrets } from "./vault-mode";

// --- where the old stores are -------------------------------------------------------

/** The same per-file overrides the server honours, then the default under the home. */
const providersPath = (home: string): string => resolve(process.env.AGNI_PROVIDER_CONFIG_PATH?.trim() || join(home, "providers.json"));
const pluginsPath = (home: string): string => resolve(process.env.AGNI_PLUGINS_PATH?.trim() || join(home, "plugins.json"));
const databasePath = (home: string): string => resolve(process.env.AGNI_DB_PATH?.trim() || join(home, "data", "agni.sqlite"));
/** `ws/server.ts` keeps the ChatGPT accounts beside the database. */
const chatgptPath = (home: string): string => resolve(dirname(databasePath(home)), "chatgpt", "accounts.json");

// --- shared steps -------------------------------------------------------------------

/** Put a value in the vault and prove it reads back the same. Never includes the value in an error. */
function store(vault: Vault, name: string, value: string): void {
  vault.set(name, value);
  if (vault.get(name) !== value) throw new VaultError("WRITE_FAILED", `${name} could not be read back from the vault, so its old store was not changed.`);
  rememberSecrets(value);
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what} is not valid JSON, so it was left as it is. Fix or remove it and run this again.`);
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// --- provider endpoints (providers.json) --------------------------------------------

/** A key typed straight into a custom entry by hand. The loader ignores these; the vault must not keep them in a file. */
const INLINE_KEY_FIELDS = ["apiKey", "api_key"] as const;

/**
 * `providers.json` holds model choices and custom endpoints, normally no secret
 * (a key lives under the variable the entry names). Two things can still be in it:
 * an address with a credential in it, which moves to `provider-url/<id>` and leaves
 * a clean address, and a key typed into the entry, which moves to `env/<envKey>`.
 */
export function migrateProviderEndpoints(vault: Vault, context: VaultMigrationContext): number {
  const path = providersPath(context.home);
  const text = readText(path);
  if (text === undefined) return 0;
  const file = parseJson(text, "providers.json");
  if (!isObject(file) || !Array.isArray(file.custom)) return 0;
  let moved = 0;
  for (const entry of file.custom) {
    if (!isObject(entry) || typeof entry.id !== "string") continue;
    for (const field of INLINE_KEY_FIELDS) {
      const value = entry[field];
      if (typeof value !== "string" || value === "") continue;
      if (typeof entry.envKey !== "string" || entry.envKey === "") {
        throw new Error(`providers.json: the custom endpoint "${entry.id}" holds a key but no "envKey" to keep it under. Add an envKey (for example AGNI_CUSTOM_KEY_9) and run this again.`);
      }
      store(vault, entryName.env(entry.envKey), value);
      delete entry[field];
      moved += 1;
    }
    if (typeof entry.baseUrl === "string" && baseUrlCarriesCredential(entry.baseUrl)) {
      store(vault, entryName.providerUrl(entry.id), entry.baseUrl);
      entry.baseUrl = sanitizeBaseUrl(entry.baseUrl);
      moved += 1;
    }
  }
  if (moved > 0) writePrivateFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
  return moved;
}

/** Put each custom endpoint's full address back in providers.json. Keys are exported with the other `env/` entries. */
export function exportProviderEndpoints(vault: Vault, context: VaultMigrationContext): number {
  const prefix = "provider-url/";
  const names = vault.list(prefix);
  const path = providersPath(context.home);
  const text = readText(path);
  if (names.length === 0 || text === undefined) return 0;
  const file = parseJson(text, "providers.json");
  if (!isObject(file) || !Array.isArray(file.custom)) return 0;
  let restored = 0;
  for (const { name } of names) {
    const entry = file.custom.find((item) => isObject(item) && item.id === name.slice(prefix.length));
    const value = vault.get(name);
    if (!isObject(entry) || value === undefined) continue;
    entry.baseUrl = value;
    restored += 1;
  }
  if (restored > 0) writePrivateFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
  return restored;
}

// --- plugin secrets (plugins.json) --------------------------------------------------

/** Read plugins.json as the loader does, or throw: a file we cannot read may hold the only copy of the tokens. */
function readPluginsFile(path: string): PluginsFile | undefined {
  const text = readText(path);
  if (text === undefined) return undefined;
  const parsed = parseJson(text, "plugins.json");
  if (!isObject(parsed) || parsed.version !== 1 || !isObject(parsed.plugins)) {
    throw new Error("plugins.json is not in the expected format (version 1 with a plugins object), so it was left as it is.");
  }
  return parsed as unknown as PluginsFile;
}

/** Passwords, keys, tokens, MCP addresses and OAuth client secrets, as `plugin/<id>/<field>` and `plugin-oauth/<provider>/clientSecret`. */
export function migratePluginSecrets(vault: Vault, context: VaultMigrationContext): number {
  const path = pluginsPath(context.home);
  const file = readPluginsFile(path);
  if (!file) return 0;
  const secrets = collectPluginSecrets(file);
  if (secrets.size === 0) return 0;
  for (const [name, value] of secrets) store(vault, name, value);
  writePluginsFileText(path, stripPluginSecrets(file));
  return secrets.size;
}

/** Write every plugin secret back into plugins.json. */
export function exportPluginSecrets(vault: Vault, context: VaultMigrationContext): number {
  const path = pluginsPath(context.home);
  const file = readPluginsFile(path);
  if (!file) return 0;
  const before = collectPluginSecrets(file).size;
  applyPluginSecrets(file, vault);
  const restored = collectPluginSecrets(file).size - before;
  if (restored > 0) writePluginsFileText(path, file);
  return restored;
}

// --- OAuth tokens in the database (plugin_connections.tokens) -------------------------

const hasTokenRef = (db: Database): boolean =>
  db.query<{ name: string }, []>("PRAGMA table_info(plugin_connections)").all().some((column) => column.name === "token_ref");

/** The database must be handed over when it exists, and must be at migration 62: a quiet skip would leave tokens in plaintext. */
function tokenDatabase(context: VaultMigrationContext): Database | undefined {
  if (!context.db) {
    if (existsSync(databasePath(context.home))) {
      throw new Error(
        `The database at ${databasePath(context.home)} could not be opened, so the OAuth tokens in it were not moved. ` +
          "Stop the daemon, run `agni migrate`, then run this again.",
      );
    }
    return undefined;
  }
  if (!hasTokenRef(context.db)) {
    throw new Error("The database has not been upgraded to migration 62 (credential references). Run `agni migrate` first, then run this again.");
  }
  return context.db;
}

interface BlobCredential {
  access_token?: unknown;
  refresh_token?: unknown;
  state?: unknown;
  [key: string]: unknown;
}

/** A tokens column that holds a credential (a pending sign-in's `{state}` is not one), as the blob to keep. */
function credentialBlob(raw: string | null): { value: string; secrets: string[] } | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON: unknown content in a column that is only ever credentials. Keep it whole.
    return { value: raw, secrets: [raw] };
  }
  if (!isObject(parsed)) return { value: raw, secrets: [raw] };
  const blob = parsed as BlobCredential;
  const secrets = [blob.access_token, blob.refresh_token].filter((token): token is string => typeof token === "string" && token !== "");
  if (secrets.length === 0) return undefined;
  delete blob.state; // a sign-in's one-time state is not part of a connection's tokens
  return { value: JSON.stringify(blob), secrets };
}

/**
 * Move each connection's tokens into the vault (`plugin-token/<row id>`), read them
 * back, and only then empty the column and set `token_ref`. Free pages and the
 * write-ahead log of the database file would keep the old values, so the update
 * overwrites what it frees and the file is then compacted.
 */
export function migratePluginTokens(vault: Vault, context: VaultMigrationContext): number {
  const db = tokenDatabase(context);
  if (!db) return 0;
  const rows = db
    .query<{ id: string; tokens: string }, []>("SELECT id, tokens FROM plugin_connections WHERE token_ref IS NULL AND tokens IS NOT NULL AND tokens <> ''")
    .all();
  const pending: Array<{ id: string; tokens: string; name: string }> = [];
  for (const row of rows) {
    const blob = credentialBlob(row.tokens);
    if (!blob) continue;
    const name = entryName.connectionTokens(row.id);
    store(vault, name, blob.value);
    rememberSecrets(...blob.secrets);
    pending.push({ id: row.id, tokens: row.tokens, name });
  }
  if (pending.length === 0) return 0;
  const previous = db.query<{ secure_delete: number }, []>("PRAGMA secure_delete").get()?.secure_delete ?? 0;
  db.exec("PRAGMA secure_delete = ON");
  try {
    db.transaction(() => {
      // Only a row nobody changed since it was read: a newer value is left for the next run.
      for (const row of pending) db.run("UPDATE plugin_connections SET tokens = NULL, token_ref = ? WHERE id = ? AND tokens = ? AND token_ref IS NULL", [row.name, row.id, row.tokens]);
    })();
  } finally {
    db.exec(`PRAGMA secure_delete = ${previous ? "ON" : "OFF"}`);
  }
  purgeDatabaseResidue(db);
  return pending.length;
}

/** Make the database file itself free of the old column values: checkpoint the log away, then rewrite the file compactly. */
function purgeDatabaseResidue(db: Database): void {
  for (const statement of ["PRAGMA wal_checkpoint(TRUNCATE)", "VACUUM", "PRAGMA wal_checkpoint(TRUNCATE)"]) {
    try {
      db.exec(statement);
    } catch {
      // Another process holds the database. The tokens are in the vault and the column is empty; the old bytes remain in
      // free pages until a compaction, so say so rather than claim more than was done.
      log.warn("The database could not be compacted (it is in use), so old token bytes may remain in its free pages. Stop the daemon and run `agni vault migrate` again to remove them.");
      return;
    }
  }
}

/** Put each connection's tokens back in its column. */
export function exportPluginTokens(vault: Vault, context: VaultMigrationContext): number {
  const db = tokenDatabase(context);
  if (!db) return 0;
  const rows = db.query<{ id: string; token_ref: string }, []>("SELECT id, token_ref FROM plugin_connections WHERE token_ref IS NOT NULL").all();
  let restored = 0;
  db.transaction(() => {
    for (const row of rows) {
      const value = vault.get(row.token_ref);
      if (value === undefined) continue;
      db.run("UPDATE plugin_connections SET tokens = ?, token_ref = NULL WHERE id = ?", [value, row.id]);
      restored += 1;
    }
  })();
  return restored;
}

// --- ChatGPT accounts -----------------------------------------------------------------

/** The whole accounts file becomes one vault entry. The file is removed once the vault holds it. */
export function migrateChatgptAccounts(vault: Vault, context: VaultMigrationContext): number {
  const path = chatgptPath(context.home);
  const text = readText(path);
  if (text === undefined) return 0;
  const parsed = parseJson(text, "The ChatGPT accounts file");
  if (!isObject(parsed) || !Array.isArray(parsed.accounts)) {
    throw new Error("The ChatGPT accounts file is not in the expected format, so it was left as it is. Move it aside and sign in to ChatGPT again.");
  }
  store(vault, entryName.chatgptAccounts, text);
  for (const account of parsed.accounts) {
    const tokens = isObject(account) && isObject(account.tokens) ? account.tokens : {};
    rememberSecrets(tokens.accessToken as string | undefined, tokens.refreshToken as string | undefined, tokens.idToken as string | undefined);
  }
  eraseFile(path);
  return 1;
}

/** Write the accounts back to `chatgpt/accounts.json`, owner-only. */
export function exportChatgptAccounts(vault: Vault, context: VaultMigrationContext): number {
  const text = vault.get(entryName.chatgptAccounts);
  if (text === undefined) return 0;
  const path = chatgptPath(context.home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writePrivateFileSync(path, text);
  return 1;
}
