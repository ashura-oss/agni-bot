/**
 * Where a credential is kept right now (S3-02). One answer for every store that
 * holds a secret: the provider keys saved from Settings, plugin passwords and
 * tokens, OAuth tokens in the database, ChatGPT accounts.
 *
 *  - `file` mode (the default until `agni vault migrate` flips it): the old
 *    plaintext stores, unchanged. Writes are plaintext; reads also look in a vault
 *    that happens to be open (see `vaultForReads`).
 *  - `vault` mode: every secret lives in the vault and nothing is written to a
 *    plaintext file or column. A write with the vault locked FAILS; it never
 *    falls back to plaintext. A read with the vault locked finds nothing.
 *
 * This file imports only the leaf modules of `secrets/` so that the model and
 * plugin code can use it without loading the vault's crypto, and without a
 * cycle (`secrets/classify.ts` imports `models/providers.ts`).
 */
import { statSync, unlinkSync, writeFileSync } from "node:fs";
import { registerSecret } from "../util/redact";
import { secretsMode } from "../secrets/mode";
import { tryGetVault } from "../secrets/state";
import { VaultError, type Vault } from "../secrets/types";

/** True when `AGNI_SECRETS_MODE=vault`. */
export function inVaultMode(env: Record<string, string | undefined> = process.env): boolean {
  return secretsMode(env) === "vault";
}

/**
 * The vault to save a secret into, or `undefined` in file mode (the caller then
 * writes the old plaintext store). In vault mode with no unlocked vault this
 * throws `VaultError("VAULT_LOCKED")`: refusing is the only safe answer.
 */
export function vaultForWrites(): Vault | undefined {
  if (!inVaultMode()) return undefined;
  const vault = tryGetVault();
  if (!vault) throw new VaultError("VAULT_LOCKED", "AGNI_SECRETS_MODE=vault but the vault is not unlocked, so the credential was not saved.");
  return vault;
}

/**
 * The vault to read a secret from: whenever one is unlocked, in either mode. In vault mode it is
 * the home of every secret. In file mode a vault is only open when `vault.bin` exists, which means a
 * migration was started and may have stopped part way: a store it already emptied must still read
 * (the daemon would otherwise lose those credentials until the migration is run again). A value the
 * old store still holds is newer than the vault's, so callers let the store win.
 */
export function vaultForReads(): Vault | undefined {
  return tryGetVault();
}

/** Vault entry names. One place, so a migrator, a store and `agni vault export` agree. */
export const entryName = {
  /** `plugins.json` secret fields: `plugin/<pluginID>/<field>`. */
  plugin: (pluginID: string, field: string): string => `plugin/${segment(pluginID)}/${segment(field)}`,
  pluginPrefix: (pluginID: string): string => `plugin/${segment(pluginID)}/`,
  /** `plugins.json` OAuth client secrets: `plugin-oauth/<provider>/<field>`. */
  oauthClient: (provider: string, field: string): string => `plugin-oauth/${segment(provider)}/${segment(field)}`,
  /** One `plugin_connections` row's tokens. */
  connectionTokens: (rowID: string): string => `plugin-token/${segment(rowID)}`,
  /** The full URL of a custom provider whose address carries a credential. */
  providerUrl: (providerID: string): string => `provider-url/${segment(providerID)}`,
  /** A provider key lives where the environment file's would: `env/<VARIABLE>` (see secrets/env.ts). */
  env: (variable: string): string => `env/${segment(variable)}`,
  /** The whole ChatGPT accounts store. */
  chatgptAccounts: "chatgpt/accounts",
} as const;

/** One piece of an entry name. An id outside this alphabet is refused, not rewritten, so two ids can never share a name. */
function segment(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,96}$/.test(value)) throw new VaultError("INVALID_ENTRY", "An id used in a vault entry name may contain only letters, digits, _ and -.");
  return value;
}

/**
 * Remove a plaintext file that held secrets: overwrite its bytes with zeros, then delete it, so the
 * content is not left in the file's old blocks. The overwrite is best effort (a journalled or
 * copy-on-write filesystem may keep the old blocks); the delete is not. True when a file was removed.
 */
export function eraseFile(path: string): boolean {
  let size: number;
  try {
    size = statSync(path).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  try {
    writeFileSync(path, Buffer.alloc(size));
  } catch {
    // Read-only or locked: still try to delete it below.
  }
  unlinkSync(path);
  return true;
}

/** Make `redact()` mask these values from now on. Empty values are not secrets. */
export function rememberSecrets(...values: Array<string | undefined | null>): void {
  for (const value of values) if (value) registerSecret(value);
}
