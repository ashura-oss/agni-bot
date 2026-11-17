/**
 * plugins.json — the single source of truth for plugin auth, tokens, and
 * activation state. Replaces plugin credentials in .env: the daemon reads
 * this file on startup, and the agent can manage its own plugins here in the
 * future (plugin.create / plugin.configure tools).
 *
 * File location: ~/.agni/plugins.json by default (`AGNI_PLUGINS_PATH`;
 * server-side only, mode 600).
 *
 * Schema:
 * {
 *   "version": 1,
 *   "plugins": {
 *     "<pluginID>": {
 *       "account": "agent" | "owner",
 *       "enabled": true,
 *       "auth": { ... }   // kind-specific credentials
 *     }
 *   }
 * }
 *
 * Auth kinds:
 *   app-password: { kind, user, pass }
 *   api-key:       { kind, key?, url? }        // key = cloud API key, url = self-hosted
 *   oauth:         { kind, refresh_token?, access_token?, expires_at? }
 *   mcp:           { kind, key?, url? }         // bearer token / server URL
 *
 * An MCP entry may also carry `trustedTools: string[]`, the owner's list of the
 * server's tools that may run without asking (see PluginEntry).
 *
 * Secrets (S3-02). In vault mode the passwords, keys, tokens and OAuth client
 * secrets below are NOT written to this file: `savePluginsFile` stores them in
 * the vault (`plugin/<id>/<field>`, `plugin-oauth/<provider>/clientSecret`) and
 * writes the rest, and `loadPluginsFile` puts them back, so callers see one
 * whole config either way. A secret found in the file in vault mode (not yet
 * migrated, or typed by hand) is used and moves to the vault at the next save.
 */
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { entryName, vaultForReads, vaultForWrites } from "../credentials/vault-mode";
import { forgetSecretSlots, rememberSecretsAt, stageSecretsAt, type SlotSecret } from "../util/redact";
import { log } from "../log";
import { valueCarriesCredential } from "../secrets/classify";
import { VaultError, type Vault } from "../secrets/types";
import { restrictToOwnerOnWindows } from "../util/windows-acl";

/** Directories already given the Windows owner-only ACL by this process. */
const securedDirs = new Set<string>();

/**
 * Windows has no mode bits, so the 0700/0600 below do nothing there. Give the
 * directory an owner-only ACL once per process: the config, its temp file and
 * the `.corrupt` copy all live in it and inherit it. Creating the directory
 * again (it was deleted while the server ran) clears its entry in the cache.
 */
function secureDirOnWindows(dir: string): void {
  if (process.platform !== "win32" || securedDirs.has(dir)) return;
  restrictToOwnerOnWindows(dir, true);
  securedDirs.add(dir);
}

/** Configs loaded from an unreadable file: saving one would wipe the stored credentials. */
const unreadable = new WeakSet<PluginsFile>();

export interface PluginAuth {
  kind: "app-password" | "api-key" | "oauth" | "mcp";
  // app-password
  user?: string;
  pass?: string;
  // api-key
  key?: string;
  url?: string;
  // oauth
  refresh_token?: string;
  access_token?: string;
  expires_at?: number;
}

export interface PluginEntry {
  account: "agent" | "owner";
  enabled: boolean;
  auth: PluginAuth;
  /** Display label (e.g. the signed-in email), set at connect time. */
  label?: string;
  /** Epoch ms of the last successful connect. */
  connectedAt?: number;
  /**
   * MCP plugins: the server's own tool names (as it lists them, e.g. "search")
   * that the owner has marked trusted. Only these can run without an approval
   * card, and only when the catalog's `read` mode is `free`. A server's own
   * `readOnlyHint` never counts. Edited by hand in plugins.json for now. The
   * file on disk is the authority: it is re-read at every MCP connect and
   * before every save (see syncTrustedTools), so an edit takes effect on the
   * next reconnect and is never written over. The hub applies it at connect.
   */
  trustedTools?: string[];
  /**
   * MCP plugins: the owner's statement that this server is on a private network
   * (a LAN server, a tunnel), which lifts the private-address check on its URL.
   * Only the literal `true` counts. Edited by hand in plugins.json and synced
   * from the file on disk exactly like `trustedTools` (see syncTrustedTools).
   */
  local?: boolean;
}

