/**
 * Where Git Bash is, on Windows. The shell tools run commands through it, so
 * whichever `bash.exe` is chosen runs with the owner's rights.
 *
 * It is never found through PATH (`Bun.which("git")` made whatever came first
 * on PATH the shell). The fixed locations are, in order: `%ProgramW6432%\Git`,
 * `%ProgramFiles%\Git`, `%ProgramFiles(x86)%\Git` (installed for all users,
 * which only administrators can write), then `%LOCALAPPDATA%\Programs\Git`
 * (installed for one user). The per-user install is a folder the user's own
 * account can rewrite, so it is used only when no other account can write
 * there either (see `isOwnerSystemOnly`); otherwise the shell refuses with a
 * message that says how to fix it. Same-account tampering is not a boundary
 * this check claims: a command the owner approved can already do anything the
 * account can.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { envValue, isWindowsDrivePath, type Env } from "./env-lookup";
import { currentUserSid, windowsSystemTool } from "./windows-acl";

export interface GitInstall {
  /** The Git for Windows root, for example `C:\Program Files\Git`. */
  root: string;
  bash: string;
  scope: "machine" | "user";
}

export class GitBashError extends Error {}

export interface GitInstallCandidate {
  root: string;
  scope: GitInstall["scope"];
}

/** The fixed install roots to try, in order. PATH is never read. */
export function gitInstallCandidates(env: Env = process.env): GitInstallCandidate[] {
  const raw: Array<{ base: string | undefined; scope: GitInstall["scope"]; sub: string[] }> = [
    { base: envValue(env, "ProgramW6432"), scope: "machine", sub: ["Git"] },
    { base: envValue(env, "ProgramFiles"), scope: "machine", sub: ["Git"] },
    { base: envValue(env, "ProgramFiles(x86)"), scope: "machine", sub: ["Git"] },
    { base: envValue(env, "LOCALAPPDATA"), scope: "user", sub: ["Programs", "Git"] },
  ];
  const seen = new Set<string>();
  const result: GitInstallCandidate[] = [];
  for (const { base, scope, sub } of raw) {
    if (!isWindowsDrivePath(base)) continue;
    const root = win32.join(base, ...sub);
    const key = root.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ root, scope });
  }
  return result;
}

export interface FindGitBashOptions {
  env?: Env;
  exists?: (path: string) => boolean;
  /** Decides whether a per-user install may be used. Defaults to the ACL check. */
  userInstallTrusted?: (root: string, bash: string) => boolean;
}

/** The chosen Git Bash, or a `GitBashError` whose message says what to do. */
export function findGitBash(options: FindGitBashOptions = {}): GitInstall {
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const trusted = options.userInstallTrusted ?? defaultUserInstallTrusted;
  const refused: string[] = [];
  for (const { root, scope } of gitInstallCandidates(env)) {
    const bash = [win32.join(root, "bin", "bash.exe"), win32.join(root, "usr", "bin", "bash.exe")].find((path) => exists(path));
    if (!bash) continue;
    if (scope === "user" && !trusted(root, bash)) {
      refused.push(root);
      continue;
    }
    return { root, bash, scope };
  }
  if (refused.length > 0) {
    throw new GitBashError(
      `Git Bash was found in ${refused[0]}, but other accounts can change files there, so Agni will not run commands with it. ` +
      "Reinstall Git for Windows for all users (it installs under C:\\Program Files\\Git) and restart Agni.",
    );
  }
  throw new GitBashError("Shell tools on Windows require Git Bash. Install Git for Windows (for all users) and restart Agni.");
}

let cached: GitInstall | null = null;

/** `findGitBash` for the real machine, remembered once it succeeds. A failure is looked up again next time. */
export function gitInstall(): GitInstall {
  if (cached) return cached;
  cached = findGitBash();
  return cached;
}

/** For tests. */
export function resetGitInstallCache(): void {
  cached = null;
}

function defaultUserInstallTrusted(root: string, bash: string): boolean {
  const places = new Set([root, win32.join(root, "bin"), win32.join(root, "usr", "bin"), dirname(bash), bash]);
  return [...places].filter((path) => existsSync(path)).every(isOwnerSystemOnly);
}

