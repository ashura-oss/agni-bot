/**
 * Shell tool. Executes a command and returns stdout/stderr. Every command
 * goes through the approval broker (see agent/approval-broker.ts) unless
 * `isReadOnlyCommand` proves it is one read-only program touching only
 * scratch.
 *
 * What the child gets is chosen here, not by the model or by the server's
 * ambient state (S2-14): the working directory is scratch or a folder inside
 * it, the environment is the allowlist in `util/child-env.ts` with a fixed
 * PATH, Git Bash comes from its fixed install path, output is capped in
 * bytes, and a timeout or an abort kills the whole process tree.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { childEnv } from "../util/child-env";
import { gitBashReady, gitInstall } from "../util/git-bash";
import { privateTempDir } from "../util/private-temp";
import { TREE_SPAWN_OPTIONS, trackTree } from "../util/process-tree";
import { isOutsideScratch, resolveWritePath, scratchDir } from "./write-file";

/** Per stream (stdout and stderr each). Bytes, not characters. */
export const MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
/** After the tree kill is sent, how long to wait for the pipes to close before giving up on them. */
const KILL_SETTLE_MS = 5_000;

export interface BashArgs {
  command: string;
  timeoutMs?: number;
  /** Must be scratch or inside it. A relative path means under scratch. Anything else is refused. */
  cwd?: string;
  /** Stops the command and its whole process tree. */
  signal?: AbortSignal;
  /**
   * Internal only. `run_privileged` supplies the owner's one-time secret; the
   * model never sees or sets this field.
   */
  secret?: string;
  /** Internal only: the per-stream output cap in bytes (default `MAX_OUTPUT_BYTES`). */
  maxOutputBytes?: number;
}

export interface BashResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** True when the caller's abort signal stopped the command. */
  aborted: boolean;
  /** True when stdout or stderr hit the byte cap and was cut (it ends with a marker). */
  outputTruncated: boolean;
  durationMs: number;
}

/** A call the tool will not run, with a machine-readable reason the model can act on. */
export class BashRefusal extends Error {
  constructor(readonly code: "cwd_outside_scratch", message: string) {
    super(message);
    this.name = "BashRefusal";
  }
}

/**
 * Why `cwd` cannot be used, or null when it can. The working directory is the
 * server's choice: the model may name scratch or a folder inside it (symlinks
 * followed), nothing else. Exported so the approval check can refuse before it
 * raises a card for a call that would be refused anyway.
 */
export function bashCwdProblem(cwd: string | undefined): string | null {
  const base = scratchDir();
  const requested = (cwd ?? "").trim();
  if (requested === "" || !isOutsideScratch(requested, base)) return null;
  return `cwd ${JSON.stringify(requested)} is outside the scratch directory (${base}). Commands run in scratch: leave cwd out, or name a folder inside it.`;
}

/** The real directory the command runs in (created when it is scratch or inside it), or a `BashRefusal`. */
function resolveBashCwd(cwd: string | undefined): string {
  const problem = bashCwdProblem(cwd);
  if (problem) throw new BashRefusal("cwd_outside_scratch", problem);
  const base = scratchDir();
  const requested = (cwd ?? "").trim();
  mkdirSync(requested === "" ? base : resolve(base, requested), { recursive: true });
  return resolveWritePath(requested === "" ? base : requested) ?? base;
}

/**
 * Known-dangerous shapes, kept for warnings only. A denylist cannot gate a
 * shell (`s''udo`, `$HOME`, pipes into interpreters all slip past it); the
 * gate is `isReadOnlyCommand`.
 */
export const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*f?|[^-]\S*)\s+\/?(\*|\.\.\/?|~\/?|\/)/, // rm -rf style
  /\brm\s+(-[a-zA-Z]*f?|[^-]\S*)\s+-r/i, // rm -r
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /\bshutdown\b/, /\breboot\b/, /\bpoweroff\b/,
  /\bkill\s+-9\b/, /\bkillall\b/, /\bpkill\b/,
  /\bgit\s+push\b/, /\bgit\s+reset\s+--hard\b/, /\bgit\s+clean\b/, /\bgit\s+checkout\b/,
  /\bchmod\s+777\b/, /\bchown\b/,
  /\bcurl\b.*\|\s*(sudo|bash|sh)\b/, /\bwget\b.*\|\s*(sudo|bash|sh)\b/,
  /\bsudo\b/, /\bsu\b/,
  /\bmount\b/, /\bumount\b/,
  /\bapt(-get)?\s+(install|remove|upgrade)\b/, /\byum\s+(install|remove)\b/, /\bdnf\s+(install|remove)\b/,
  /\bnpm\s+(install|ci|audit)\b/, /\byarn\s+add\b/, /\bpip\s+install\b/,
  /\bgit\s+init\b.*\./,
];

