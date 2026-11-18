/**
 * File write tool. Writes content to any path, creating parent directories as
 * needed. There is no enforced sandbox here — the guard is policy, not
 * mechanism: the policy engine (`policy/engine.ts`, which reads this tool's
 * row in `policy/metadata.ts`: `assessWrite`) routes writes *outside* the
 * scratch tree through the approval card, and lets scratch writes run free
 * unless they would overwrite or append to a file that already exists
 * (AGENTS.md). `isOutsideScratch` is the boundary check both sides share, and
 * `resolveWritePath` is the one answer to "which file does this path mean":
 * relative paths are relative to scratch, symlinks are followed.
 */
import { appendFileSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { homePath } from "../home";
import { foldKey, namesRemoteOrDevice, realPathOf } from "../policy/path-key";

const MAX_BYTES = 1024 * 1024;

/**
 * Windows file systems ignore case, so paths compare folded there. macOS's
 * default file system does too, but it is left case-sensitive here: a path
 * that differs only in case then counts as outside scratch (it asks) and as
 * a different rule target (it asks again), which is the safe direction.
 */
const CASE_INSENSITIVE = process.platform === "win32";
/** The platform whose case folding `foldKey` applies here: Windows folds, macOS stays case-sensitive (see above). */
const FOLD_AS: NodeJS.Platform = CASE_INSENSITIVE ? "win32" : "linux";

/**
 * The tree the owner has declared safe for ungated writes. Defaults to
 * `~/.agni/scratch`; `AGNI_SCRATCH_DIR` overrides it (bb-1 keeps scratch on a
 * separate volume). An absolute `AGNI_SCRATCH_DIR` is used as given.
 */
export function scratchDir(): string {
  const configured = process.env.AGNI_SCRATCH_DIR;
  return resolve(configured && configured.length > 0 ? configured : homePath("scratch"));
}

/** True when `child` is `parent` or lies under it. A shared name prefix is not containment. */
export function isInsidePath(parent: string, child: string, caseInsensitive = CASE_INSENSITIVE, separator = sep): boolean {
  const fold = (path: string): string => (caseInsensitive ? path.toLowerCase() : path);
  const base = fold(parent);
  const target = fold(child);
  return target === base || target.startsWith(base.endsWith(separator) ? base : base + separator);
}

/** Is there a dangling link in `target`, or in the nearest part of it that exists? Its real target cannot be known. */
function hasDanglingLink(target: string): boolean {
  for (let current = target; ; current = dirname(current)) {
    try {
      realpathSync.native(current);
      return false;
    } catch {
      try { lstatSync(current); return true; } catch { /* missing: walk up */ }
    }
    if (dirname(current) === current) return false;
  }
}

/**
 * Does `path` name an NTFS alternate data stream (`notes.txt:hidden`)? A stream does not show in a listing and `writeTargetExists`
 * does not see it, so a write to one would put text in a file the owner is never shown, with no card for "overwrite". On Windows a
 * colon belongs only right after the drive letter (`C:`) or in the `\\?\` and `\\.\` prefixes; on another system it is an ordinary character.
 */
export function namesStream(path: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "win32") return false;
  return path.replace(/^\\\\[?.]\\/, "").replace(/^[a-zA-Z]:/, "").includes(":");
}

/**
 * The real path `path` names, in the spelling on disk: the one walk a refusal's key uses (policy/path-key.ts `realPathOf`:
 * symlinks, junctions, 8.3 short names and the on-disk case all end at one spelling, the missing tail appended). Null for a
 * dangling symlink. A relative path resolves against `base`.
 */
function realTarget(path: string, base: string): string | null {
  const target = resolve(base, path);
  if (namesRemoteOrDevice(target)) return null;
  if (namesStream(target)) return null;
  return hasDanglingLink(target) ? null : realPathOf(target);
}

/**
 * The absolute real path the file tools mean by `path`: a relative path is
 * relative to the scratch directory (never the server's working directory),
 * and symlinks are followed. Null for a dangling symlink. `write_file`, the
 * approval check, and the "always allow" rule target all use this one answer.
 */
export function resolveWritePath(path: string): string | null {
  return realTarget(path, scratchDir());
}

/**
 * True when `path` really lives outside the scratch tree (symlinks followed).
 * A relative `path` resolves against `base`. The file tools pass the scratch
 * directory; the default, the process cwd, is for a caller that hands the
 * path to the operating system (the shell's `cwd`), which resolves it there.
 */
export function isOutsideScratch(path: string, base: string = process.cwd()): boolean {
  if (path.trim().length === 0) return true;
  if (namesRemoteOrDevice(resolve(base, path))) return true;
  const target = realTarget(path, base);
  const scratch = realTarget(scratchDir(), base);
  if (!target || !scratch) return true;
  // Both sides are real paths folded the way a refusal's key folds them (policy/path-key.ts), then compared as they are.
  return !isInsidePath(foldKey(scratch, FOLD_AS), foldKey(target, FOLD_AS), false);
}

/** The real path of `path` (relative to scratch), or a throw when it escapes the scratch tree. */
export function confineToScratch(path: string): string {
  if (isOutsideScratch(path, scratchDir())) throw new Error(`${path} is outside the scratch directory`);
  return resolveWritePath(path)!;
}

/** True when a write to `path` would replace something already there. A dangling link counts. */
export function writeTargetExists(path: string): boolean {
  const target = resolveWritePath(path);
  if (!target) return true;
  try { lstatSync(target); return true; } catch { return false; }
}

export interface WriteFileArgs {
  path: string;
  content: string;
  append?: boolean;
}

export interface WriteFileResult {
  path: string;
  bytesWritten: number;
  created: boolean;
}

/**
 * Write `content` to a file that did not exist a moment ago. The file is
 * created exclusively, so one that appeared since the check (and so was never
 * shown to the owner) is not silently replaced; appending never replaces.
 */
export function createExclusive(target: string, content: string, append: boolean): void {
  try {
    writeFileSync(target, content, { flag: append ? "a" : "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${target} already exists; it was not overwritten`);
    throw error;
  }
}

export function writeFile(args: WriteFileArgs, options: { allowOutsideScratch?: boolean } = {}): WriteFileResult {
  if (args.content.length > MAX_BYTES) throw new Error("content exceeds 1 MB");
  if (namesStream(resolve(scratchDir(), args.path))) throw new Error(`${args.path} names a hidden stream of a file (a colon after the drive); write_file writes files only`);
  // Defence in depth (C1): whatever the gate made of the call, a write leaves scratch only on the owner's yes to it.
  if (!options.allowOutsideScratch && isOutsideScratch(args.path, scratchDir())) {
    throw new Error(`${args.path} is outside the sandbox; writing there needs the owner's yes`);
  }
  const target = resolveWritePath(args.path);
  if (!target) throw new Error(`${args.path} is a dangling link and cannot be written`);
  const created = !writeTargetExists(args.path);
  mkdirSync(dirname(target), { recursive: true });
  if (created) createExclusive(target, args.content, args.append === true);
  // The file exists: appending adds to the end and leaves what is there as it was.
  else if (args.append) appendFileSync(target, args.content);
  else writeFileSync(target, args.content, { flag: "w" });
  return { path: target, bytesWritten: args.content.length, created };
}
