/**
 * The environment and PATH every child process gets (S2-14).
 *
 * Replaces `scrubbed-env.ts`, which removed secrets from a copy of the
 * server's environment by name and by value. A denylist only works for
 * secrets someone thought of. This is an allowlist: a child gets the names
 * listed below and nothing else, so a key exported by hand, a token a tool
 * left behind, or a variable added next year never reaches it.
 *
 * Three kinds of child, each with the names it needs:
 *  - "shell": a command the model wrote (`bash`, `run_privileged`). Core
 *    names plus what Windows tools need to run. No server settings, no keys.
 *  - "pdf-worker": parses an untrusted file. Core names only.
 *  - "daemon": the server itself, started by `agni daemon start`. Needs its
 *    own settings (`AGNI_*`), the provider keys the owner exported
 *    (`providerKeyEnvNames()`), the mail settings, the names the key store
 *    needs (the keyring's bus, the runtime and credential folders), and the
 *    owner's PATH (it launches the owner's MCP tools). It is never reachable
 *    by the model.
 *
 * A key stored in `config.env` needs no name here: the server loads that file
 * itself. Custom endpoints that name their own key variable are loaded the
 * same way.
 */
import { win32 } from "node:path";
import { log } from "../log";
import { providerKeyEnvNames } from "../models/providers";
import { envValue, isWindowsDrivePath, type Env } from "./env-lookup";
import { gitInstall } from "./git-bash";
import { PROXY_VARIABLE, stripProxyUserinfo } from "./proxy-env";

export type ChildKind = "shell" | "pdf-worker" | "daemon";

/** Every child: where the home is, where the system is, where temporary files go, locale and time zone. */
const CORE_NAMES = ["HOME", "USERPROFILE", "SystemRoot", "windir", "TEMP", "TMP", "TMPDIR", "TZ", "LANG", "LANGUAGE"];
const CORE_PATTERNS = [/^LC_[A-Z_]+$/i];

/** Windows tools (cmd, PowerShell, Git for Windows, installers) fail or misbehave without these. None is a secret. */
const WINDOWS_PLATFORM_NAMES = [
  "SystemDrive", "COMSPEC", "PATHEXT", "HOMEDRIVE", "HOMEPATH", "USERNAME", "USERDOMAIN", "COMPUTERNAME",
  "APPDATA", "LOCALAPPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432",
  "CommonProgramFiles", "CommonProgramFiles(x86)", "CommonProgramW6432", "ALLUSERSPROFILE", "PUBLIC",
  "OS", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS",
];
const POSIX_IDENTITY_NAMES = ["USER", "LOGNAME"];

/** Proxy settings and certificate bundles: a shell command behind a proxy (git, curl, npm) fails without them. */
const NETWORK_NAMES = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"];
/** Only the address of the owner's ssh agent, so `git` and `ssh` can use the keys it already holds. */
const SSH_AGENT_NAMES = ["SSH_AUTH_SOCK"];
/** The server only: also the SOCKS/all-protocol proxy. */
const DAEMON_NETWORK_NAMES = [...NETWORK_NAMES, "ALL_PROXY"];
/**
 * The server only: what the key store needs. libsecret talks to the owner's keyring over the session bus
 * (`DBUS_SESSION_BUS_ADDRESS`, found through `XDG_RUNTIME_DIR`), and the systemd passphrase for the vault arrives in the
 * folder `CREDENTIALS_DIRECTORY` names. None is a secret, and leaving them out of a shell child is tidiness, not a boundary: a
 * command can find the bus socket or the folder without them. What keeps a command the model wrote away from the keyring and
 * that folder is the policy: the one command that runs free (a plain read-only one, such as `cat`) reads only inside scratch, and
 * every other command asks the owner first (`policy/metadata.ts`). (`AGNI_TEST_RUN` passes as `AGNI_*`.)
 */