export function isDestructive(command: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command));
}

/** Programs that only read. `env` is out: the daemon's env holds provider keys. */
const READ_ONLY_PROGRAMS = new Set(["ls", "cat", "head", "tail", "wc", "pwd", "echo", "date", "whoami", "uname", "which", "file", "stat", "du", "df"]);
/** Plain words only: no quotes, `$`, `~`, globs, redirection, pipes, or separators. */
const SAFE_WORD = /^[A-Za-z0-9._,:@%+\/-]+$/;
const SAFE_FLAG = /^--?[A-Za-z0-9-]+$/;
/** `date +FORMAT`: the word starts with "+" and then only plain characters. */
const DATE_FORMAT = /^\+[A-Za-z0-9%._,:@+\/-]*$/;

/**
 * True only for one simple command whose program is read-only and whose
 * every operand really lives in scratch (relative to `cwd`, symlinks
 * followed). Anything else needs the owner's click.
 */
export function isReadOnlyCommand(command: string, cwd?: string): boolean {
  // The same directory the command would run in: a relative cwd is under scratch.
  const dir = resolve(scratchDir(), (cwd ?? "").trim());
  if (isOutsideScratch(dir)) return false;
  const words = command.trim().split(/[ \t]+/);
  if (!READ_ONLY_PROGRAMS.has(words[0] ?? "")) return false;
  // `date` can set the clock (-s, --set) and read files (-f, -r), and other options change nothing
  // worth a free pass: only the bare command and one `+FORMAT` word are read-only.
  if (words[0] === "date") return words.length === 1 || (words.length === 2 && DATE_FORMAT.test(words[1] ?? ""));
  return words.slice(1).every((word) =>
    word.startsWith("-") ? SAFE_FLAG.test(word) : SAFE_WORD.test(word) && !isOutsideScratch(resolve(dir, word)));
}

interface SecretEnv {
  env: Record<string, string>;
  cleanup: () => void;
}


/** Where a POSIX system keeps bash. Fixed: PATH does not choose the shell. */
const POSIX_BASH_PATHS = ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash", "/opt/homebrew/bin/bash"];

function bashExecutable(): string {
  if (process.platform === "win32") {
    // The Windows system32 bash launcher requires WSL. Use the host-native
    // Git Bash so cwd, temporary files, and askpass share the host
    // filesystem. Found at the fixed install paths, never through PATH.
    return gitInstall().bash;
  }
  const bash = POSIX_BASH_PATHS.find((path) => existsSync(path));
  if (!bash) throw new Error("Shell tools need bash, and it was not found in /bin, /usr/bin or /usr/local/bin.");
  return bash;
}

