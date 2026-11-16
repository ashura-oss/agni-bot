import { join } from "node:path";
import { agniHome } from "../home";
import { log } from "../log";
import { applyVaultEnv, plaintextSecretNames } from "../secrets/env";
import { isVaultUnlocked, tryGetVault, unlockVault, vaultExists, VaultError } from "../secrets";
import { secretsMode } from "../secrets/mode";
import type { StartupContext } from "./context";

export interface VaultStartResult {
  mode: "file" | "vault";
  unlocked: boolean;
  /** Variables filled from the vault's `env/<NAME>` entries. */
  applied: string[];
}

/**
 * Open the vault at start, before `loadConfig()`, so providers see the keys.
 *  - `vault` mode: always open it (made on first start).
 *  - `file` mode (the default until S3-3 flips it): open it only when
 *    `vault.bin` exists, so an install that never migrated is unchanged.
 * A vault that exists but cannot be opened is never worked around: this throws
 * `VaultError` and the caller refuses to start. `serve()` in `index.ts` calls it.
 */
export async function unlockVaultAtStart(options: { env?: Record<string, string | undefined>; home?: string } = {}): Promise<VaultStartResult> {
  const env = options.env ?? process.env;
  const home = options.home ?? agniHome(env);
  const mode = secretsMode(env);
  if (mode === "file" && !vaultExists({ home })) return { mode, unlocked: false, applied: [] };
  const vault = await unlockVault({ home, env, create: mode === "vault" });
  const applied = applyVaultEnv(env, vault);
  if (mode === "vault") {
    const leftovers = plaintextSecretNames(join(home, "config.env"));
    if (leftovers.length > 0) {
      log.warn(`config.env still holds plaintext credentials (${leftovers.join(", ")}) that are being ignored in vault mode; run \`agni vault migrate\` to move them into the vault`);
    }
  }
  return { mode, unlocked: true, applied };
}

const HINTS: Partial<Record<VaultError["code"], string>> = {
  PASSPHRASE_MISSING: "On a headless Linux server, give the passphrase through systemd (LoadCredential=agni-vault-passphrase:<file>).",
  PASSPHRASE_REJECTED: "Check the passphrase file the service passes in.",
  KEYSTORE_UNAVAILABLE: "Unlock the desktop session's credential store, or switch this machine to a passphrase (AGNI_KEYSTORE=passphrase).",
  KEYSTORE_MISMATCH: "Use the keystore this vault was made with.",
};

/** The text printed when start-up is refused. Says why, and says there is no plaintext fallback. */
export function vaultRefusalMessage(error: unknown): string {
  if (error instanceof VaultError) {
    const hint = HINTS[error.code];
    return [
      `Agni cannot start: the secrets vault could not be opened (${error.code}).`,
      `  ${error.message}`,
      ...(hint ? [`  ${hint}`] : []),
      "  Agni does not fall back to plaintext keys. Fix the above and start it again.",
    ].join("\n");
  }
  return `Agni cannot start: ${error instanceof Error ? error.message : String(error)}`;
}

/** Sprint hook (runs once the database is open). The vault is already open by now; this records it and checks the mode held. */
export async function startupS3Vault(_ctx: StartupContext): Promise<void> {
  const mode = secretsMode();
  if (mode === "vault" && !isVaultUnlocked()) {
    throw new VaultError("VAULT_LOCKED", "AGNI_SECRETS_MODE=vault but the vault was not opened at start.");
  }
  const vault = tryGetVault();
  if (vault) log.info(`vault: open (${vault.keystoreKind} keystore, ${vault.list().length} entries)`);
}
