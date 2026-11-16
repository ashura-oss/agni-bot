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
 * there either and the owner is the current user, SYSTEM or Administrators
 * (see `inspectPathAcl`); otherwise the shell refuses with a message that
 * says which of "writable", "wrong owner" or "could not check" it was, and how
 * to fix it. The check reads every folder in one PowerShell call, run in the background at server start
 * (`prepareGitBash`); the result is remembered for the process, except "could not check", which is looked at
 * again after five minutes. Same-account tampering is not a boundary
 * this check claims: a command the owner approved can already do anything the
 * account can.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, win32 } from "node:path";
import { promisify } from "node:util";
import { log } from "../log";
import { envValue, isWindowsDrivePath, type Env } from "./env-lookup";

const execFileAsync = promisify(execFile);

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

/**
 * What the check of a per-user install found:
 *  - "ok": nobody but the owner, SYSTEM and Administrators can write, and one of those owns it;
 *  - "writable": another account can change it;
 *  - "owner": an account other than those three owns it (it could rewrite the permissions);
 *  - "unverifiable": the permissions could not be read, so nothing is known.
 */
export type InstallCheck = "ok" | "writable" | "owner" | "unverifiable";

export interface FindGitBashOptions {
  env?: Env;
  exists?: (path: string) => boolean;
  /** Checks a per-user install. Defaults to the ACL check, remembered for the process. */
  userInstallCheck?: (root: string, bash: string) => InstallCheck;
}

/** The chosen Git Bash, or a `GitBashError` whose message says what to do. */
export function findGitBash(options: FindGitBashOptions = {}): GitInstall {
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const check = options.userInstallCheck ?? defaultUserInstallCheck;
  const refused: Array<{ root: string; why: Exclude<InstallCheck, "ok"> }> = [];
  for (const { root, scope } of gitInstallCandidates(env)) {
    const bash = [win32.join(root, "bin", "bash.exe"), win32.join(root, "usr", "bin", "bash.exe")].find((path) => exists(path));
    if (!bash) continue;
    if (scope === "user") {
      const result = check(root, bash);
      if (result !== "ok") {
        refused.push({ root, why: result });
        continue;
      }
    }
    return { root, bash, scope };
  }
  const first = refused[0];
  if (first) {
    const fix = "Reinstall Git for Windows for all users (it installs under C:\\Program Files\\Git) and restart Agni.";
    const reason = {
      writable: "other accounts can change files there, so Agni will not run commands with it.",
      owner: "it is owned by another account, so Agni will not run commands with it.",
      unverifiable: "Agni could not check who can change files there (reading its permissions failed), so it will not run commands with it.",
    }[first.why];
    throw new GitBashError(`Git Bash was found in ${first.root}, but ${reason} ${fix}`);
  }
  throw new GitBashError("Shell tools on Windows require Git Bash. Install Git for Windows (for all users) and restart Agni.");
}

let cached: GitInstall | null = null;
let warming: Promise<void> | null = null;
/** Bumped by a reset, so a background check that finishes after it does not write into the new state. */
let generation = 0;

/** `findGitBash` for the real machine, remembered once it succeeds. A missing Git is looked up again next time. */
export function gitInstall(): GitInstall {
  if (cached) return cached;
  cached = findGitBash();
  return cached;
}

/** For tests. */
export function resetGitInstallCache(): void {
  cached = null;
  warming = null;
  generation++;
  checkResults.clear();
}

/** How long a "could not check" answer is believed. After this it is checked again (a hiccup is not a verdict). */
export const UNVERIFIABLE_RECHECK_MS = 5 * 60_000;

interface Remembered { result: InstallCheck; at: number }
const checkResults = new Map<string, Remembered>();

function recall(root: string, now: number): InstallCheck | undefined {
  const known = checkResults.get(root.toLowerCase());
  if (!known) return undefined;
  return known.result === "unverifiable" && now - known.at >= UNVERIFIABLE_RECHECK_MS ? undefined : known.result;
}

function remember(root: string, result: InstallCheck, now: number): void {
  checkResults.set(root.toLowerCase(), { result, at: now });
}

/**
 * The result of checking a per-user install, remembered for the process: the check starts PowerShell, and
 * the shell tool asks on every command. A definite answer (ok, writable, wrong owner) is kept; a "could not
 * check" answer is kept for five minutes and then checked again, so one failed start of PowerShell does not
 * shut the shell off until the next restart. A reinstall needs a restart.
 */
export function cachedUserInstallCheck(root: string, inspect: () => InstallCheck, now: number = Date.now()): InstallCheck {
  const known = recall(root, now);
  if (known) return known;
  const result = inspect();
  remember(root, result, now);
  return result;
}