export interface OAuthClient {
  clientID: string;
  clientSecret: string;
}

export interface PluginsFile {
  version: number;
  /** OAuth client credentials keyed by provider (e.g. "google"). */
  oauthClients?: Record<string, OAuthClient>;
  plugins: Record<string, PluginEntry>;
}

export function emptyPluginsFile(): PluginsFile {
  return { version: 1, plugins: {} };
}

export function loadPluginsFile(path: string): PluginsFile {
  if (!existsSync(path)) return emptyPluginsFile();
  let loaded: PluginsFile | undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as PluginsFile;
    if (parsed.version === 1 && parsed.plugins && typeof parsed.plugins === "object") {
      // Vault mode: the secrets are not in the file. With the vault locked they are simply absent (and a save is refused).
      const vault = vaultForReads();
      if (vault) applyPluginSecrets(parsed, vault);
      loaded = parsed;
    }
  } catch {
    // fall through: treat as unreadable below
  }
  if (loaded) {
    // What is stored is committed state: mask it from the first line the server logs, not only after the first save.
    // Outside the try above: a registry that refuses must not make a good file look corrupt.
    settlePluginSecrets(loaded);
    return loaded;
  }
  // Run with no plugins, but never save over the file: it may hold the only copy of the tokens.
  let kept = false;
  try {
    secureDirOnWindows(dirname(path));
    copyFileSync(path, `${path}.corrupt`);
    chmodSync(`${path}.corrupt`, 0o600);
    kept = true;
  } catch { /* best effort */ }
  log.error(`plugins file ${path} is unreadable; ${kept ? `kept a copy at ${path}.corrupt and ` : "could not keep a copy, and "}will not overwrite it`);
  const empty = emptyPluginsFile();
  unreadable.add(empty);
  return empty;
}

export function savePluginsFile(path: string, config: PluginsFile): void {
  if (unreadable.has(config)) {
    throw new Error(`refusing to overwrite unreadable ${path}; fix or remove it and restart`);
  }
  // Whatever mode, a secret being saved must never reach a log line or a frame: register it before anything else.
  registerPluginSecrets(config);
  saveSecretsAndFile(path, config);
  settlePluginSecrets(config);
}

function saveSecretsAndFile(path: string, config: PluginsFile): void {
  // Vault mode: secrets first (read back), then the file without them, then forget what is gone. A crash at any
  // point leaves every secret in the vault or in the old file, never in neither.
  const vault = vaultForWrites();
  if (!vault) return writePluginsFileText(path, config);
  const secrets = collectPluginSecrets(config);
  for (const [name, value] of secrets) {
    if (vault.get(name) === value) continue;
    vault.set(name, value);
    if (vault.get(name) !== value) throw new VaultError("WRITE_FAILED", "A plugin credential could not be read back from the vault, so plugins.json was not changed.");
  }
  writePluginsFileText(path, stripPluginSecrets(config));
  for (const prefix of [PLUGIN_PREFIX, OAUTH_PREFIX]) {
    for (const { name } of vault.list(prefix)) if (!secrets.has(name)) vault.delete(name);
  }
}

/** Write the config as given: atomic and owner-only. The vault is not involved. */
export function writePluginsFileText(path: string, config: PluginsFile): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    securedDirs.delete(dir); // a new directory inherits its parent's ACL until we lock it down
  }
  secureDirOnWindows(dir);
  // Write a private temp file, flush it, then rename: a crash leaves the old file or the new one, never half.
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(config, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, 0o600); // a stale tmp from a crash keeps its old mode on open
  renameSync(tmp, path);
}

