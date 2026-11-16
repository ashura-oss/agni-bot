/**
 * The vault's public contract. Sprint 3 tasks S3-3 (credentials) and S3-5
 * (redaction) build on this file: signatures here change only through the
 * tech lead.
 *
 * Shape in one paragraph: secrets live in one encrypted file
 * (`AGNI_HOME/vault.bin`, AES-256-GCM). The key that opens it, the "data key",
 * is held by a `KeyStore`: the operating system's credential store
 * (`Bun.secrets`), or a key derived from a passphrase on a headless server.
 * Only the data key ever touches the keystore (32 bytes), so keystore size
 * limits, listing and backup never matter. There is no plaintext fallback:
 * if the vault cannot be opened the server refuses to start.
 *
 * Reads and writes are synchronous once the vault is unlocked (the data key
 * is cached in memory; the file read and write are in-process). Only
 * unlocking is async, because `Bun.secrets` is.
 */

/** Which backend holds (or derives) the data key. */
export type KeyStoreKind = "bun-secrets" | "passphrase" | "memory";

/** Data the vault gives a keystore: the vault's random id, never a secret. */
export interface KeyStoreContext {
  /** Random id written in the vault header. Names the keystore entry, so two homes never share a key. */
  vaultId: string;
}

/** Non-secret metadata a keystore keeps in the vault header (the passphrase backend's salt and cost). */
export type KeyStoreMeta = Record<string, string | number>;

/**
 * Holds or derives the vault's 32-byte data key. Implementations never log
 * the key and never write it anywhere but their own store.
 */
export interface KeyStore {
  readonly kind: KeyStoreKind;
  /**
   * The data key of an existing vault, or `null` when this keystore has no key
   * for it (the vault is then NOT recreated: the caller refuses, because
   * making a new key would orphan every stored secret).
   * Throws `VaultError` (`KEYSTORE_UNAVAILABLE`, `PASSPHRASE_MISSING`, ...).
   */
  open(context: KeyStoreContext, meta: KeyStoreMeta | null): Promise<Uint8Array | null>;
  /** First use: make a random data key, keep it, and return it with the header metadata to store. */
  create(context: KeyStoreContext): Promise<{ key: Uint8Array; meta: KeyStoreMeta | null }>;
  /** Forget the key (used by tests and by deleting a vault on purpose). */
  remove(context: KeyStoreContext): Promise<void>;
}

/** Every reason the vault refuses to work. `VaultError.code` is one of these. */
export type VaultErrorCode =
  /** A secret was read or written before `unlockVault()` ran. */
  | "VAULT_LOCKED"
  /** `unlockVault()` found no `vault.bin` and was not asked to create one. */
  | "VAULT_NOT_FOUND"
  /** The credential store cannot be reached (no desktop keystore, denied, platform error). */
  | "KEYSTORE_UNAVAILABLE"
  /** `vault.bin` exists but its key is not in the keystore. Never auto-recreated. */
  | "DATA_KEY_MISSING"
  /** The vault was made with another keystore kind than the one selected. */
  | "KEYSTORE_MISMATCH"
  /** Headless unlock needs a passphrase and none was provided. */
  | "PASSPHRASE_MISSING"
  /** The passphrase is too short, or does not open the vault. */
  | "PASSPHRASE_REJECTED"
  /** The file is not a vault, is cut short, or its header is damaged. */
  | "VAULT_CORRUPT"
  /** The file was written by a newer format than this build understands. */
  | "VAULT_VERSION_UNSUPPORTED"
  /** Decryption failed: wrong key, or the file was changed. */
  | "AUTH_FAILED"
  /** A secret name or value is not allowed. */
  | "INVALID_ENTRY"
  /** The vault file or its folder could not be made owner-only or written. */
  | "WRITE_FAILED"
  /** Another process holds the vault write lock and did not let go. */
  | "LOCK_TIMEOUT";

/** Thrown by every vault and keystore operation. The message is safe to show the owner and never holds a secret. */
export class VaultError extends Error {
  readonly code: VaultErrorCode;
  constructor(code: VaultErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "VaultError";
    this.code = code;
  }
}

