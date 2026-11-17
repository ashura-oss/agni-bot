/**
 * `agni setup`, first half: make AGNI_HOME private, write `config.env`, and choose the secrets mode.
 *
 * The vault is the default for a fresh install; this is where that default is applied and recorded. A home that
 * already has a mode, or already holds data, keeps what it has (`agni vault migrate` is the way across). A fresh home
 * on a machine with no usable keystore starts in file mode instead, and says so: never a silent downgrade.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setEnvFileValues } from "../secrets/env";
import { backendLabel } from "../secrets/probe";
import { homeIsFresh, recordedSecretsMode } from "../secrets/setup-mode";
import { VaultError, lockVault, unlockVault, type KeyStore, type SecretsMode } from "../secrets";
import { secureDirectory, secureFile, verifyHomePrivate, writePrivateFileSync } from "../util/private-file";

type Env = Record<string, string | undefined>;

export interface SecretsChoice {
  mode: SecretsMode;
  /**
   *  - `fresh`: a new home, the vault was made;
   *  - `keystore-unavailable`: a new home, no usable keystore, so file mode;
   *  - `recorded`: the home (or the environment) already named a mode;
   *  - `existing`: the home predates the vault and has data, so file mode as before.
   */
  reason: "fresh" | "keystore-unavailable" | "recorded" | "existing";
  /** What `agni setup` prints. */
  message: string;
}

export interface ChooseOptions {
  home: string;
  env?: Env;
  /** Use exactly this keystore (tests). */
  keystore?: KeyStore;
  platform?: NodeJS.Platform;
  /** The date written in the record (tests). */
  now?: Date;
}

const MIGRATE = "`agni vault migrate`";

/**
 * The headless way, in the order it is done: the file named by `AGNI_VAULT_PASSPHRASE_FILE` is what `agni setup`,
 * `agni vault migrate` and `agni service install` read; `service install` then hands that file to the service as a
 * systemd credential, which is where the server reads it.
 */
const PASSPHRASE_STEPS =
  "put it in a file only you can read and set AGNI_VAULT_PASSPHRASE_FILE to that file for setup, migrate and service install " +
  "(service install passes it to the service as LoadCredential=agni-vault-passphrase:<file>)";

/** The first sentence of a keystore error, without its closing full stop. */
function reasonOf(error: VaultError): string {
  // The text comes from the operating system. A line break in it would end the `# ...` note in config.env and let the
  // rest of the message become a setting, so every CR and LF is a space before anything is split or kept.
  const text = error.message.replace(/[\r\n]+/g, " ");
  const first = text.split(/(?<=\.)\s/)[0] ?? text;
  return first.replace(/\.$/, "").slice(0, 240);
}

function howToEnable(code: VaultError["code"], platform: NodeJS.Platform): string {
  if (code === "PASSPHRASE_MISSING") {
    return `give the vault a passphrase: ${PASSPHRASE_STEPS}`;
  }
  if (platform === "linux") {
    return `start a desktop keyring (a Secret Service), or on a headless server give the vault a passphrase: ${PASSPHRASE_STEPS}`;
  }
  if (platform === "darwin") return "unlock the login keychain and allow Agni to use it";
  return "make sure Windows Credential Manager is available to this account";
}

function validateKeystoreName(env: Env): void {
  const asked = env.AGNI_KEYSTORE?.trim().toLowerCase() || "auto";
  if (asked !== "auto" && asked !== "bun-secrets" && asked !== "passphrase") {
    throw new Error(`AGNI_KEYSTORE must be auto, bun-secrets or passphrase (got "${asked}"). Fix it and run setup again.`);
  }
}

/** Write `AGNI_SECRETS_MODE` into config.env, with a dated line above it saying why when there is a note. */
function recordMode(envFile: string, mode: SecretsMode, note?: string): void {
  setEnvFileValues(envFile, { AGNI_SECRETS_MODE: mode });
  if (!note) return;
  const text = readFileSync(envFile, "utf8");
  writePrivateFileSync(envFile, text.replace(/^AGNI_SECRETS_MODE=.*$/m, (line) => `# ${note}\n${line}`));
}

function recordedMessage(mode: SecretsMode, where: string): string {
  return mode === "vault"
    ? `secrets mode: vault (${where})`
    : `secrets mode: file (${where})\n  Credentials stay in config.env. Run ${MIGRATE} to move them into the encrypted vault.`;
}

/**
 * A mode that only the shell named (`AGNI_SECRETS_MODE=vault agni setup`). The service gets just `AGNI_HOME`, so a mode
 * kept only in the shell would be gone when it starts and the server would run in file mode while setup said vault.
 * Write it into `config.env`, and for `vault` make the vault now, so the shell and the service agree. A `config.env`
 * that already holds another mode is left alone: the owner wrote it, and the message says which one the service uses.
 */
