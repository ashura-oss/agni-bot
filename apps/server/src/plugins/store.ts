/**
 * The plugin connection store: one durable row per catalog plugin bound to
 * one account. Tokens stay server-side only — clients never receive them; the
 * frame snapshot carries status, scopes, and policy, never secrets.
 *
 * Where the tokens live depends on the secrets mode (S3-02):
 *  - file mode: in the `tokens` column, as before;
 *  - vault mode: in the vault (`plugin-token/<row id>`), and the row holds only
 *    that name in `token_ref` (migration 62) with `tokens` empty, so the
 *    database file carries no credential. A vault that is locked refuses the
 *    write; nothing is ever written to the column instead.
 * Read a row's tokens with `readConnectionTokens`, never from the column.
 */
import type { Database } from "bun:sqlite";
import type { PluginAccount } from "@agni/protocol";
import { entryName, vaultForReads, vaultForWrites } from "../credentials/vault-mode";
import { VaultError } from "../secrets/types";
import { newID, nowISO } from "../util/ids";
import { rememberSecretsAt, stageSecretsAt, type SlotSecret } from "../util/redact";

export interface PluginConnectionRow {
  id: string;
  plugin_id: string;
  account: PluginAccount;
  status: "disconnected" | "pending" | "connected" | "error";
  account_label: string | null;
  scopes: string | null; // JSON array actually granted
  capabilities: string | null; // JSON policy snapshot at connect time
  /** JSON TokenBlob, server-side only. Empty in vault mode: the tokens are in the vault, named by `token_ref`. */
  tokens: string | null;
  /** The vault entry holding this row's tokens (migration 62), or null when they are in `tokens`. */
  token_ref: string | null;
  error: string | null;
  grant_started_at: string | null;
  connected_at: string | null;
  updated_at: string;
}

/** What lives in the `tokens` column. `state` is only on rows written before Sprint 3 (the sign-in state is in `oauth_states` now); nothing writes it. */
export interface TokenBlob {
  state?: string;
  refresh_token?: string;
  access_token?: string;
  /** Epoch ms after which the access token needs a refresh (and is dead). */
  expires_at?: number;
}

function parseBlob(raw: string | null | undefined): TokenBlob {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as TokenBlob) : {};
  } catch {
    return {};
  }
}

/** The tokens of a connection, wherever they are kept. With the vault locked, a vault-held blob reads as empty. */
export function readConnectionTokens(row: PluginConnectionRow): TokenBlob {
  if (row.token_ref) return parseBlob(vaultForReads()?.get(row.token_ref));
  return parseBlob(row.tokens);
}

/** True when the blob holds a credential, as opposed to only a pending sign-in's `state`. */
function holdsCredential(tokens: TokenBlob): boolean {
  return Boolean(tokens.access_token || tokens.refresh_token);
}

/**
 * Save a connection's tokens. Vault mode: the blob goes to the vault and is read
 * back before the column is touched; the row gets the reference and an empty
 * `tokens`. A blob with no credential in it (an MCP connect) is not worth a vault
 * entry and stays in the column. File mode: the column, as before.
 */
/**
 * The redaction slot of one connection's tokens (see `rememberSecretsAt`). A refresh replaces the
 * tokens; what they replace stays masked until it has expired, so a caller stages the new ones
 * before the write (`saveTokens`) and settles the slot after it (`settleTokens`).
 */
const tokenSlot = (id: string): string => `plugin-connection:${id}`;

/** What a blob puts in the slot: the access token with its known expiry, and the refresh token. */
const tokenSecrets = (tokens: TokenBlob): SlotSecret[] => [{ value: tokens.access_token, expiresAt: tokens.expires_at }, tokens.refresh_token];

function saveTokens(db: Database, id: string, tokens: TokenBlob): { tokens: string | null; token_ref: string | null } {
  const vault = vaultForWrites();
  // Masked before anything is written, in either mode: once saved, a token may reach a log line.
  stageSecretsAt(tokenSlot(id), ...tokenSecrets(tokens));
  if (!vault || !holdsCredential(tokens)) {
    // Any earlier vault copy of this row is now stale.
    const old = getConnection(db, id)?.token_ref;
    if (old) vault?.delete(old);
    return { tokens: JSON.stringify(tokens), token_ref: null };
  }
  const name = entryName.connectionTokens(id);
  const blob = JSON.stringify(tokens);
  vault.set(name, blob);
  if (vault.get(name) !== blob) throw new VaultError("WRITE_FAILED", "The connection's tokens could not be read back from the vault, so they were not saved.");
  return { tokens: null, token_ref: name };
}

export function getConnections(db: Database): PluginConnectionRow[] {
  return db.query<PluginConnectionRow, []>("SELECT * FROM plugin_connections").all();
}

