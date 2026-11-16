import { join } from "node:path";
import { agniHome } from "../home";
import { log } from "../log";
import { secretClassifier } from "../secrets/classify";
import { applyVaultEnv, plaintextSecretNames } from "../secrets/env";
import { isVaultUnlocked, lockVault, tryGetVault, unlockVault, vaultExists, VaultError } from "../secrets";
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
    const leftovers = plaintextSecretNames(join(home, "config.env"), secretClassifier({ env, home }));
    if (leftovers.length > 0) {
      log.warn(`config.env still holds plaintext credentials (${leftovers.join(", ")}) that are being ignored in vault mode; run \`agni vault migrate\` to move them into the vault`);
    }
  }
  return { mode, unlocked: true, applied };
}

/** What a CLI command that talks to the running daemon needs from the vault: the stored device token. */
const CLI_VARIABLES = ["AGNI_TOKEN"] as const;

/**
 * For the CLI commands (`daemon status`, `service status`, ...) that call the
 * daemon's `/health` with the stored device token. In vault mode `loadHomeEnv`
 * leaves credentials out of the environment, so the token is read from the
 * vault here, and only the token: a CLI command does not need the model keys.
 *
 * Never creates a vault and never stops the command: a vault that will not
 * open is reported on stderr and the command carries on without the token (it
 * then shows the liveness answer only, as for an unpaired machine). Returns the
 * variables set.
 */
export async function loadVaultEnvForCli(options: { env?: Record<string, string | undefined>; home?: string } = {}): Promise<string[]> {
  const env = options.env ?? process.env;
  const home = options.home ?? agniHome(env);
  if (secretsMode(env) !== "vault" || !vaultExists({ home })) return [];
  const wanted = CLI_VARIABLES.filter((name) => !env[name]);
  if (wanted.length === 0) return [];
  const wasOpen = isVaultUnlocked();
  try {
    const vault = await unlockVault({ home, env, create: false });
    return applyVaultEnv(env, vault, wanted);
  } catch (error) {
    console.error(`could not read the stored device token from the vault, so this command runs without it: ${error instanceof VaultError ? `${error.code}: ${error.message}` : String(error)}`);
    return [];
  } finally {
    // Do not leave a process-wide vault behind that this command did not ask for.
    if (!wasOpen) lockVault();
  }
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
