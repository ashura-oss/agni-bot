/**
 * Owner-only files and directories, on every platform.
 *
 * POSIX mode bits do nothing on Windows, so there "private" is an ACL
 * (`util/windows-acl.ts`). These helpers put the two in one place so a caller
 * cannot set the mode and forget the ACL.
 *
 * Two policies, chosen by the caller:
 *  - fail closed (`writePrivateFile`, `secureFile`, `secureDirectory(..., "throw")`):
 *    for credentials and keys. If the file cannot be made private, nothing is
 *    written and a `PrivateFileError` says so.
 *  - warn and continue (`ensurePrivateDirectory`, `secureDirectory(..., "warn")`):
 *    for data that is not a secret. Some volumes (FAT/exFAT, SMB shares) cannot
 *    hold ACLs; refusing to save a chat attachment there would be worse than
 *    saving it with a warning.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join, win32 } from "node:path";
import { log } from "../log";
import { currentUserSid, restrictToOwnerOnWindows, restrictToOwnerOnWindowsAsync, windowsSystemTool } from "./windows-acl";

/** The path could not be made private. The message is safe to show the owner. */
export class PrivateFileError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PrivateFileError";
  }
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A file is named by its base name only: the message can reach a client. */
function cannotSecure(path: string, cause: unknown): PrivateFileError {
  return new PrivateFileError(
    `Could not restrict ${basename(path)} to your account on this computer, so nothing was saved.`,
    { cause },
  );
}

/** A directory is for the local command line, where the full path helps. */
function cannotSecureDirectory(dir: string, cause: unknown): PrivateFileError {
  return new PrivateFileError(
    `Could not restrict ${dir} to your account on this computer (${reason(cause)}). Stopping before any key is stored there.`,
    { cause },
  );
}

/**
 * Write `contents` to `path` so it is owner-only from its first byte: create an
 * empty file with mode 0600, make it owner-only (Windows ACL), only then write
 * the contents, and rename it into place. A failure leaves nothing at `path`
 * and no temporary file behind. The ACL and mode travel with the rename.
 */