export function getConnection(db: Database, id: string): PluginConnectionRow | null {
  return db.query<PluginConnectionRow, [string]>("SELECT * FROM plugin_connections WHERE id = ?").get(id) ?? null;
}

export function getConnectionFor(db: Database, pluginID: string, account: PluginAccount): PluginConnectionRow | null {
  return db
    .query<PluginConnectionRow, [string, string]>("SELECT * FROM plugin_connections WHERE plugin_id = ? AND account = ?")
    .get(pluginID, account) ?? null;
}

export interface ConnectPatch {
  connectionID?: string;
  pluginID: string;
  account: PluginAccount;
  scopes: string[]; // catalog scopes requested at this connect
  capabilities: unknown; // policy snapshot
}

/**
 * Create-or-reset the (plugin, account) connection as a fresh pending grant.
 * A previous pending row for the same pair is cleared, and a previous
 * connected grant's tokens are wiped (the vault copy too) — a re-connect
 * always starts clean.
 */
export function startPending(db: Database, patch: ConnectPatch): PluginConnectionRow {
  const existing = getConnectionFor(db, patch.pluginID, patch.account);
  const id = existing?.id ?? newID("plc");
  const now = nowISO();
  db.run(
    `INSERT INTO plugin_connections
       (id, plugin_id, account, status, account_label, scopes, capabilities, tokens, token_ref,
        error, grant_started_at, connected_at, updated_at)
     VALUES (?, ?, ?, 'pending', NULL, ?, ?, NULL, NULL, NULL, ?, NULL, ?)
     ON CONFLICT(plugin_id, account) DO UPDATE SET
       status = 'pending',
       account_label = NULL,
       scopes = excluded.scopes,
       capabilities = excluded.capabilities,
       tokens = excluded.tokens,
       token_ref = NULL,
       error = NULL,
       grant_started_at = excluded.grant_started_at,
       connected_at = NULL,
       updated_at = excluded.updated_at`,
    [
      id,
      patch.pluginID,
      patch.account,
      JSON.stringify(patch.scopes),
      JSON.stringify(patch.capabilities),
      now,
      now,
    ],
  );
  if (existing?.token_ref) tryDeleteVaultEntry(existing.token_ref);
  rememberSecretsAt(tokenSlot(id)); // a re-connect wipes the old tokens: queued, masked until they expire
  return getConnection(db, id)!;
}

/** Persist exchanged tokens + signed-in identity, mark connected. */
export function completeConnect(db: Database, id: string, tokens: Omit<TokenBlob, "state">, accountLabel: string): PluginConnectionRow {
  const saved = saveTokens(db, id, tokens);
  db.run(
    `UPDATE plugin_connections SET
       status = 'connected',
       account_label = ?,
       tokens = ?,
       token_ref = ?,
       error = NULL,
       connected_at = ?,
       updated_at = ?
     WHERE id = ?`,
    [accountLabel, saved.tokens, saved.token_ref, nowISO(), nowISO(), id],
  );
  // The row holds the new tokens now: the ones they replace stop being the live ones (and are queued, not unmasked).
  rememberSecretsAt(tokenSlot(id), ...tokenSecrets(tokens));
  return getConnection(db, id)!;
}

export function updateTokens(db: Database, id: string, tokens: TokenBlob): void {
  const saved = saveTokens(db, id, tokens);
  db.run("UPDATE plugin_connections SET tokens = ?, token_ref = ?, updated_at = ? WHERE id = ?", [saved.tokens, saved.token_ref, nowISO(), id]);
  rememberSecretsAt(tokenSlot(id), ...tokenSecrets(tokens)); // after the write, like `completeConnect`
}

export function markError(db: Database, id: string, error: string): void {
  db.run("UPDATE plugin_connections SET status = 'error', error = ?, updated_at = ? WHERE id = ?", [error, nowISO(), id]);
}

/** Drop the row entirely, and its vault entry; a disconnected plugin falls back to its catalog row. */
export function deleteConnection(db: Database, id: string): boolean {
  const ref = getConnection(db, id)?.token_ref;
  const deleted = db.run("DELETE FROM plugin_connections WHERE id = ?", [id]).changes > 0;
  if (ref) tryDeleteVaultEntry(ref);
  // The row is gone, the tokens are not necessarily dead: they stay masked until they expire (no revoke unmasks them).
  rememberSecretsAt(tokenSlot(id));
  return deleted;
}

/**
 * Remove a vault entry that no row names any more. A locked or unreadable vault
 * leaves it: an orphaned entry is a stale encrypted copy, not a leak, and the
 * caller's own change (a reconnect, a disconnect) must not fail because of it.
 */
function tryDeleteVaultEntry(name: string): void {
  try {
    vaultForReads()?.delete(name);
  } catch {
    // see above
  }
}
