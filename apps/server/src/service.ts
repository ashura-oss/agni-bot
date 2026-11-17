/** `agni service install|uninstall|status`: run `serve` under launchd (macOS) or systemd --user (Linux). */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Config } from "./config";
import { daemonStatus, fetchHealth } from "./daemon";
import { agniHome } from "./home";
import { assertPassphraseFilePrivate, PASSPHRASE_CREDENTIAL_NAME } from "./secrets/passphrase";
import type { KeyStoreKind } from "./secrets/types";
import { vaultStatus } from "./secrets/unlock";

export const LAUNCHD_LABEL = "dev.agni.server";
export const SYSTEMD_UNIT = "agni.service";

export interface ServiceOptions {
  bun: string;
  script: string;
  home: string;
  logPath: string;
  /**
   * systemd only: the file holding the vault passphrase (headless Linux). It
   * reaches the server as the credential `agni-vault-passphrase`; the unit
   * never contains the passphrase itself.
   */
  passphraseFile?: string;
}

const xmlEscape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

export function launchdPlist(o: ServiceOptions): string {
  const e = xmlEscape;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${e(o.bun)}</string>
    <string>${e(o.script)}</string>
    <string>serve</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${e(o.home)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AGNI_HOME</key>
    <string>${e(o.home)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${e(o.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${e(o.logPath)}</string>
</dict>
</plist>
`;
}

/** systemd splits ExecStart on whitespace; quote each word and escape backslash, quote and %. */
const sdQuote = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

/**
 * The `LoadCredential=` line that hands a passphrase file to the service.
 * systemd puts it at `$CREDENTIALS_DIRECTORY/agni-vault-passphrase`, which is
 * where the passphrase keystore looks, so the server needs no variable for it.
 */
export function systemdCredentialLine(file: string): string {
  if (!file.startsWith("/")) throw new Error(`the vault passphrase file must be an absolute path (got "${file}")`);
  return `LoadCredential=${PASSPHRASE_CREDENTIAL_NAME}:${file.replace(/%/g, "%%")}`;
}

/**
 * The passphrase file an installed unit passes to the service (the inverse of `systemdCredentialLine`), or `undefined`
 * when the unit carries none. `agni doctor` uses it: run from a shell, it has no `$CREDENTIALS_DIRECTORY`, but the
 * unit says where the service's passphrase comes from.
 */
export function passphraseFileFromUnit(unit: string): string | undefined {
  const match = new RegExp(`^LoadCredential=${PASSPHRASE_CREDENTIAL_NAME}:(.+?)\\s*$`, "m").exec(unit);
  return match?.[1]?.replace(/%%/g, "%");
}

/**
 * The passphrase file the unit must pass on, or `undefined` when the vault does
 * not use the passphrase backend. The backend is the passphrase when
 * `AGNI_KEYSTORE=passphrase`, when an existing vault's header says so, or when
 * the owner names a passphrase file (a headless set-up). A passphrase backend
 * with no file named throws: that unit could never start the server.
 */
export function passphraseServiceFile(env: Record<string, string | undefined>, headerKind: KeyStoreKind | undefined): string | undefined {
  const asked = env.AGNI_KEYSTORE?.trim().toLowerCase();
  const file = env.AGNI_VAULT_PASSPHRASE_FILE?.trim() || undefined;
  if (asked === "bun-secrets" || headerKind === "bun-secrets") return undefined;
  const passphrase = asked === "passphrase" || headerKind === "passphrase";
  if (passphrase && !file) {
    throw new Error(
      "the vault uses a passphrase: set AGNI_VAULT_PASSPHRASE_FILE to the file that holds it (readable only by you) and run `service install` again, " +
        "so the service can be given it as a systemd credential",
    );
  }
  return file;
}

export function systemdUnit(o: ServiceOptions): string {
  const credential = o.passphraseFile ? `${systemdCredentialLine(o.passphraseFile)}\n` : "";
  return `[Unit]
Description=Agni Bot server
After=network-online.target

[Service]
ExecStart=${sdQuote(o.bun)} ${sdQuote(o.script)} serve
WorkingDirectory=${o.home.replace(/%/g, "%%")}
Environment=${sdQuote(`AGNI_HOME=${o.home}`)}
${credential}Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`;
}

function options(config: Config): ServiceOptions {
  return {
    bun: process.execPath,
    script: resolve(import.meta.dir, "index.ts"),
    home: agniHome(),
    logPath: resolve(config.logPath),
  };
}

function run(cmd: string[], allowFail = false): { ok: boolean; out: string } {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  const out = `${r.stdout.toString()}${r.stderr.toString()}`.trim();
  if (r.exitCode !== 0 && !allowFail) throw new Error(`${cmd.join(" ")} failed: ${out}`);
  return { ok: r.exitCode === 0, out };
}

const plistPath = (): string => join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
/** Where `service install` writes the systemd user unit. */
export const systemdUnitPath = (): string => join(homedir(), ".config", "systemd", "user", SYSTEMD_UNIT);
const unitPath = systemdUnitPath;

export async function serviceCommand(sub: string | undefined, config: Config): Promise<void> {
  const mac = process.platform === "darwin";
  if (!mac && process.platform !== "linux") throw new Error(`service is not supported on ${process.platform}`);
  const target = `gui/${process.getuid?.() ?? 501}/${LAUNCHD_LABEL}`;

  if (sub === "install") {
    // Only the detached daemon has a pid file; a server answering without one
    // is usually this service already, and reinstalling it is the upgrade path.
    const status = await daemonStatus(config);
    if (status.pid !== undefined && (status.running || status.unhealthy)) {
      throw new Error("the detached daemon is running; run `agni daemon stop` first, then install the service");
    }
    const o = options(config);
    mkdirSync(dirname(o.logPath), { recursive: true, mode: 0o700 });
    if (mac) {
      const path = plistPath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, launchdPlist(o));
      run(["launchctl", "bootout", target], true);
      run(["launchctl", "bootstrap", `gui/${process.getuid?.() ?? 501}`, path]);
      console.log(`installed ${path}`);
    } else {
      const path = unitPath();
      // A vault opened by passphrase (headless server): hand the file to the service as a systemd credential.
      const passphraseFile = passphraseServiceFile(process.env, vaultStatus().keystoreKind);
      if (passphraseFile) {
        o.passphraseFile = resolve(passphraseFile);
        if (!existsSync(o.passphraseFile)) {
          throw new Error(`the vault passphrase file ${o.passphraseFile} does not exist; create it (readable only by you) and run \`service install\` again`);
        }
        // systemd copies this file into the service's credential directory; a copy of an open file would be open too.
        assertPassphraseFilePrivate(o.passphraseFile);
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, systemdUnit(o));
      run(["systemctl", "--user", "daemon-reload"]);
      run(["systemctl", "--user", "enable", "--now", "agni"]);
      console.log(`installed ${path}`);
      console.log("headless box? run `loginctl enable-linger $USER` so it starts without a login session");
    }
    console.log(`logs: ${o.logPath}`);
  } else if (sub === "uninstall") {
    if (mac) {
      run(["launchctl", "bootout", target], true);
      rmSync(plistPath(), { force: true });
    } else {
      run(["systemctl", "--user", "disable", "--now", "agni"], true);
      rmSync(unitPath(), { force: true });
      run(["systemctl", "--user", "daemon-reload"], true);
    }
    console.log("service removed (data in AGNI_HOME is untouched)");
  } else if (sub === "status") {
    const installed = existsSync(mac ? plistPath() : unitPath());
    console.log(`installed: ${installed ? "yes" : "no"}`);
    const r = mac ? run(["launchctl", "print", target], true) : run(["systemctl", "--user", "status", "agni", "--no-pager"], true);
    const lines = r.out.split("\n").filter((l) => /state|pid|Active:|Main PID|last exit/i.test(l));
    console.log(r.ok ? lines.map((l) => `  ${l.trim()}`).join("\n") : "  not loaded");
    const health = await fetchHealth(config);
    console.log(health ? `health: ok (up ${Math.round(health.uptimeMs / 1000)}s)` : "health: no response");
  } else {
    throw new Error("usage: service install|uninstall|status");
  }
}
