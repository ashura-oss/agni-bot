import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agniHome } from "../home";
import { secureDirectoryIfNeeded, writePrivateFileSync, PrivateFileError } from "../util/private-file";
import { encodeVault, parseHeader, type VaultHeader } from "./format";
import { withFileLock } from "./lock";
import { selectKeyStore } from "./select";
import { setActiveVault, tryGetVault } from "./state";
import { FileVault, lockPathOf } from "./vault";
import { secretsMode } from "./mode";
import { VaultError, type KeyStore, type Vault, type VaultOptions, type VaultStatus } from "./types";

export { secretsMode };

const VAULT_FILE = "vault.bin";

const homeOf = (options: Pick<VaultOptions, "home" | "env">): string => options.home ?? agniHome(options.env ?? process.env);
const pathOf = (options: Pick<VaultOptions, "home" | "env">): string => join(homeOf(options), VAULT_FILE);

/** True when `AGNI_HOME/vault.bin` exists. */
export function vaultExists(options: Pick<VaultOptions, "home" | "env"> = {}): boolean {
  return existsSync(pathOf(options));
}

/** What `agni vault status` prints. Reads the header only: never decrypts and never needs the keystore. */
export function vaultStatus(options: VaultOptions = {}): VaultStatus {
  const path = pathOf(options);
  const active = tryGetVault();
  const mode = secretsMode(options.env ?? process.env);
  const unlocked = active !== undefined && active.path === path;
  const status: VaultStatus = { path, exists: existsSync(path), unlocked, mode };
  if (status.exists) {
    try {
      const parsed = parseHeader(readFileSync(path));
      status.keystoreKind = parsed.header.keystore;
      status.version = parsed.version;
    } catch { /* an unreadable header shows as exists with no kind */ }
  }
  if (unlocked && active) status.entries = active.list().length;
  return status;
}

const pending = new Map<string, Promise<Vault>>();

/**
 * Open the vault and make it the process-wide one (`getVault()`). Idempotent:
 * a second call for the same home returns the vault already open. Refuses
 * (throws `VaultError`) instead of falling back to anything weaker. Without
 * `create: true`, a home with no `vault.bin` throws `VAULT_NOT_FOUND`.
 */
export async function unlockVault(options: VaultOptions = {}): Promise<Vault> {
  const path = pathOf(options);
  const active = tryGetVault();
  if (active && active.path === path) return active;
  let attempt = pending.get(path);
  if (!attempt) {
    attempt = openOrCreate(options, path).finally(() => pending.delete(path));
    pending.set(path, attempt);
  }
  const vault = await attempt;
  setActiveVault(vault);
  return vault;
}

async function openOrCreate(options: VaultOptions, path: string): Promise<Vault> {
  if (existsSync(path)) return openExisting(options, path);
  if (!options.create) {
    throw new VaultError("VAULT_NOT_FOUND", `There is no vault at ${path}.`);
  }
  return createNew(options, path);
}

async function openExisting(options: VaultOptions, path: string): Promise<Vault> {
  const bytes = readFileSync(path);
  const { header } = parseHeader(bytes);
  const keystore = options.keystore ?? selectKeyStore({ env: options.env, headerKind: header.keystore });
  if (keystore.kind !== header.keystore) {
    throw new VaultError("KEYSTORE_MISMATCH", `This vault was made with the ${header.keystore} keystore; ${keystore.kind} was selected.`);
  }
  const key = await keystore.open({ vaultId: header.vaultId }, header.meta);
  if (!key) {
    throw new VaultError(
      "DATA_KEY_MISSING",
      "The vault file exists but its key is not in the credential store (a different account or machine, or the entry was deleted). " +
        "Agni will not make a new vault over it. Restore the key, or move vault.bin aside to start a new vault.",
    );
  }
  const vault = new FileVault(path, header, key);
  try {
    vault.load();
  } catch (error) {
    if (error instanceof VaultError && error.code === "AUTH_FAILED" && keystore.kind === "passphrase") {
      throw new VaultError("PASSPHRASE_REJECTED", "The vault passphrase is wrong, or vault.bin was changed.", { cause: error });
    }
    throw error;
  }
  return vault;
}

async function createNew(options: VaultOptions, path: string): Promise<Vault> {
  const home = homeOf(options);
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    secureDirectoryIfNeeded(home, "throw");
  } catch (error) {
    const why = error instanceof PrivateFileError ? error.message : (error as Error).message;
    throw new VaultError("WRITE_FAILED", `Could not prepare ${home} for the vault: ${why}`, { cause: error });
  }
  const keystore: KeyStore = options.keystore ?? selectKeyStore({ env: options.env });
  const vaultId = randomUUID();
  const { key, meta } = await keystore.create({ vaultId });
  const header: VaultHeader = { vaultId, keystore: keystore.kind, meta, cipher: "aes-256-gcm", createdAt: new Date().toISOString() };
  let raced = false;
  try {
    // Two processes starting together: the lock makes one of them the maker.
    withFileLock(lockPathOf(path), () => {
      if (existsSync(path)) {
        raced = true;
        return;
      }
      try {
        writePrivateFileSync(path, encodeVault(header, key, new Map()));
      } catch (error) {
        const why = error instanceof PrivateFileError ? error.message : (error as Error).message;
        throw new VaultError("WRITE_FAILED", `Could not create the vault: ${why}`, { cause: error });
      }
    });
  } catch (error) {
    await keystore.remove({ vaultId }).catch(() => {});
    throw error;
  }
  if (raced) {
    await keystore.remove({ vaultId }).catch(() => {});
    return openExisting(options, path);
  }
  const vault = new FileVault(path, header, key);
  vault.load();
  return vault;
}
