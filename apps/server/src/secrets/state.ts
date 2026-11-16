/**
 * The process-wide unlocked vault and the registry of migrators. Kept apart
 * from the implementation so a module that only needs to ask "is there a
 * vault?" does not load the crypto code.
 */
import { VaultError, type Vault, type VaultMigrator } from "./types";

let active: Vault | undefined;

/** The unlocked vault. Throws `VaultError("VAULT_LOCKED")` when `unlockVault()` has not succeeded. */
export function getVault(): Vault {
  if (!active) throw new VaultError("VAULT_LOCKED", "The secrets vault is not unlocked.");
  return active;
}

/** The unlocked vault, or `undefined`. For code that must work with and without one. */
export function tryGetVault(): Vault | undefined {
  return active;
}

export function isVaultUnlocked(): boolean {
  return active !== undefined;
}

/** Install the process-wide vault. `unlockVault` calls this; tests may too. */
export function setActiveVault(vault: Vault | undefined): void {
  active = vault;
}

/** Forget the process-wide vault (tests, shutdown). The file and the keystore are untouched. */
export function lockVault(): void {
  active = undefined;
}

const migrators = new Map<string, VaultMigrator>();

/**
 * S3-3 registers one migrator per kind of old plaintext secret. `agni vault
 * migrate` runs them in registration order; `agni vault export --yes` calls
 * each one's `export`. Registering a name again replaces it.
 */
export function registerVaultMigrator(migrator: VaultMigrator): void {
  migrators.set(migrator.name, migrator);
}

export function listVaultMigrators(): VaultMigrator[] {
  return [...migrators.values()];
}
