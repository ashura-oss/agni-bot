/**
 * Keystore for a headless server (owner decision L1): the data key is
 * derived from a passphrase with scrypt, so nothing secret is stored at all.
 * The salt and cost go in the vault header. The passphrase comes from a file:
 * a systemd credential (`LoadCredential=agni-vault-passphrase:<file>` puts it
 * at `$CREDENTIALS_DIRECTORY/agni-vault-passphrase`), or the file named by
 * `AGNI_VAULT_PASSPHRASE_FILE`. Never from an environment variable (those leak
 * into child processes) and never typed on a command line.
 *
 * Without a passphrase the server refuses to start. There is no fallback.
 */
import { randomBytes, scryptSync } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { VaultError, type KeyStore, type KeyStoreMeta } from "./types";

export const PASSPHRASE_CREDENTIAL_NAME = "agni-vault-passphrase";
export const MIN_PASSPHRASE_CHARS = 12;

export interface ScryptCost {
  N: number;
  r: number;
  p: number;
}

/** 64 MiB, a few hundred milliseconds. Paid once at start. */
export const DEFAULT_COST: ScryptCost = { N: 1 << 16, r: 8, p: 1 };

export interface PassphraseKeyStoreOptions {
  /** The passphrase, or `undefined` when none was provided. Called at open and create. */
  passphrase: () => string | undefined;
  /** Cost for a new vault. An existing vault always uses the cost in its header. */
  cost?: ScryptCost;
}

const HOW_TO_PROVIDE =
  "Give it through a systemd credential: add LoadCredential=agni-vault-passphrase:/path/to/passphrase-file to the service unit " +
  "(the file must be readable only by the service user), or set AGNI_VAULT_PASSPHRASE_FILE to such a file.";

function validCost(cost: ScryptCost): void {
  const ok = Number.isInteger(cost.N) && cost.N >= 1024 && cost.N <= 1 << 20 && (cost.N & (cost.N - 1)) === 0 &&
    Number.isInteger(cost.r) && cost.r >= 1 && cost.r <= 32 && Number.isInteger(cost.p) && cost.p >= 1 && cost.p <= 16;
  if (!ok) throw new VaultError("VAULT_CORRUPT", "The vault's key-derivation settings are not valid.");
}

function derive(passphrase: string, salt: Buffer, cost: ScryptCost): Uint8Array {
  validCost(cost);
  return new Uint8Array(scryptSync(passphrase.normalize("NFKC"), salt, 32, { N: cost.N, r: cost.r, p: cost.p, maxmem: 512 * 1024 * 1024 }));
}

export function createPassphraseKeyStore(options: PassphraseKeyStoreOptions): KeyStore {
  const need = (): string => {
    const value = options.passphrase();
    if (value === undefined || value === "") {
      throw new VaultError("PASSPHRASE_MISSING", `The vault needs a passphrase to unlock and none was provided. ${HOW_TO_PROVIDE}`);
    }
    if (value.length < MIN_PASSPHRASE_CHARS) {
      throw new VaultError("PASSPHRASE_REJECTED", `The vault passphrase must be at least ${MIN_PASSPHRASE_CHARS} characters.`);
    }
    return value;
  };
  return {
    kind: "passphrase",
    async open(_context, meta) {
      const salt = typeof meta?.salt === "string" ? Buffer.from(meta.salt, "base64") : undefined;
      if (!meta || !salt || salt.length < 16) throw new VaultError("VAULT_CORRUPT", "The vault header has no passphrase salt.");
      return derive(need(), salt, { N: Number(meta.N), r: Number(meta.r), p: Number(meta.p) });
    },
    async create() {
      const passphrase = need();
      const salt = randomBytes(16);
      const cost = options.cost ?? DEFAULT_COST;
      const meta: KeyStoreMeta = { kdf: "scrypt", salt: salt.toString("base64"), N: cost.N, r: cost.r, p: cost.p };
      return { key: derive(passphrase, salt, cost), meta };
    },
    async remove() {},
  };
}

/** The passphrase file for this environment, or `undefined`. */
export function passphraseFilePath(env: Record<string, string | undefined>): string | undefined {
  const explicit = env.AGNI_VAULT_PASSPHRASE_FILE?.trim();
  if (explicit) return explicit;
  const directory = env.CREDENTIALS_DIRECTORY?.trim();
  return directory ? join(directory, PASSPHRASE_CREDENTIAL_NAME) : undefined;
}

/** True when a passphrase file is configured and present. */
export function passphraseFileExists(env: Record<string, string | undefined>): boolean {
  const path = passphraseFilePath(env);
  return path !== undefined && existsSync(path);
}

/** Read the passphrase file; one trailing newline is dropped. `undefined` when there is none. */
export function readPassphraseFile(env: Record<string, string | undefined>): string | undefined {
  const path = passphraseFilePath(env);
  if (!path || !existsSync(path)) return undefined;
  try {
    return readFileSync(path, "utf8").replace(/\r?\n$/, "");
  } catch (error) {
    throw new VaultError("PASSPHRASE_MISSING", `The vault passphrase file ${path} cannot be read (${(error as Error).message}). ${HOW_TO_PROVIDE}`, { cause: error });
  }
}