// --- secrets in the vault ----------------------------------------------------

const PLUGIN_PREFIX = "plugin/";
const OAUTH_PREFIX = "plugin-oauth/";
/** The fields of `auth` that are always secret. `url` is handled by `urlIsSecret`. */
export const SECRET_AUTH_FIELDS = ["pass", "key", "access_token", "refresh_token"] as const;
type SecretAuthField = (typeof SECRET_AUTH_FIELDS)[number] | "url";
const ID_PATTERN = /^[A-Za-z0-9_-]{1,96}$/;

/**
 * An MCP server's address is a secret: hosted servers often put the access key in the
 * path, which no URL check can tell from the rest of the path. Any other URL is a
 * secret only when it carries a user name, a password or a credential parameter.
 */
function urlIsSecret(kind: PluginAuth["kind"] | undefined, url: unknown): url is string {
  return typeof url === "string" && url !== "" && (kind === "mcp" || valueCarriesCredential(url));
}

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value !== "";

/** Every secret in a plugins config, by vault entry name. */
export function collectPluginSecrets(config: PluginsFile): Map<string, string> {
  const found = new Map<string, string>();
  for (const [id, entry] of Object.entries(config.plugins)) {
    const auth = entry?.auth;
    if (!auth) continue;
    for (const field of SECRET_AUTH_FIELDS) if (nonEmpty(auth[field])) found.set(entryName.plugin(id, field), auth[field]);
    if (urlIsSecret(auth.kind, auth.url)) found.set(entryName.plugin(id, "url"), auth.url);
  }
  for (const [provider, client] of Object.entries(config.oauthClients ?? {})) {
    if (nonEmpty(client?.clientSecret)) found.set(entryName.oauthClient(provider, "clientSecret"), client.clientSecret);
  }
  return found;
}

/** Slots of the secrets in plugins.json (see `rememberSecretsAt`). */
const CONFIG_SLOT_PREFIX = "plugins.json:";

/**
 * Every secret in the config, by slot, an access token with the expiry that is stored beside it.
 * Needs no vault and no valid ids, so it also works in file mode.
 */
function pluginSecretSlots(config: PluginsFile): Map<string, SlotSecret> {
  const slots = new Map<string, SlotSecret>();
  for (const [id, entry] of Object.entries(config.plugins)) {
    const auth = entry?.auth;
    if (!auth) continue;
    for (const field of SECRET_AUTH_FIELDS) {
      if (!nonEmpty(auth[field])) continue;
      slots.set(`${CONFIG_SLOT_PREFIX}${id}:${field}`, field === "access_token" ? { value: auth[field], expiresAt: auth.expires_at } : auth[field]);
    }
    if (urlIsSecret(auth.kind, auth.url)) slots.set(`${CONFIG_SLOT_PREFIX}${id}:url`, auth.url);
  }
  for (const [provider, client] of Object.entries(config.oauthClients ?? {})) {
    if (nonEmpty(client?.clientSecret)) slots.set(`${CONFIG_SLOT_PREFIX}oauth:${provider}`, client.clientSecret);
  }
  return slots;
}

/** Make `redact()` mask every secret in the config. Adds only: what a save replaces is let go by `settlePluginSecrets`. */
function registerPluginSecrets(config: PluginsFile): void {
  for (const [slot, value] of pluginSecretSlots(config)) stageSecretsAt(slot, value);
}

/**
 * After the config is saved: each secret's slot now holds exactly what was saved, so a token
 * that was refreshed, or a plugin that was removed, is no longer the live one. It is queued, not
 * unmasked: it stays masked until it expires (a password, with no expiry, until the queue ages it out).
 * Done after the write, not before: a save that fails leaves the old values in the file.
 */
function settlePluginSecrets(config: PluginsFile): void {
  const slots = pluginSecretSlots(config);
  for (const [slot, value] of slots) rememberSecretsAt(slot, value);
  forgetSecretSlots(CONFIG_SLOT_PREFIX, new Set(slots.keys()));
}