export function writePrivateFileSync(path: string, contents: string | Uint8Array, temporaryPath = `${path}.${randomUUID()}.tmp`): void {
  writeFileSync(temporaryPath, "", { mode: 0o600, flag: "wx" });
  try {
    try {
      restrictToOwnerOnWindows(temporaryPath, false);
    } catch (error) {
      throw cannotSecure(path, error);
    }
    writeFileSync(temporaryPath, contents, { encoding: "utf8" });
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export async function writePrivateFile(path: string, contents: string | Uint8Array, temporaryPath = `${path}.${randomUUID()}.tmp`): Promise<void> {
  await writeFile(temporaryPath, "", { mode: 0o600, flag: "wx" });
  try {
    try {
      await restrictToOwnerOnWindowsAsync(temporaryPath, false);
    } catch (error) {
      throw cannotSecure(path, error);
    }
    await writeFile(temporaryPath, contents, { encoding: "utf8" });
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

// --- macOS and Linux: owner-only modes ---------------------------------------

/** The slice of the file system the mode checks use, so tests can inject one. */
export interface PosixFs {
  statSync(path: string): { mode: number; uid: number; isDirectory(): boolean };
  chmodSync(path: string, mode: number): void;
  /** Absent on Windows. */
  getuid?: () => number;
}

const realPosixFs: PosixFs = {
  statSync: (path) => statSync(path),
  chmodSync: (path, mode) => chmodSync(path, mode),
  getuid: typeof process.getuid === "function" ? () => process.getuid!() : undefined,
};
let posixFs: PosixFs = realPosixFs;

/** Tests only: replace the file system the mode checks use. `null` restores the real one. */
export function setPosixFsForTests(fs: PosixFs | null): void {
  posixFs = fs ?? realPosixFs;
}

const octal = (mode: number): string => (mode & 0o777).toString(8).padStart(3, "0");

/**
 * Make `path` owner-only by mode (`wanted` is 0o700 for a directory, 0o600 for
 * a file) and check the result. "ok": it already was. "fixed": it was open to
 * group or others and `chmod` closed it. Throws `PrivateFileError` when the
 * path belongs to another account, `chmod` fails, or the mode did not take
 * (a mount that ignores modes). Group and other bits are what matter; the
 * owner's own bits are left as they are.
 */
export function checkPosixPrivate(path: string, wanted: 0o700 | 0o600, fs: PosixFs = posixFs): "ok" | "fixed" {
  let info: ReturnType<PosixFs["statSync"]>;
  try {
    info = fs.statSync(path);
  } catch (error) {
    throw new PrivateFileError(`Cannot check ${path} (${reason(error)}).`, { cause: error });
  }
  const uid = fs.getuid?.();
  if (uid !== undefined && info.uid !== uid) {
    throw new PrivateFileError(`${path} belongs to another account (uid ${info.uid}), so Agni cannot make it private. Stopping before any key is stored there.`);
  }
  if ((info.mode & 0o077) === 0) return "ok";
  try {
    fs.chmodSync(path, wanted);
  } catch (error) {
    throw new PrivateFileError(`${path} is open to other accounts (mode ${octal(info.mode)}) and could not be restricted (${reason(error)}). Stopping before any key is stored there.`, { cause: error });
  }
  const after = fs.statSync(path);
  if ((after.mode & 0o077) !== 0) {
    throw new PrivateFileError(`${path} is still readable by other accounts (mode ${octal(after.mode)}) after chmod; does this volume ignore file modes? Stopping before any key is stored there.`);
  }
  return "fixed";
}

/** Files in AGNI_HOME that hold secrets or the keys to them. Checked, and closed if open, at every start on macOS and Linux. */
const HOME_SECRET_FILES = ["config.env", "providers.json", "plugins.json", "vault.bin", "vault.bin.lock"];

/**
 * At every start: make sure AGNI_HOME is readable by its owner only, fix it if
 * it is not, and throw `PrivateFileError` (the server then refuses to start)
 * if it cannot be fixed. The home folder must already exist.
 *  - Windows: the directory's ACL is exactly one entry for the current user,
 *    inheritance cut (`isOwnerOnlyDirectory`); otherwise it is set, then read back.
 *  - macOS and Linux: mode 700 on the folder, owned by the current user, and
 *    600 on the secret files in it.
 * Returns "fixed" when it had to change something.
 */
export function verifyHomePrivate(home: string, platform: NodeJS.Platform = process.platform, fs: PosixFs = posixFs): "ok" | "fixed" {
  if (platform === "win32") {
    if (isOwnerOnlyDirectory(home)) return "ok";
    secureDirectory(home, "throw");
    if (!isOwnerOnlyDirectory(home)) {
      throw cannotSecureDirectory(home, "the access rules were set but reading them back did not show an owner-only folder");
    }
    return "fixed";
  }
  let result = checkPosixPrivate(home, 0o700, fs);
  for (const name of HOME_SECRET_FILES) {
    const file = join(home, name);
    try {
      fs.statSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new PrivateFileError(`Cannot check ${file} (${reason(error)}).`, { cause: error });
    }
    if (checkPosixPrivate(file, 0o600, fs) === "fixed") result = "fixed";
  }
  return result;
}

/** Windows: owner-only ACL on an existing file. macOS and Linux: mode 600, checked. Throws `PrivateFileError`. */
export function secureFile(path: string): void {
  try {
    if (process.platform === "win32") restrictToOwnerOnWindows(path, false);
    else checkPosixPrivate(path, 0o600);
  } catch (error) {
    throw cannotSecure(path, error);
  }
}

/**
 * Windows: owner-only ACL on a directory, inherited by everything created in or
 * already under it. macOS and Linux: mode 700, checked. "throw" fails closed;
 * "warn" logs and carries on.
 */
export function secureDirectory(dir: string, onFailure: "throw" | "warn"): void {
  try {
    if (process.platform === "win32") restrictToOwnerOnWindows(dir, true);
    else checkPosixPrivate(dir, 0o700);
  } catch (error) {
    if (onFailure === "throw") throw cannotSecureDirectory(dir, error);
    log.warn(`${dir} could not be restricted to your account; continuing without it: ${reason(error)}`);
  }
}

/**
 * True when `dir` already has exactly what `secureDirectory` sets: inheritance
 * cut and a single entry granting the current user full control, inherited by
 * files and folders created later (OI, CI). Reads the directory's own ACL
 * (`icacls /save`, locale independent); it does not walk the tree. Any error
 * reading it counts as "not secured". macOS and Linux: owned by the current
 * user with no group or other access.
 */
export function isOwnerOnlyDirectory(dir: string): boolean {
  if (process.platform !== "win32") {
    try {
      const info = posixFs.statSync(dir);
      const uid = posixFs.getuid?.();
      return (uid === undefined || info.uid === uid) && (info.mode & 0o077) === 0;
    } catch {
      return false;
    }
  }
  let scratch: string | undefined;
  try {
    // A missing or unwritable temp folder is a warning, not a crash: the
    // directory then counts as "not secured" and the caller applies the ACL.
    scratch = mkdtempSync(join(tmpdir(), "agni-acl-"));
    const out = join(scratch, "acl.txt");
    execFileSync(windowsSystemTool("icacls"), [win32.resolve(dir), "/save", out, "/q"], { stdio: "pipe", windowsHide: true });
    const sddl = readFileSync(out, "utf16le").match(/^D:(.*)$/m)?.[1]?.trim() ?? "";
    const flags = sddl.slice(0, sddl.indexOf("("));
    const entries = sddl.match(/\([^)]*\)/g) ?? [];
    return flags.includes("P") && entries.length === 1 && entries[0] === `(A;OICI;FA;;;${currentUserSid()})`;
  } catch (error) {
    if (scratch === undefined) log.warn(`could not check the access rules on ${dir}: the temporary folder is not usable (${reason(error)})`);
    return false;
  } finally {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * `secureDirectory`, but only when the directory is not already owner-only, so
 * a server that restarts often does not re-walk a large home every time.
 * Returns true when it applied the ACL (or tried to), false when it was already in place.
 */
export function secureDirectoryIfNeeded(dir: string, onFailure: "throw" | "warn"): boolean {
  if (isOwnerOnlyDirectory(dir)) return false;
  secureDirectory(dir, onFailure);
  return true;
}

/** One attempt per directory per process; concurrent callers wait for the same one. */
const directoryAttempts = new Map<string, Promise<void>>();

/**
 * Create `directory` (mode 0700) and, on Windows, give it an owner-only ACL once
 * per process, before anything is written into it. Failure warns and continues.
 * A directory created again after being deleted is secured again.
 */
export async function ensurePrivateDirectory(directory: string, label: string): Promise<void> {
  const created = await mkdir(directory, { recursive: true, mode: 0o700 });
  if (created !== undefined) directoryAttempts.delete(directory);
  if (process.platform !== "win32") return;
  let attempt = directoryAttempts.get(directory);
  if (!attempt) {
    attempt = restrictToOwnerOnWindowsAsync(directory, true).catch((error: unknown) => {
      log.warn(`${label} directory ${directory} could not be restricted to your account; saving there anyway: ${reason(error)}`);
    });
    directoryAttempts.set(directory, attempt);
  }
  await attempt;
}
