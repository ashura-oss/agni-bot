/**
 * File write tool. Writes content to any path, creating parent directories as
 * needed. There is no enforced sandbox here — the guard is policy, not
 * mechanism: `ApprovalBroker.requiresApproval` routes writes *outside* the
 * scratch tree through the approval card, and lets scratch writes run free
 * unless they would overwrite a file that already exists (AGENTS.md).
 * `isOutsideScratch` is the boundary check both sides share, and
 * `resolveWritePath` is the one answer to "which file does this path mean":
 * relative paths are relative to scratch, symlinks are followed.
 */
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { homePath } from "../home";

const MAX_BYTES = 1024 * 1024;

/** Windows (and default macOS) file systems ignore case; paths compare folded. */
const CASE_INSENSITIVE = process.platform === "win32";

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

/**
 * The real path `path` names: symlinks are followed through its nearest
 * existing ancestor, and the missing tail is appended. Null for a dangling
 * symlink, whose real target cannot be known. A relative path resolves
 * against `base`.
 */
function realTarget(path: string, base: string): string | null {
  let target = resolve(base, path);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(target), ...tail.reverse());
    } catch {
      try { lstatSync(target); return null; } catch { /* missing: walk up */ }
    }
    const parent = dirname(target);
    if (parent === target) return join(target, ...tail.reverse());
    tail.push(basename(target));
    target = parent;
  }
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
  const target = realTarget(path, base);
  const scratch = realTarget(scratchDir(), base);
  if (!target || !scratch) return true;
  return !isInsidePath(scratch, target);
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

export function writeFile(args: WriteFileArgs): WriteFileResult {
  if (args.content.length > MAX_BYTES) throw new Error("content exceeds 1 MB");
  const target = resolveWritePath(args.path);
  if (!target) throw new Error(`${args.path} is a dangling link and cannot be written`);
  const created = !writeTargetExists(args.path);
  mkdirSync(dirname(target), { recursive: true });
  if (args.append) {
    const existing = created ? "" : readFileSync(target, "utf8");
    writeFileSync(target, existing + args.content, { flag: "w" });
  } else {
    writeFileSync(target, args.content, { flag: "w" });
  }
  return { path: target, bytesWritten: args.content.length, created };
}
