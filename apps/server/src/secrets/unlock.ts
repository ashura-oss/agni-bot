import type { SecretsMode, Vault, VaultOptions, VaultStatus } from "./types";

/**
 * Open the vault and make it the process-wide one (`getVault()`). Idempotent:
 * a second call returns the vault already open. Refuses (throws `VaultError`)
 * instead of falling back to anything weaker. Without `create: true`, a home
 * with no `vault.bin` throws `VaultError("VAULT_NOT_FOUND")`: check
 * `vaultExists()` first.
 * INTERFACE ONLY in this commit: implemented in the next one.
 */
export async function unlockVault(_options: VaultOptions = {}): Promise<Vault> {
  throw new Error("unlockVault is not implemented yet");
}

/** True when `AGNI_HOME/vault.bin` exists. */
export function vaultExists(_options: Pick<VaultOptions, "home"> = {}): boolean {
  throw new Error("vaultExists is not implemented yet");
}

/** `AGNI_SECRETS_MODE`: `vault` or `file` (default `file` until S3-3 lands). */
export function secretsMode(_env: Record<string, string | undefined> = process.env): SecretsMode {
  throw new Error("secretsMode is not implemented yet");
}

/** What `agni vault status` prints. Reads the header only: never decrypts and never needs the keystore. */
export function vaultStatus(_options: VaultOptions = {}): VaultStatus {
  throw new Error("vaultStatus is not implemented yet");
}