const DAEMON_KEYSTORE_NAMES = ["DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "CREDENTIALS_DIRECTORY"];
/** The server only: its own settings, mail settings, and each provider's base URL and model (`GROQ_MODEL`, `OPENROUTER_BASE_URL`, ...). */
const DAEMON_PATTERNS = [/^AGNI_/i, /^GMAIL_/i, /^[A-Z0-9]+_(?:BASE_URL|MODEL)$/i];

function lowerSet(names: string[]): Set<string> {
  return new Set(names.map((name) => name.toLowerCase()));
}

const CORE = lowerSet(CORE_NAMES);
const SHELL_EXTRA = lowerSet([...WINDOWS_PLATFORM_NAMES, ...POSIX_IDENTITY_NAMES, ...NETWORK_NAMES, ...SSH_AGENT_NAMES]);
const DAEMON_EXTRA = lowerSet([...WINDOWS_PLATFORM_NAMES, ...POSIX_IDENTITY_NAMES, ...DAEMON_NETWORK_NAMES, ...DAEMON_KEYSTORE_NAMES]);

function isAllowed(kind: ChildKind, name: string): boolean {
  const lower = name.toLowerCase();
  if (CORE.has(lower) || CORE_PATTERNS.some((pattern) => pattern.test(name))) return true;
  if (kind === "shell") return SHELL_EXTRA.has(lower);
  if (kind === "daemon") {
    if (DAEMON_EXTRA.has(lower) || DAEMON_PATTERNS.some((pattern) => pattern.test(name))) return true;
    return providerKeyEnvNames().some((key) => key.toLowerCase() === lower);
  }
  return false;
}

/** `/usr/local/bin` and friends. Fixed: never read from the server's PATH. */
const POSIX_SYSTEM_DIRS = ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const MACOS_EXTRA_DIRS = ["/opt/homebrew/bin", "/opt/homebrew/sbin"];

function validDir(dir: string, windows: boolean): boolean {
  if (!dir || dir.trim() !== dir) return false;
  if (windows) return isWindowsDrivePath(dir) && !dir.includes(";");
  return dir.startsWith("/") && !dir.includes(":");
}

function systemRoot(source: Env): string | null {
  const root = ["SystemRoot", "windir"].map((name) => envValue(source, name)).find(isWindowsDrivePath);
  return root ? win32.normalize(root).replace(/[\\/]+$/, "") : null;
}

export interface ChildPathOptions {
  /** Where SystemRoot comes from. Defaults to the server's environment. */
  source?: Env;
  platform?: NodeJS.Platform;
  /** The Git for Windows root. `null`: none. Omitted: the install found on this machine, if any. */
  gitRoot?: string | null;
  /**
   * Directories to put first. Only for a private folder the server itself just
   * made (the privileged shell's askpass folder, which holds the `sudo`
   * wrapper). Anything not absolute is dropped.
   */
  prepend?: string[];
  /** Add the owner's `AGNI_SHELL_EXTRA_PATH` directories at the end. Default true; the PDF worker turns it off. */
  ownerDirs?: boolean;
}

/** The environment variable the owner sets (in `~/.agni/config.env`) to put Node, Python, gh and the like on the shell's PATH. */
export const SHELL_EXTRA_PATH_VARIABLE = "AGNI_SHELL_EXTRA_PATH";

const reportedOwnerDirs = new Set<string>();

function reportOnce(level: "info" | "warn", key: string, message: string): void {
  if (reportedOwnerDirs.has(key)) return;
  reportedOwnerDirs.add(key);
  log[level](message);
}

/**
 * The owner's extra directories: absolute entries of `AGNI_SHELL_EXTRA_PATH`.
 * Each one is logged the first time it is used, and a rejected one is warned
 * about once. They are appended after the system directories, so a program
 * with a system name can never be replaced by one from a folder the owner (or
 * anything running as the owner) can write to.
 */
function ownerDirs(source: Env, windows: boolean): string[] {
  const raw = envValue(source, SHELL_EXTRA_PATH_VARIABLE);
  if (!raw) return [];
  const accepted: string[] = [];
  for (const entry of raw.split(windows ? ";" : ":")) {
    if (entry === "") continue;
    if (!validDir(entry, windows)) {
      reportOnce("warn", `bad:${entry}`, `${SHELL_EXTRA_PATH_VARIABLE}: ignoring "${entry}" (only absolute folders are allowed)`);
      continue;
    }
    reportOnce("info", `ok:${entry}`, `shell PATH: adding ${entry} from ${SHELL_EXTRA_PATH_VARIABLE}`);
    accepted.push(entry);
  }
  return accepted;
}

/**
 * The PATH a shell child gets, in this order:
 *  1. a private folder the server made for this one command (`prepend`);
 *  2. the system directories (Windows: System32, the Windows folder, Wbem,
 *     Windows PowerShell; POSIX: `/usr/local/bin`, `/usr/bin`, `/bin`, ...);
 *  3. Git for Windows' `usr\bin` and `bin` from its fixed install path, or
 *     Homebrew's folders on macOS;
 *  4. the owner's `AGNI_SHELL_EXTRA_PATH`.
 * Folders a user can write to (a per-user Git, Homebrew, the owner's tools)
 * therefore never come before the system ones. The server's own PATH is never
 * read. Only absolute entries survive, so `.`, an empty entry (which means the
 * current directory on some systems) and a relative path can never be on it.
 */
export function childPath(options: ChildPathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const windows = platform === "win32";
  const source = options.source ?? process.env;
  const dirs: string[] = [...(options.prepend ?? [])];
  if (windows) {
    const root = systemRoot(source);
    if (root) {
      dirs.push(
        win32.join(root, "System32"), root, win32.join(root, "System32", "Wbem"),
        win32.join(root, "System32", "WindowsPowerShell", "v1.0"),
      );
    }
    const git = options.gitRoot === undefined ? detectGitRoot() : options.gitRoot;
    if (git && isWindowsDrivePath(git)) dirs.push(win32.join(git, "usr", "bin"), win32.join(git, "bin"));
  } else {
    dirs.push(...POSIX_SYSTEM_DIRS);
    if (platform === "darwin") dirs.push(...MACOS_EXTRA_DIRS);
  }
  if (options.ownerDirs !== false) dirs.push(...ownerDirs(source, windows));
  return unique(dirs.filter((dir) => validDir(dir, windows)), windows).join(windows ? ";" : ":");
}

function detectGitRoot(): string | null {
  try {
    return gitInstall().root;
  } catch {
    return null;
  }
}

function unique(dirs: string[], caseInsensitive: boolean): string[] {
  const seen = new Set<string>();
  return dirs.filter((dir) => {
    const key = caseInsensitive ? dir.toLowerCase() : dir;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The owner's PATH, minus anything that is not an absolute directory. For the daemon only. */
function inheritedPath(source: Env, windows: boolean): string {
  const raw = envValue(source, "PATH") ?? "";
  return raw.split(windows ? ";" : ":").filter((dir) => validDir(dir, windows)).join(windows ? ";" : ":");
}

export interface ChildEnvOptions {
  /** The environment to filter. Defaults to the server's. It is never changed. */
  source?: Env;
  platform?: NodeJS.Platform;
  /** See `childPath`. */
  gitRoot?: string | null;
  /** Directories to put first on a shell child's PATH. */
  pathPrepend?: string[];
  /** Variables the caller sets itself. Added last, so they win. */
  extra?: Record<string, string>;
}

/** The environment for a child of this kind: allowlisted names from the source, the fixed PATH, then `extra`. */
export function childEnv(kind: ChildKind, options: ChildEnvOptions = {}): Record<string, string> {
  const source = options.source ?? process.env;
  const platform = options.platform ?? process.platform;
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || name.toLowerCase() === "path") continue;
    if (!isAllowed(kind, name)) continue;
    // A command the model wrote may print its environment: it gets the proxy's address, not the password in it.
    env[name] = kind === "shell" && PROXY_VARIABLE.test(name) ? stripProxyUserinfo(value) : value;
  }
  if (kind === "daemon") {
    const inherited = inheritedPath(source, platform === "win32");
    if (inherited) env.PATH = inherited;
  } else {
    // The PDF worker is Bun running a script: it needs neither Git's tools nor the owner's.
    const worker = kind === "pdf-worker";
    const gitRoot = worker ? null : options.gitRoot;
    env.PATH = childPath({
      source, platform,
      ...(worker ? { ownerDirs: false } : {}),
      ...(gitRoot !== undefined ? { gitRoot } : {}),
      ...(options.pathPrepend ? { prepend: options.pathPrepend } : {}),
    });
  }
  return { ...env, ...options.extra };
}