/** What the check of a per-user install looks at: the folder, its program folders and the shell itself. */
function userInstallPlaces(root: string, bash: string, exists: (path: string) => boolean): string[] {
  return [...new Set([root, win32.join(root, "bin"), win32.join(root, "usr", "bin"), dirname(bash), bash])].filter((path) => exists(path));
}

/** The worst finding wins: writable, then could-not-check, then wrong owner. */
const FINDING_RANK: Record<InstallCheck, number> = { ok: 0, owner: 1, unverifiable: 2, writable: 3 };

function worstOf(results: Iterable<InstallCheck>): InstallCheck {
  let worst: InstallCheck = "ok";
  for (const result of results) if (FINDING_RANK[result] > FINDING_RANK[worst]) worst = result;
  return worst;
}

export interface UserInstallOptions {
  exists?: (path: string) => boolean;
  /** For tests: stands in for the PowerShell call. */
  run?: (request: AclRequest) => string;
}

/** Check a per-user install now: every folder in one PowerShell call. */
export function inspectUserInstall(root: string, bash: string, options: UserInstallOptions = {}): InstallCheck {
  const places = userInstallPlaces(root, bash, options.exists ?? existsSync);
  if (places.length === 0) return "unverifiable";
  return worstOf(inspectPathsAcl(places, options.run ? { run: options.run } : {}).values());
}

function defaultUserInstallCheck(root: string, bash: string): InstallCheck {
  return cachedUserInstallCheck(root, () => inspectUserInstall(root, bash));
}

export interface PrepareGitBashOptions {
  env?: Env;
  exists?: (path: string) => boolean;
  /** For tests: stands in for the PowerShell call. */
  run?: (request: AclRequest) => Promise<string>;
}

/**
 * Find Git Bash and check any per-user install now, without blocking: the permissions of every folder of every
 * per-user install are read in one PowerShell call, run in the background. Called at server start, so the first
 * shell command finds the answer ready. A finding that is a refusal is remembered too (and rethrown, with its
 * message, by the first `gitInstall()`); nothing here throws.
 */
export async function prepareGitBash(options: PrepareGitBashOptions = {}): Promise<void> {
  if (cached) return;
  const started = generation;
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const wanted: Array<{ root: string; places: string[] }> = [];
  for (const { root, scope } of gitInstallCandidates(env)) {
    if (scope !== "user" || recall(root, Date.now())) continue;
    const bash = [win32.join(root, "bin", "bash.exe"), win32.join(root, "usr", "bin", "bash.exe")].find((path) => exists(path));
    if (bash) wanted.push({ root, places: userInstallPlaces(root, bash, exists) });
  }
  if (wanted.length > 0) {
    const places = [...new Set(wanted.flatMap((entry) => entry.places))];
    const found = await inspectPathsAclAsync(places, options.run ? { run: options.run } : {});
    if (started !== generation) return;
    const now = Date.now();
    for (const { root, places: own } of wanted) remember(root, own.length === 0 ? "unverifiable" : worstOf(own.map((place) => found.get(place) ?? "unverifiable")), now);
  }
  try {
    const install = findGitBash({ env, exists });
    if (started === generation) cached = install;
  } catch {
    // Git Bash is missing or refused: the first command that needs it says why, from the remembered findings.
  }
}

/**
 * Resolves once the background check has run (starting it when nothing has). A shell command waits for this
 * before it looks for Git Bash, so the permission check never blocks the event loop on the first command.
 * Never rejects.
 */
export function gitBashReady(): Promise<void> {
  if (cached) return Promise.resolve();
  if (warming) return warming;
  const running: Promise<void> = prepareGitBash()
    .catch((error) => {
      log.warn(`git bash check failed: ${error instanceof Error ? error.message : String(error)}`);
    })
    .finally(() => {
      // Once it has run, the next command asks again: a finding that has gone stale is looked at anew.
      if (warming === running) warming = null;
    });
  warming = running;
  return running;
}

/** Whether a path's owner may be trusted: the current user, SYSTEM, Administrators, or a service account (TrustedInstaller). */
export function ownerSidTrusted(ownerSid: string, currentSid: string): boolean {
  const sid = ownerSid.trim();
  if (sid === "") return false;
  return sid === currentSid || TRUSTED_TRUSTEES.has(sid) || sid.startsWith(SERVICE_SID_PREFIX);
}

