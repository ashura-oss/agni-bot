/**
 * `agni doctor`: which secrets mode is active, which keystore backs it (or why none), whether the server can unlock
 * the vault that is there, and a warning when the plaintext file mode is in use on a machine where the vault would
 * work. It never makes a vault, never changes one, writes nothing to the credential store, and prints no secret
 * value (credential names only). The one write it can cause is the one the server makes too: a passphrase file open
 * to other accounts is closed to them before it is read.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agniHome } from "../home";
import { secretClassifier } from "../secrets/classify";
import { plaintextSecretNames } from "../secrets/env";
import { passphraseFilePath } from "../secrets/passphrase";
import { checkVaultKey, probeKeyStore, type VaultKeyCheck } from "../secrets/probe";
import { recordedSecretsMode } from "../secrets/setup-mode";
import { vaultStatus } from "../secrets";
import type { KeyStore } from "../secrets";
import { passphraseFileFromUnit, systemdUnitPath } from "../service";
import type { CommandTable } from "./command-table";

export interface DoctorOptions {
  home?: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  /** Probe and check with exactly this keystore (tests). */
  keystore?: KeyStore;
  /** The systemd user unit to read the service's passphrase file from (tests). Default: where `service install` writes it. */
  unitPath?: string;
}

export interface DoctorReport {
  lines: string[];
  /** False when something is wrong enough that the server will not start. Warnings do not make it false. */
  ok: boolean;
}

const label = (name: string): string => `${name}:`.padEnd(15);

/** The text of the installed systemd user unit, or `undefined` when there is none (or it cannot be read). */
function readUnit(path: string): string | undefined {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Check that the server can unlock the vault in `home`. A passphrase vault on a headless server gets its passphrase
 * from the service unit (`LoadCredential=`), not from this shell, so when the shell has no passphrase file the
 * installed unit is asked where the service's file is. Returns the check, and what it learned about the unit.
 */
async function checkVault(options: DoctorOptions, home: string, env: Record<string, string | undefined>, headerKind: string | undefined) {
  const platform = options.platform ?? process.platform;
  const wantsPassphrase = headerKind === "passphrase" || env.AGNI_KEYSTORE?.trim().toLowerCase() === "passphrase";
  const shellFile = passphraseFilePath(env);
  let checkEnv = env;
  let unit: { installed: boolean; file?: string } | undefined;
  if (!options.keystore && wantsPassphrase && platform === "linux" && !(shellFile && existsSync(shellFile))) {
    const text = readUnit(options.unitPath ?? systemdUnitPath());
    unit = { installed: text !== undefined, file: text === undefined ? undefined : passphraseFileFromUnit(text) };
    if (unit.file) checkEnv = { ...env, AGNI_VAULT_PASSPHRASE_FILE: unit.file };
  }
  const check: VaultKeyCheck = await checkVaultKey({ home, env: checkEnv, platform, keystore: options.keystore });
  return { check, unit };
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const home = options.home ?? agniHome(env);
  const recorded = recordedSecretsMode(home, env);
  const mode = recorded?.mode ?? "file";
  const lines = ["agni doctor", `${label("home")}${home}`];
  const where = recorded
    ? recorded.source === "config.env" ? "recorded in config.env" : "set in the environment"
    : "no mode recorded: this home was made before the vault became the default, or never went through `agni setup`";
  lines.push(`${label("secrets mode")}${mode} (${where})`);

  const vault = vaultStatus({ home, env });
  const probe = await probeKeyStore({ env, platform: options.platform, headerKind: vault.keystoreKind, keystore: options.keystore });
  lines.push(`${label("keystore")}${probe.available ? `${probe.kind} (${probe.backend})` : `none: ${probe.reason}`}`);
  lines.push(
    `${label("vault file")}${vault.path} (${vault.exists ? `exists, made with the ${vault.keystoreKind ?? "unreadable"} keystore` : "not created yet; the server makes it at its first start in vault mode"})`,
  );

  let ok = true;
  // "ok" means the server can unlock the vault it will find: in either mode, a vault.bin that cannot be opened stops the server.
  if (vault.exists) {
    const { check, unit } = await checkVault(options, home, env, vault.keystoreKind);
    if (check.ok) {
      lines.push(`${label("vault key")}can unlock${unit?.file ? ` (passphrase file taken from the installed service unit: ${unit.file})` : ""}`);
    } else if (check.code === "PASSPHRASE_MISSING" && unit !== undefined && !unit.installed) {
      // Nothing in this shell and no user unit: a system unit, or a service managed some other way, may still pass it.
      lines.push(`${label("vault key")}not checked from this shell (no passphrase file here, and no installed service unit passes one)`);
      lines.push(
        "warning: the vault is opened with a passphrase, and doctor cannot see where the service gets it. A service that is given it as a systemd credential " +
          "(LoadCredential=agni-vault-passphrase:<file>) can unlock the vault; to check from this shell, set AGNI_VAULT_PASSPHRASE_FILE to that file and run `agni doctor` again.",
      );
    } else {
      ok = false;
      lines.push(`${label("vault key")}cannot unlock (${check.code}): ${check.reason}`);
      if (check.code === "PASSPHRASE_MISSING" && unit?.installed) {
        lines.push("  The installed service unit passes no passphrase: set AGNI_VAULT_PASSPHRASE_FILE to the file that holds it and run `agni service install` again, so the unit gets LoadCredential=agni-vault-passphrase:<file>.");
      }
      lines.push(
        "error: the vault cannot be unlocked, so the server will refuse to start. It never falls back to plaintext keys; fix the above and run `agni doctor` again.",
      );
    }
  }
  if (vault.exists && !recorded) {
    lines.push(
      "warning: vault.bin exists but no secrets mode is recorded, so the server runs in file mode. If you meant to use the vault, run `agni vault migrate` (it records the mode) " +
        "or set AGNI_SECRETS_MODE=vault in config.env.",
    );
  }

  const plaintext = plaintextSecretNames(join(home, "config.env"), secretClassifier({ env, home }));
  if (mode === "file" && probe.available) {
    lines.push(
      "warning: file mode is active, but the vault would work on this machine. Credentials in config.env are readable by anything running as you. " +
        "Run `agni vault migrate` to encrypt them.",
    );
    if (plaintext.length > 0) lines.push(`  plaintext credentials in config.env: ${plaintext.join(", ")}`);
  }
  if (mode === "vault" && !probe.available && !vault.exists) {
    ok = false;
    lines.push(
      "error: vault mode is active but the keystore is not available, so the server will refuse to start. It never falls back to plaintext keys; " +
        "fix the keystore (see above) and run `agni doctor` again.",
    );
  }
  if (mode === "vault" && plaintext.length > 0) {
    lines.push(
      `warning: config.env still holds plaintext credentials that vault mode ignores: ${plaintext.join(", ")}. Run \`agni vault migrate\` to move them into the vault.`,
    );
  }
  return { lines, ok };
}

async function doctor(): Promise<void> {
  const report = await runDoctor();
  for (const line of report.lines) console.log(line);
  if (!report.ok) process.exitCode = 1;
}

/** CLI commands for `agni doctor`. */
export const s3DoctorCommands: CommandTable = {
  commands: { doctor },
  help: ["  doctor             which secrets mode is active, which keystore backs it, whether the vault can be unlocked, and any warning"],
};