/** A copy of the config with every secret `collectPluginSecrets` finds removed: what goes in the file in vault mode. */
export function stripPluginSecrets(config: PluginsFile): PluginsFile {
  const copy = structuredClone(config);
  for (const entry of Object.values(copy.plugins)) {
    const auth = entry?.auth;
    if (!auth) continue;
    for (const field of SECRET_AUTH_FIELDS) delete auth[field];
    if (urlIsSecret(auth.kind, auth.url)) delete auth.url;
  }
  for (const client of Object.values(copy.oauthClients ?? {})) if (client) delete (client as Partial<OAuthClient>).clientSecret;
  return copy;
}

/** Fill in, from the vault, the secrets the file does not hold. A value the file does hold wins: it is newer. */
export function applyPluginSecrets(config: PluginsFile, vault: Vault): void {
  for (const [id, entry] of Object.entries(config.plugins)) {
    if (!entry?.auth || !ID_PATTERN.test(id)) continue;
    const prefix = entryName.pluginPrefix(id);
    for (const { name } of vault.list(prefix)) {
      const field = name.slice(prefix.length) as SecretAuthField;
      if (field !== "url" && !(SECRET_AUTH_FIELDS as readonly string[]).includes(field)) continue;
      if (entry.auth[field] !== undefined) continue;
      const value = vault.get(name);
      if (value !== undefined) entry.auth[field] = value;
    }
  }
  for (const [provider, client] of Object.entries(config.oauthClients ?? {})) {
    if (!client || !ID_PATTERN.test(provider) || client.clientSecret) continue;
    const value = vault.get(entryName.oauthClient(provider, "clientSecret"));
    if (value !== undefined) client.clientSecret = value;
  }
}

export function getPluginEntry(config: PluginsFile, pluginID: string): PluginEntry | undefined {
  return config.plugins[pluginID];
}

export function isPluginEnabled(config: PluginsFile, pluginID: string): boolean {
  return config.plugins[pluginID]?.enabled ?? false;
}

/** Merge a plugin entry into the config (create or update). */
export function upsertPlugin(config: PluginsFile, pluginID: string, entry: PluginEntry): void {
  config.plugins[pluginID] = entry;
}

export function removePlugin(config: PluginsFile, pluginID: string): void {
  delete config.plugins[pluginID];
}

/** The owner's trusted tool names for an MCP plugin; anything not a non-empty string is ignored. */
export function trustedMcpTools(config: PluginsFile, pluginID: string): string[] {
  const list = config.plugins[pluginID]?.trustedTools;
  return Array.isArray(list) ? list.filter((name): name is string => typeof name === "string" && name !== "") : [];
}

/**
 * Copy the owner's hand-edited settings, `trustedTools` and `local`, from the
 * file on disk into the in-memory config, so the edit is used and a later save
 * writes it back instead of the stale value. The disk value wins, including
 * removal. `local` is only ever the literal `true`. A missing or unreadable
 * file leaves the config as it is.
 */
export function syncTrustedTools(path: string, config: PluginsFile): void {
  let onDisk: PluginsFile;
  try {
    onDisk = JSON.parse(readFileSync(path, "utf-8")) as PluginsFile;
  } catch {
    return;
  }
  if (!onDisk?.plugins || typeof onDisk.plugins !== "object") return;
  for (const [id, entry] of Object.entries(config.plugins)) {
    const list = onDisk.plugins[id]?.trustedTools;
    if (Array.isArray(list)) entry.trustedTools = list;
    else delete entry.trustedTools;
    if (onDisk.plugins[id]?.local === true) entry.local = true;
    else delete entry.local;
  }
}

/** All plugin IDs that are enabled, for auto-connect on daemon start. */
export function enabledPluginIDs(config: PluginsFile): string[] {
  return Object.entries(config.plugins)
    .filter(([, entry]) => entry.enabled)
    .map(([id]) => id);
}