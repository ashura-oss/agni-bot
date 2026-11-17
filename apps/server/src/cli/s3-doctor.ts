/**
 * `agni doctor`: which secrets mode is active, which keystore backs it (or why none), and a warning when the plaintext
 * file mode is in use on a machine where the vault would work. Read-only: it never opens or makes the vault, writes
 * nothing, and prints no secret value (credential names only).
 */
import { join } from "node:path";
import { agniHome } from "../home";
import { secretClassifier } from "../secrets/classify";
import { plaintextSecretNames } from "../secrets/env";
import { probeKeyStore } from "../secrets/probe";
import { recordedSecretsMode } from "../secrets/setup-mode";
import { vaultStatus } from "../secrets";
import type { KeyStore } from "../secrets";
import type { CommandTable } from "./command-table";

export interface DoctorOptions {
  home?: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  /** Probe exactly this keystore (tests). */
  keystore?: KeyStore;
}

export interface DoctorReport {
  lines: string[];
  /** False when something is wrong enough that the server will not start. Warnings do not make it false. */
  ok: boolean;
}

const label = (name: string): string => `${name}:`.padEnd(15);

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

  const plaintext = plaintextSecretNames(join(home, "config.env"), secretClassifier({ env, home }));
  let ok = true;
  if (mode === "file" && probe.available) {
    lines.push(
      "warning: file mode is active, but the vault would work on this machine. Credentials in config.env are readable by anything running as you. " +
        "Run `agni vault migrate` to encrypt them.",
    );
    if (plaintext.length > 0) lines.push(`  plaintext credentials in config.env: ${plaintext.join(", ")}`);
  }
  if (mode === "vault" && !probe.available) {
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
  help: ["  doctor             which secrets mode is active, which keystore backs it, and any warning"],
};