/** Allowed names: letters, digits and `_ . : / @ -`, 1 to 128 characters, not starting with a separator. Env-var names fit. */
export const VAULT_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.:/@-]{0,127}$/;
/** Largest value, in UTF-8 bytes. */
export const VAULT_MAX_VALUE_BYTES = 256 * 1024;

/** Metadata about one entry, without its value. */
export interface VaultEntryInfo {
  name: string;
  updatedAt: string;
}

/** An unlocked vault. Obtain it with `unlockVault()` or `getVault()`. */
export interface Vault {
  readonly path: string;
  readonly keystoreKind: KeyStoreKind;
  /** The value, or `undefined` when there is none. Every value returned is registered with `registerSecret()`. */
  get(name: string): string | undefined;
  /** Store or replace a value. Atomic and owner-only. The value is registered with `registerSecret()`. */
  set(name: string, value: string): void;
  /** Remove an entry. True when it existed. */
  delete(name: string): boolean;
  /** Names and update times, from the vault's own index (the keystore is never listed), sorted by name. Never values. */
  list(prefix?: string): VaultEntryInfo[];
  has(name: string): boolean;
  /** Re-read the file if another process changed it. Cheap when nothing changed. */
  refresh(): void;
}

/** What `unlockVault` and `vaultStatus` look at. All fields are optional. */
export interface VaultOptions {
  /** AGNI_HOME. Default: `agniHome()`. */
  home?: string;
  /** Environment to read `AGNI_KEYSTORE`, `AGNI_VAULT_PASSPHRASE_FILE` and `CREDENTIALS_DIRECTORY` from. Default `process.env`. */
  env?: Record<string, string | undefined>;
  /** Use exactly this keystore (tests). Beats the test override and platform selection. */
  keystore?: KeyStore;
  /** Create a missing vault. Default `false`: unlocking a home with no vault does not make one. */
  create?: boolean;
}

/** A snapshot for `agni vault status`. Contains no secret and no secret name. */
export interface VaultStatus {
  path: string;
  exists: boolean;
  unlocked: boolean;
  /** Keystore kind written in the vault header, when the file exists and is readable. */
  keystoreKind?: KeyStoreKind;
  /** Format version of the file. */
  version?: number;
  /** Number of entries, only when unlocked. */
  entries?: number;
  /** The secrets mode in force: `vault` or `file` (see `secretsMode`). */
  mode: SecretsMode;
}

/**
 * Where secrets come from at start.
 *  - `file`  (default until S3-3 lands): the old plaintext `config.env` is
 *    loaded as before. The vault is only opened when `vault.bin` exists.
 *  - `vault`: the vault is always opened (and made on first use); secret
 *    entries in `config.env` are NOT loaded, the vault's `env/<NAME>` entries
 *    fill `process.env` instead. Set with `AGNI_SECRETS_MODE=vault`.
 */
export type SecretsMode = "file" | "vault";

/** One step S3-3 registers to move old plaintext secrets into the vault. */
export interface VaultMigrator {
  /** Short stable name, e.g. `provider-keys`. */
  name: string;
  /** Move the secrets into `vault`. Must be idempotent and must leave the old file in place if it fails. Returns the number moved. */
  migrate(vault: Vault, context: VaultMigrationContext): Promise<number> | number;
  /**
   * Rollback for `agni vault export`: write the vault's entries back to the
   * old plaintext location. Called only after an explicit `--yes`. Returns
   * the number of entries written.
   */
  export?(vault: Vault, context: VaultMigrationContext): Promise<number> | number;
}

/** What a migrator is given. `db` is open for migrators that need `plugin_connections.tokens`. */
export interface VaultMigrationContext {
  home: string;
  /** Folder where the migrator must put its backup before changing anything. */
  backupDir: string;
  /** Present when the database is open (the server start path), absent for a bare CLI call. */
  db?: import("bun:sqlite").Database;
}