/** True when no account other than the current user, SYSTEM and Administrators can write to `path`. Any error counts as false. */
export function isOwnerSystemOnly(path: string): boolean {
  if (process.platform !== "win32") return false;
  let scratch: string | undefined;
  try {
    scratch = mkdtempSync(join(tmpdir(), "agni-git-acl-"));
    const out = join(scratch, "acl.txt");
    execFileSync(windowsSystemTool("icacls"), [win32.resolve(path), "/save", out, "/q"], { stdio: "pipe", windowsHide: true });
    return !sddlWritableByOthers(readFileSync(out, "utf16le"), currentUserSid());
  } catch {
    return false;
  } finally {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  }
}

/** Trustees that may hold write access: the owner is passed in; the rest are well-known and administrator-controlled. */
const TRUSTED_TRUSTEES = new Set(["SY", "BA", "CO", "OW", "S-1-5-18", "S-1-5-32-544", "S-1-3-0", "S-1-3-4"]);
const SERVICE_SID_PREFIX = "S-1-5-80-"; // NT SERVICE\* (TrustedInstaller)

/** What a right adds up to, for the rights icacls writes: hex masks and a few named ones. Null when a name is not known. */
const NAMED_RIGHTS: Record<string, number> = {
  GA: 0x10000000, GR: 0x80000000, GW: 0x40000000, GX: 0x20000000,
  FA: 0x1f01ff, FR: 0x120089, FW: 0x100116, FX: 0x1200a0,
  RC: 0x20000, SD: 0x10000, WD: 0x40000, WO: 0x80000,
};
/** Write data, append, write extended attributes, delete child, write attributes, delete, change permissions, take ownership, generic write and all. */
const WRITE_BITS = 0x2 | 0x4 | 0x10 | 0x40 | 0x100 | 0x10000 | 0x40000 | 0x80000 | 0x40000000 | 0x10000000;

function rightsMask(rights: string): number | null {
  if (/^0x[0-9a-f]+$/i.test(rights)) return Number.parseInt(rights.slice(2), 16);
  if (rights === "" || rights.length % 2 !== 0) return rights === "" ? 0 : null;
  let mask = 0;
  for (let index = 0; index < rights.length; index += 2) {
    const named = NAMED_RIGHTS[rights.slice(index, index + 2)];
    if (named === undefined) return null;
    mask |= named;
  }
  return mask;
}

/**
 * True when the SDDL's DACL lets a trustee other than the owner, SYSTEM,
 * Administrators, TrustedInstaller or a service account change the object
 * (write, append, delete, change permissions, take ownership). Deny entries
 * and read-only grants never count. Fails closed: no DACL (everyone has full
 * access), a malformed entry or an unknown right all count as writable.
 */
export function sddlWritableByOthers(sddl: string, ownerSid: string): boolean {
  const start = sddl.indexOf("D:");
  if (start === -1) return true;
  let depth = 0;
  let end = sddl.length;
  for (let index = start + 2; index < sddl.length; index++) {
    const char = sddl[index];
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (depth === 0 && char === "S" && sddl[index + 1] === ":") { end = index; break; }
  }
  const aces = sddl.slice(start + 2, end).match(/\([^)]*\)/g) ?? [];
  for (const ace of aces) {
    const fields = ace.slice(1, -1).split(";");
    if (fields.length < 6) return true;
    const type = fields[0] ?? "";
    if (type === "D" || type === "OD" || type === "XD" || type === "ZD") continue;
    if (type !== "A" && type !== "OA" && type !== "XA" && type !== "ZA") return true;
    const trustee = (fields[5] ?? "").trim();
    if (trustee === ownerSid || TRUSTED_TRUSTEES.has(trustee) || trustee.startsWith(SERVICE_SID_PREFIX)) continue;
    const mask = rightsMask(fields[2] ?? "");
    if (mask === null || (mask & WRITE_BITS) !== 0) return true;
  }
  return false;
}
