/**
 * The one key a file is known by in a refusal (S2-07).
 *
 * A refusal is recorded under a key and later calls are matched against keys of the same kind, so the two
 * must come from the same function or a spelling the recorder did not fold would slip past the matcher.
 * The key is the REAL path: `realpathSync.native` of the path, or of its longest part that exists with the
 * missing tail kept, so a link, a junction, an 8.3 short name or a different case on disk all end at one
 * spelling. Case is then folded where the file system folds it (Windows and macOS).
 *
 * Folding on a case-sensitive macOS volume only makes two names one, which refuses more, never less.
 */
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve, win32 } from "node:path";

const FOLDS_CASE: ReadonlySet<NodeJS.Platform> = new Set(["win32", "darwin"]);

/** `path` with its case folded where the file system on `platform` folds it. */
export function foldKey(path: string, platform: NodeJS.Platform = process.platform): string {
  return FOLDS_CASE.has(platform) ? path.toLowerCase() : path;
}

/**
 * On Windows, a path that resolves to two slashes at its start names another computer or a device namespace (`\\host\share`,
 * `//host/share`, `\\?\UNC\host`, `\\.\pipe`, `\\?\GLOBALROOT`). Asking the file system about one makes Windows look the host
 * up and open SMB to it with the owner's credentials, before any card (HF-1). Such a path is never touched: callers treat it as
 * outside scratch, with no real path. Pure: no file-system call.
 */
export function namesRemoteOrDevice(path: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "win32") return false;
  const resolved = win32.resolve(path);
  return resolved.startsWith("\\\\") || resolved.startsWith("//");
}

/**
 * The one key every network and device path has (HF-1 review). Each is refused at the gate, so a "no" to one spelling is a
 * "no" to all of them: `\\host\x`, `\\?\UNC\host\x` and `//HOST./x` must not be three different refusals.
 */
export const REMOTE_PATH_KEY = "<remote>";

/** `\\?\C:\x` (or `//?/C:/x`) as the plain local path `C:\x` it names, on Windows; anything else unchanged. Pure. */
export function withoutLongPrefix(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return path;
  const match = /^[\\/][\\/]\?[\\/]([A-Za-z]:(?:[\\/][\s\S]*)?)$/.exec(path);
  return match ? (match[1] as string) : path;
}

/** The real path of an absolute `path`: its longest existing part followed through links, then the missing tail. */
export function realPathOf(path: string): string {
  if (namesRemoteOrDevice(path)) return path;
  let target = path;
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(target), ...[...tail].reverse());
    } catch {
      const parent = dirname(target);
      if (parent === target) return join(target, ...[...tail].reverse());
      tail.push(basename(target));
      target = parent;
    }
  }
}

/** The key for `raw`, a relative path being under `base`. The one function that records and matches a path refusal. */
export function canonicalPathKey(raw: string, base: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = withoutLongPrefix(resolve(base, raw), platform);
  // A network or device path is never touched (HF-1), and every one has the same key: fail closed across spellings.
  if (namesRemoteOrDevice(resolved, platform)) return REMOTE_PATH_KEY;
  return foldKey(realPathOf(resolved), platform);
}
