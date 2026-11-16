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
import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
export function writePrivateFileSync(path: string, contents: string, temporaryPath = `${path}.${randomUUID()}.tmp`): void {
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

export async function writePrivateFile(path: string, contents: string, temporaryPath = `${path}.${randomUUID()}.tmp`): Promise<void> {
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

/** Windows: owner-only ACL on an existing file. Throws `PrivateFileError`. Elsewhere: nothing. */
export function secureFile(path: string): void {
  try {
    restrictToOwnerOnWindows(path, false);
  } catch (error) {
    throw cannotSecure(path, error);
  }
}

/**
 * Windows: owner-only ACL on a directory, inherited by everything created in or
 * already under it. "throw" fails closed; "warn" logs and carries on. Elsewhere: nothing.
 */
export function secureDirectory(dir: string, onFailure: "throw" | "warn"): void {
  try {
    restrictToOwnerOnWindows(dir, true);
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
 * reading it counts as "not secured". Non-Windows: true (nothing to do).
 */
export function isOwnerOnlyDirectory(dir: string): boolean {
  if (process.platform !== "win32") return true;
  const scratch = mkdtempSync(join(tmpdir(), "agni-acl-"));
  try {
    const out = join(scratch, "acl.txt");
    execFileSync(windowsSystemTool("icacls"), [win32.resolve(dir), "/save", out, "/q"], { stdio: "pipe", windowsHide: true });
    const sddl = readFileSync(out, "utf16le").match(/^D:(.*)$/m)?.[1]?.trim() ?? "";
    const flags = sddl.slice(0, sddl.indexOf("("));
    const entries = sddl.match(/\([^)]*\)/g) ?? [];
    return flags.includes("P") && entries.length === 1 && entries[0] === `(A;OICI;FA;;;${currentUserSid()})`;
  } catch {
    return false;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
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