async function recordShellMode(options: ChooseOptions, mode: SecretsMode, fileMode: SecretsMode | undefined): Promise<SecretsChoice> {
  const { home } = options;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (fileMode !== undefined && fileMode !== mode) {
    return {
      mode,
      reason: "recorded",
      message:
        `${recordedMessage(mode, "set in the environment")}\n  warning: config.env says ${fileMode}, and a service started by \`agni service install\` reads config.env, ` +
        `so it will run in ${fileMode} mode. Change AGNI_SECRETS_MODE in config.env to ${mode} if that is not what you want.`,
    };
  }
  const envFile = join(home, "config.env");
  if (mode === "file") {
    recordMode(envFile, "file");
    return { mode, reason: "recorded", message: recordedMessage(mode, "set in the environment; now recorded in config.env") };
  }
  validateKeystoreName(env);
  try {
    const vault = await unlockVault({ home, env, create: true, keystore: options.keystore });
    recordMode(envFile, "vault");
    return {
      mode,
      reason: "recorded",
      message: `secrets mode: vault (set in the environment; now recorded in config.env)\n  Credentials are encrypted in ${vault.path}; the key is kept by ${backendLabel(vault.keystoreKind, platform)}.`,
    };
  } finally {
    lockVault();
  }
}

/**
 * Decide the secrets mode for `home` and make it so. Throws for anything that is not "no usable keystore": a damaged
 * credential store, a home that cannot be written, a mistyped `AGNI_KEYSTORE`. Those are errors to fix, not reasons
 * to keep keys in plaintext.
 */
export async function chooseSecretsMode(options: ChooseOptions): Promise<SecretsChoice> {
  const { home } = options;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const recorded = recordedSecretsMode(home, env);
  if (recorded?.source === "environment") return recordShellMode(options, recorded.mode, recorded.fileMode);
  if (recorded) return { mode: recorded.mode, reason: "recorded", message: recordedMessage(recorded.mode, "recorded in config.env") };
  if (!homeIsFresh(home, env)) {
    return {
      mode: "file",
      reason: "existing",
      message:
        "secrets mode: file\n  This home already holds data or credentials and has no mode recorded, so it stays in file mode and its credentials stay in config.env. " +
        `Run ${MIGRATE} to encrypt them.`,
    };
  }
  validateKeystoreName(env);
  const envFile = join(home, "config.env");
  try {
    const vault = await unlockVault({ home, env, create: true, keystore: options.keystore });
    const kind = vault.keystoreKind;
    const path = vault.path;
    recordMode(envFile, "vault");
    return {
      mode: "vault",
      reason: "fresh",
      message: `secrets mode: vault\n  Credentials are encrypted in ${path}; the key is kept by ${backendLabel(kind, platform)}.`,
    };
  } catch (error) {
    if (!(error instanceof VaultError) || (error.code !== "KEYSTORE_UNAVAILABLE" && error.code !== "PASSPHRASE_MISSING")) throw error;
    const reason = reasonOf(error);
    const how = howToEnable(error.code, platform);
    const date = (options.now ?? new Date()).toISOString().slice(0, 10);
    recordMode(envFile, "file", `${date} agni setup chose file mode: ${reason}. To use the vault later, ${how}, then run agni vault migrate.`);
    return {
      mode: "file",
      reason: "keystore-unavailable",
      message:
        `secrets mode: file\n  ${reason}, so credentials stay in config.env, readable only by you. ` +
        `To use the encrypted vault later, ${how}, then run ${MIGRATE}.`,
    };
  } finally {
    lockVault();
  }
}

export interface PrepareOptions extends ChooseOptions {
  /** The template for a new `config.env` (`infra/env.example`). */
  envExample: string;
}

export interface PrepareResult {
  /** True when this run wrote `config.env`. */
  created: boolean;
  secrets: SecretsChoice;
}

/**
 * Everything `agni setup` does before it starts a service: AGNI_HOME owner-only, `config.env` from the template (kept
 * if there is one), then the secrets mode. Throws when the home cannot be made private: the owner is about to put keys here.
 */
export async function prepareHome(options: PrepareOptions): Promise<PrepareResult> {
  const { home } = options;
  const envPath = join(home, "config.env");
  let created = false;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // An older ~/.agni may be 755; the DB and logs inside rely on this being private.
  chmodSync(home, 0o700);
  // Windows has no mode bits. The directory gets an owner-only ACL before
  // config.env exists, so the file is created already protected, and the
  // files already under it (an upgrade) inherit it. Fail closed: the owner is
  // about to put API keys in here.
  secureDirectory(home, "throw");
  verifyHomePrivate(home);
  if (!existsSync(envPath)) {
    copyFileSync(options.envExample, envPath);
    chmodSync(envPath, 0o600);
    created = true;
  }
  // Also on a rerun: a config.env from an older setup may have its own ACL.
  secureFile(envPath);
  return { created, secrets: await chooseSecretsMode(options) };
}
