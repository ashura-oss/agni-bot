/**
 * Where a credential is kept right now (S3-02). One answer for every store that
 * holds a secret: the provider keys saved from Settings, plugin passwords and
 * tokens, OAuth tokens in the database, ChatGPT accounts.
 *
 *  - `file` mode (a home with no mode recorded; `agni vault migrate` switches it): the old
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
import { closeSync, constants as fsConstants, fstatSync, fsyncSync, lstatSync, openSync, unlinkSync, writeSync } from "node:fs";
import { registerSecretFor } from "../util/redact";
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

/** Open `path` for the overwrite: read-write, never through a symlink where the platform can say so. */
function openForErase(path: string): { fd: number; writable: boolean } {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0; // not defined on Windows: the lstat/fstat comparison below covers it there
  const notRegular = (): Error => new Error(`${path} is not a regular file (a link or a folder), so it was left alone`);
  try {
    return { fd: openSync(path, fsConstants.O_RDWR | noFollow), writable: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") throw notRegular();
    if (code !== "EACCES" && code !== "EPERM" && code !== "EROFS" && code !== "EBUSY" && code !== "ETXTBSY") throw error;
  }
  // Read-only or locked: still look at it through a handle, so the checks below run, and try to delete it.
  try {
    return { fd: openSync(path, fsConstants.O_RDONLY | noFollow), writable: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw notRegular();
    throw error;
  }
}

/**
 * Remove a plaintext file that held secrets: overwrite its bytes with zeros, then delete it, so the
 * content is not left in the file's old blocks. The overwrite is best effort (a journalled or
 * copy-on-write filesystem may keep the old blocks); the delete is not. True when a file was removed.
 *
 * Only a regular file with a single name is touched. A symlink would have its target zeroed, a hard link would
 * have the other names' bytes zeroed with it, and a directory has nothing to zero: each is left exactly as it is
 * and refused with an error that says why (the callers report a refusal as "could not erase", so the owner sees
 * the name and deletes it by hand).
 *
 * The file is opened once and every check and the overwrite go through that one handle, so what was checked is what
 * is written: the path is never trusted a second time between checking and writing (a swap in between would
 * otherwise send the zeros to another file). The handle is opened without following a symlink where the platform
 * can say so; elsewhere (Windows) its device and inode must equal what `lstat` saw.
 */
export function eraseFile(path: string): boolean {
  let seen: ReturnType<typeof lstatSync>;
  try {
    seen = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!seen.isFile()) throw new Error(`${path} is not a regular file (a link or a folder), so it was left alone`);
  let opened: { fd: number; writable: boolean };
  try {
    opened = openForErase(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  let identity: { dev: number | bigint; ino: number | bigint };
  try {
    const info = fstatSync(opened.fd);
    if (!info.isFile() || info.dev !== seen.dev || info.ino !== seen.ino) {
      throw new Error(`${path} is not the file that was looked at (it was replaced), so it was left alone`);
    }
    if (info.nlink !== 1) {
      throw new Error(
        `${path} has ${info.nlink - 1} other hard link(s), so it was left alone (overwriting it would change those names too); ` +
          "a plaintext copy of its content may remain at another link: find and delete the other name(s) yourself",
      );
    }
    identity = { dev: info.dev, ino: info.ino };
    if (opened.writable) {
      try {
        const zeros = Buffer.alloc(info.size);
        for (let done = 0; done < zeros.length; ) done += writeSync(opened.fd, zeros, done, zeros.length - done, done);
        fsyncSync(opened.fd);
      } catch {
        // Locked or full: still try to delete it below.
      }
    }
  } finally {
    closeSync(opened.fd);
  }
  // The name must still be the file that was overwritten: a name that now points elsewhere is not ours to delete.
  let now: ReturnType<typeof lstatSync>;
  try {
    now = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (now.dev !== identity.dev || now.ino !== identity.ino) throw new Error(`${path} was replaced while it was being erased, so the new file was left alone`);
  unlinkSync(path);
  return true;
}

/**
 * Make `redact()` mask these values from now on, held by `holder` (a name that says whose they are: a hold is only
 * ever let go of by its own holder, so one owner cannot unmask what another still holds). The hold lasts until the
 * process ends or the holder lets go; the callers here are one-shot commands. Empty values are not secrets.
 */
export function rememberSecrets(holder: string, ...values: Array<string | undefined | null>): void {
  for (const value of values) if (value) registerSecretFor(holder, value);
}