/** A request to run Windows PowerShell, by absolute path, with the small environment it needs. */
export interface AclRequest {
  file: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Reads the owner and the access list of every path in `$env:AGNI_ACL_PATHS` (separated by `|`, which a Windows
 * path cannot contain) and the account running it, one JSON object per line: `{idx, me, owner, dacl}`, or
 * `{idx, me, error}` for a path that could not be read. Paths are answered by their position, so a name that
 * the console would mangle is never echoed.
 */
const ACL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
  "$paths = $env:AGNI_ACL_PATHS -split '\\|'",
  "for ($i = 0; $i -lt $paths.Length; $i++) {",
  "  try {",
  "    $acl = Get-Acl -LiteralPath $paths[$i]",
  "    $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value",
  "    $dacl = $acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access)",
  "    ConvertTo-Json -Compress -InputObject @{ idx = $i; me = $me; owner = $owner; dacl = $dacl }",
  "  } catch {",
  "    ConvertTo-Json -Compress -InputObject @{ idx = $i; me = $me; error = $_.Exception.Message }",
  "  }",
  "}",
].join("\n");

/** The one PowerShell call that reads the permissions of all `paths`. Throws when it cannot be built. */
export function aclRequest(paths: string[]): AclRequest {
  const root = [envValue(process.env, "SystemRoot"), envValue(process.env, "windir")].find(isWindowsDrivePath);
  if (!root) throw new Error("SystemRoot is not set");
  return {
    file: win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoProfile", "-NonInteractive", "-Command", ACL_SCRIPT],
    env: {
      SystemRoot: root, windir: root, AGNI_ACL_PATHS: paths.map((path) => win32.resolve(path)).join("|"),
      ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}), ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
    },
  };
}

/** What PowerShell reported for each path. A path it did not report, or a report that cannot be read, is "unverifiable". */
export function parseAclReport(output: string, paths: string[], currentSid?: string): Map<string, InstallCheck> {
  const result = new Map<string, InstallCheck>(paths.map((path) => [path, "unverifiable"]));
  for (const text of output.split(/\r?\n/)) {
    let record: { idx?: unknown; me?: unknown; owner?: unknown; dacl?: unknown; error?: unknown };
    try {
      record = JSON.parse(text.trim()) as typeof record;
    } catch {
      continue;
    }
    if (typeof record.idx !== "number" || !Number.isInteger(record.idx)) continue;
    const path = paths[record.idx];
    if (path === undefined) continue;
    const me = currentSid || (typeof record.me === "string" ? record.me.trim() : "");
    // Without the account's own SID nothing can be called the owner's, so nothing is trusted.
    if (typeof record.owner !== "string" || typeof record.dacl !== "string" || record.error !== undefined || !/^S-1-\d+(?:-\d+)+$/.test(me)) continue;
    if (sddlWritableByOthers(record.dacl, me)) result.set(path, "writable");
    else result.set(path, ownerSidTrusted(record.owner, me) ? "ok" : "owner");
  }
  return result;
}

const ACL_TIMEOUT_MS = 30_000;

function nothingKnown(paths: string[]): Map<string, InstallCheck> {
  return new Map<string, InstallCheck>(paths.map((path) => [path, "unverifiable"]));
}

/** The permissions of `paths`, in one PowerShell call and nothing else. A failure leaves every path "unverifiable". */
export function inspectPathsAcl(paths: string[], options: { currentSid?: string; run?: (request: AclRequest) => string } = {}): Map<string, InstallCheck> {
  if (paths.length === 0) return new Map();
  if (process.platform !== "win32" && !options.run) return nothingKnown(paths);
  try {
    const request = aclRequest(paths);
    const output = options.run
      ? options.run(request)
      : execFileSync(request.file, request.args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: ACL_TIMEOUT_MS, env: request.env });
    return parseAclReport(output, paths, options.currentSid);
  } catch {
    return nothingKnown(paths);
  }
}

/** `inspectPathsAcl` that does not hold up the event loop: the same one PowerShell call, run in the background. */
export async function inspectPathsAclAsync(paths: string[], options: { currentSid?: string; run?: (request: AclRequest) => Promise<string> } = {}): Promise<Map<string, InstallCheck>> {
  if (paths.length === 0) return new Map();
  if (process.platform !== "win32" && !options.run) return nothingKnown(paths);
  try {
    const request = aclRequest(paths);
    const output = options.run
      ? await options.run(request)
      : (await execFileAsync(request.file, request.args, { encoding: "utf8", windowsHide: true, timeout: ACL_TIMEOUT_MS, env: request.env })).stdout;
    return parseAclReport(output, paths, options.currentSid);
  } catch {
    return nothingKnown(paths);
  }
}

/** Looks at the permissions and the owner of `path` (not cached). A failure to read either is "unverifiable". */
export function inspectPathAcl(path: string): InstallCheck {
  return inspectPathsAcl([path]).get(path) ?? "unverifiable";
}

/** True when `inspectPathAcl` says "ok". */
export function isOwnerSystemOnly(path: string): boolean {
  return inspectPathAcl(path) === "ok";
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
