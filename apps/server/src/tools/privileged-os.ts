/**
 * Privileged commands with the operating system's own authorization
 * (PR 5, the `os` auth mode).
 *
 * On a Mac, `osascript` can ask macOS for the administrator password — or
 * for Touch ID — and run a command as root. The owner never types a
 * password into Agni, the model never sees one, and nothing is written to
 * a transcript.
 *
 * Three details matter:
 *
 *   - The command goes into a **private directory** (`mkdtemp`, 0700) as a
 *     script (0700), never into a bare temp file and never into argv
 *     (argv is visible to every process on the machine).
 *   - The script is **deleted the moment the run ends**, whatever the
 *     outcome.
 *   - The authorization dialog shows **the command itself**, because the
 *     approval covers the whole script — so the owner sees what they are
 *     agreeing to, not a path.
 *
 * `pam_tid` is deliberately not used: it changes system-wide sudo
 * behaviour, it persists, and it does not help over SSH or Tailscale.
 */
import { execFile } from "node:child_process";
import { rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { childEnv } from "../util/child-env";
import { privateTempDir } from "../util/private-temp";

/** Where macOS keeps osascript. Called by this path, never found through PATH. */
export const OSASCRIPT_PATH = "/usr/bin/osascript";

/** Is this host a Mac? The OS authorization path exists nowhere else. */
export function isMacOS(): boolean {
  return process.platform === "darwin";
}

export interface PrivilegedRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** True when the run used the OS authorization dialog. */
  usedOSAuth: boolean;
}

/** The longest command os-mode takes. The dialog shows the command, so a longer one could hide its middle. */
export const OS_COMMAND_MAX = 300;

/**
 * Anything but one short simple command: chaining (`;` `&` `&&` `||`), pipes, redirection (`<` `>`),
 * substitution (backticks, `$(`, `${`), newlines, or more than 300 characters. Such a command is refused, not cut.
 */
export function isCompoundCommand(command: string): boolean {
  return /[;|&<>`\n\r]|\$[({]/.test(command) || command.length > OS_COMMAND_MAX;
}

const PROMPT_MAX = OS_COMMAND_MAX;

/** The dialog text: escaped for an AppleScript string, long commands keep head and tail. */
export function osAuthPrompt(command: string): string {
  let c = command.replace(/\s+/g, " ").trim();
  if (c.length > PROMPT_MAX) c = `${c.slice(0, 180)} ... ${c.slice(-100)}`;
  return `Agni wants to run as root: ${c}`.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * The AppleScript that runs the script file's contents with administrator
 * privileges. The path arrives as an argument; the prompt shows the command.
 */
export function buildAppleScript(command: string): string {
  return [
    "on run argv",
    "  set scriptPath to item 1 of argv",
    "  set scriptText to read (POSIX file scriptPath) as «class utf8»",
    `  do shell script scriptText with prompt "${osAuthPrompt(command)}" with administrator privileges`,
    "end run",
  ].join("\n");
}

/**
 * Write the command into a private script and hand back the paths. The
 * caller owns the cleanup: the directory is removed the moment the run ends,
 * pass or fail.
 */
export function writePrivilegedScript(command: string): { dir: string; scriptPath: string } {
  const dir = privateTempDir("agni-privileged-");
  const scriptPath = join(dir, "command.sh");
  writeFileSync(scriptPath, `#!/bin/sh\n${command}\n`, { mode: 0o700 });
  chmodSync(scriptPath, 0o700);
  return { dir, scriptPath };
}

/** Remove the private directory, overwriting the script first. */
export function removePrivilegedScript(dir: string, scriptPath: string): void {
  try {
    writeFileSync(scriptPath, "#!/bin/sh\n# removed\n", { mode: 0o700 });
  } catch {
    // The file may already be gone; the removal below still runs.
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Temp cleanup is best effort.
  }
}

/**
 * Run a command with the owner's OS authorization.
 *
 * Returns the command's output. The authorization itself is the operating
 * system's business: a cancelled dialog comes back as a non-zero exit with
 * an explanation, never as a hang.
 */
export function runPrivilegedWithOSAuth(
  command: string,
  options: { timeoutMs?: number; /** For tests: stands in for `execFile`. */ exec?: typeof execFile } = {},
): Promise<PrivilegedRunResult> {
  if (isCompoundCommand(command)) {
    return Promise.resolve({
      stdout: "",
      stderr: `os-mode runs one simple command only (no ; & && || | < > backticks, $( ), \${ } or newlines, and at most ${OS_COMMAND_MAX} characters). Split it into separate commands.`,
      exitCode: 1,
      usedOSAuth: false,
    });
  }
  const timeoutMs = Math.min(options.timeoutMs ?? 120_000, 120_000);
  const { dir, scriptPath } = writePrivilegedScript(command);
  return new Promise<PrivilegedRunResult>((resolve) => {
    // By absolute path, so a program placed earlier on PATH cannot stand in for it, and with the clean child
    // environment, so nothing of the server's own reaches the authorization helper.
    (options.exec ?? execFile)(
      OSASCRIPT_PATH,
      ["-e", buildAppleScript(command), scriptPath],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: childEnv("shell") },
      (error, stdout, stderr) => {
        removePrivilegedScript(dir, scriptPath);
        const text = String(stdout ?? "");
        const errorText = String(stderr ?? "");
        if (error) {
          // A cancelled dialog, a refused password and a failed command all
          // arrive here. The message says which.
          const cancelled = /User canceled|cancelled|canceled|-128/i.test(errorText);
          resolve({
            stdout: text,
            stderr: errorText || (cancelled ? "The authorization was cancelled." : error.message),
            exitCode: typeof (error as { code?: number }).code === "number" ? (error as { code: number }).code : 1,
            usedOSAuth: true,
          });
          return;
        }
        resolve({ stdout: text, stderr: errorText, exitCode: 0, usedOSAuth: true });
      },
    );
  });
}

/**
 * Which auth mode a command should use.
 *
 * `auto` uses the operating system's authorization for the commands that
 * are about the machine (`sudo …`), and the one-time password prompt for
 * everything else — an `ssh` or a `git push` must run as the owner, not as
 * root.
 */
export type AuthMode = "auto" | "password" | "os";

export function resolveAuthMode(mode: AuthMode | undefined, command: string): "os" | "password" {
  const requested = mode ?? "auto";
  if (requested === "password") return "password";
  if (requested === "os") return isMacOS() ? "os" : "password";
  // auto: the machine-level commands go to the OS, the rest to the prompt.
  if (!isMacOS()) return "password";
  const first = command.trim().split(/\s+/)[0] ?? "";
  if (!isCompoundCommand(command) && ["sudo", "doas", "dscl", "systemsetup", "visudo"].includes(first)) return "os";
  return "password";
}

/** Read a file the root-owned run may have written (stderr, mostly). */
export function readIfPresent(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