function shellPath(path: string): string {
  return process.platform === "win32" ? path.replaceAll("\\", "/") : path;
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

/**
 * Build a short-lived environment that lets sudo/ssh/git read the owner's
 * password without putting it in argv or the environment. The secret lives in
 * a 0600 file inside a 0700 temp dir; the askpass helper cats it. The dir is
 * removed as soon as the child exits.
 *
 * This is not a boundary against a same-user attacker (nothing in-process is),
 * but it keeps the value out of the model, the transcript, the frame log, and
 * `ps`.
 */
function secretEnv(secret: string): SecretEnv {
  const dir = privateTempDir("agni-secret-");
  const secretPath = join(dir, "secret");
  const askpass = join(dir, "askpass.sh");
  const sudoWrapper = join(dir, "sudo");
  writeFileSync(secretPath, `${secret}\n`, { mode: 0o600 });
  writeFileSync(askpass, `#!/bin/sh\ncat ${shellQuote(shellPath(secretPath))}\n`, { mode: 0o700 });
  writeFileSync(sudoWrapper, `#!/bin/sh\nexec /usr/bin/sudo -A "$@"\n`, { mode: 0o700 });
  const env = childEnv("shell", {
    // The helper folder first (its `sudo` wrapper), then the same fixed PATH.
    pathPrepend: [dir],
    extra: {
      SUDO_ASKPASS: shellPath(askpass),
      SSH_ASKPASS: shellPath(askpass),
      SSH_ASKPASS_REQUIRE: "force",
      GIT_ASKPASS: shellPath(askpass),
    },
  });
  return {
    env,
    cleanup: () => {
      try {
        // Best effort: overwrite before unlinking, then drop the directory.
        writeFileSync(secretPath, Buffer.alloc(Math.max(secret.length, 1)), { mode: 0o600 });
      } catch {
        // The child may already have removed it; the unlink below still runs.
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Temp cleanup is best effort.
      }
    },
  };
}

function redact(text: string, secret: string): string {
  if (!secret) return text;
  const variants = new Set([
    secret,
    encodeURIComponent(secret),
    Buffer.from(secret).toString("base64"),
  ]);
  let result = text;
  for (const variant of variants) {
    if (variant) result = result.split(variant).join("[redacted]");
  }
  return result;
}

/** One stream's output, kept up to a byte cap. Bytes past the cap are read and dropped so the child never blocks on a full pipe. */
class CappedOutput {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  truncated = false;

  constructor(private readonly cap: number) {}

  push(chunk: Buffer): void {
    if (this.truncated) return;
    const room = this.cap - this.bytes;
    if (chunk.length <= room) {
      this.chunks.push(chunk);
      this.bytes += chunk.length;
      return;
    }
    if (room > 0) this.chunks.push(chunk.subarray(0, room));
    this.bytes = this.cap;
    this.truncated = true;
  }

  /** The text, with the secret redacted; a cut multi-byte character is dropped, and a marker names the cap. */
  text(secret: string): string {
    let text = Buffer.concat(this.chunks).toString("utf8");
    if (this.truncated) text = text.replace(/\u{FFFD}$/u, "");
    text = redact(text, secret).trimEnd();
    return this.truncated ? `${text}\n[output truncated at ${this.cap} bytes]` : text;
  }
}

export async function runBash(args: BashArgs): Promise<BashResult> {
  const cwd = resolveBashCwd(args.cwd);
  const timeoutMs = Math.min(args.timeoutMs ?? DEFAULT_TIMEOUT_MS, 120_000);
  const startedAt = Date.now();
  if (args.signal?.aborted) {
    return { stdout: "", stderr: "", exitCode: null, signal: null, timedOut: false, aborted: true, outputTruncated: false, durationMs: 0 };
  }
  // Windows: the permission check of a per-user Git install runs in the background, not on this command.
  if (process.platform === "win32") await gitBashReady();
  const executable = bashExecutable();
  const secret = args.secret;
  const secretSetup = secret ? secretEnv(secret) : null;
  const cap = args.maxOutputBytes ?? MAX_OUTPUT_BYTES;

  return await new Promise<BashResult>((resolvePromise) => {
    const stdout = new CappedOutput(cap);
    const stderr = new CappedOutput(cap);
    let startError = "";
    let timedOut = false;
    let aborted = false;
    let stopping = false;
    let settled = false;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(executable, ["-c", args.command], {
      cwd,
      env: secretSetup?.env ?? childEnv("shell"),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...TREE_SPAWN_OPTIONS,
    }) as unknown as ChildProcessWithoutNullStreams;
    // Right after the spawn, before the shell has started anything of its own.
    const tree = trackTree(child);

    if (secret) {
      // `sudo -S` and friends read the password from stdin; askpass covers
      // brew/ssh/git. A command that never reads stdin gets EPIPE, ignored.
      child.stdin.on("error", () => {});
      child.stdin.end(`${secret}\n`);
    } else {
      child.stdin.end();
    }

    const finish = (code: number | null, signal: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(settleTimer);
      args.signal?.removeEventListener("abort", onAbort);
      tree.release();
      secretSetup?.cleanup();
      const err = stderr.text(secret ?? "");
      resolvePromise({
        stdout: stdout.text(secret ?? ""),
        stderr: startError ? `${err}\n${startError}`.trim() : err,
        exitCode: code,
        signal,
        timedOut,
        aborted,
        outputTruncated: stdout.truncated || stderr.truncated,
        durationMs: Date.now() - startedAt,
      });
    };

    // End the command's whole process tree. This is housekeeping, not
    // containment: it stops what the command started the ordinary way
    // (background jobs, nohup, helpers) so nothing lingers after it, but a
    // process can still leave the tree on purpose (schtasks, WMI, setsid, a
    // service) until the Sprint 7 sandbox. If a process somehow keeps the
    // pipes open after the kill, stop waiting for them.
    let reaped = false;
    const reap = (): void => {
      if (settled || reaped) return;
      reaped = true;
      void tree.kill().catch(() => {});
      settleTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(null, "SIGKILL");
      }, KILL_SETTLE_MS);
    };
    const stop = (reason: "timeout" | "abort"): void => {
      if (settled || stopping) return;
      stopping = true;
      if (reason === "timeout") timedOut = true; else aborted = true;
      reap();
    };
    const onAbort = (): void => stop("abort");
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    args.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      startError = error instanceof Error ? error.message : String(error);
      // A process that never started has no pipes to wait for.
      if (child.pid === undefined) finish(null, null);
    });
    // The shell has finished: whatever it left running ends now, so a
    // background process cannot hold the output pipes open or outlive the command.
    child.on("exit", reap);
    child.on("close", (code, signal) => finish(code, signal));
  });
}
