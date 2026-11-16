/**
 * Public entry of the secrets module. Import from here, not from the files
 * behind it.
 *
 *   const vault = await unlockVault({ create: true });   // once, at start
 *   vault.set("env/OPENROUTER_API_KEY", key);
 *   vault.get("env/OPENROUTER_API_KEY");                  // sync, registered for redaction
 *   getVault().list("plugin/");                           // names only
 */
export * from "./types";
export { createMemoryKeyStore, type MemoryKeyStore } from "./memory-keystore";
export { getKeyStoreOverride, setKeyStoreOverride } from "./keystore";
export {
  getVault,
  isVaultUnlocked,
  listVaultMigrators,
  lockVault,
  registerVaultMigrator,
  setActiveVault,
  tryGetVault,
} from "./state";
export { createBunSecretsKeyStore } from "./bun-secrets";
export { createPassphraseKeyStore, passphraseFilePath } from "./passphrase";
export { selectKeyStore } from "./select";
export { secretsMode, unlockVault, vaultExists, vaultStatus } from "./unlock";
