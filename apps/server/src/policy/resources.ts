/**
 * What a call touches, read from its arguments: files, recipients, hosts.
 * The engine uses these for denials ("the owner said no to this file"), for
 * the egress binding ("this address is not one the owner named") and for the
 * audit trail. Nothing here runs a model or the network; it is string work
 * plus a few `realpath` calls, so it stays well under a millisecond.
 */
import { basename, dirname, resolve, sep } from "node:path";
import { homedir } from "node:os";
import type { Operation } from "./types";
import type { ToolResource } from "./tool-meta";
import { resolveWritePath, scratchDir } from "../tools/write-file";
import { chainOf, scanShell } from "./shell-scan";

const CASE_INSENSITIVE = process.platform === "win32";

/** A path as a comparison key: absolute, with `/` or `\` normalised and case folded where the file system folds it. */
export function foldPath(path: string): string {
  const normal = resolve(path);
  return CASE_INSENSITIVE ? normal.toLowerCase() : normal;
}

/** The real path a file tool means by `raw` (relative paths are under scratch, links followed), as a comparison key. */
export function pathKey(raw: string): string {
  const real = resolveWritePath(raw);
  return foldPath(real ?? resolve(scratchDir(), raw));
}

export function pathResource(raw: string): ToolResource {
  return { kind: "path", value: pathKey(raw) };
}

function asStrings(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
  return [];
}

/** Argument names that hold the people a call reaches. */
const RECIPIENT_KEYS = ["to", "cc", "bcc", "attendees", "recipients", "emails", "invitees", "guests", "participants"] as const;

/** Everyone a call reaches, lower-cased and de-duplicated. */
export function recipientsOf(args: Record<string, unknown>): string[] {
  const all = RECIPIENT_KEYS.flatMap((key) => asStrings(args[key]).map(normaliseAddress));
  return [...new Set(all)];
}

/** An address as a key: trimmed, `Name <a@b.c>` reduced to `a@b.c`, lower-cased. */
export function normaliseAddress(raw: string): string {
  const angle = /<([^<>]+)>/.exec(raw);
  return (angle?.[1] ?? raw).trim().toLowerCase();
}

export function recipientResources(args: Record<string, unknown>): ToolResource[] {
  return recipientsOf(args).map((value) => ({ kind: "recipient" as const, value }));
}

/** The host a URL points at, lower-cased and without a trailing dot, or null when it is not a URL. */
export function hostOf(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.hostname.toLowerCase().replace(/\.$/, "") || null;
  } catch {
    return null;
  }
}

export function hostResource(raw: unknown): ToolResource[] {
  if (typeof raw !== "string") return [];
  const host = hostOf(raw);
  return host ? [{ kind: "host", value: host }] : [];
}

// ---------------------------------------------------------------------------
// Shell commands
// ---------------------------------------------------------------------------

const DELETE_PROGRAMS = new Set(["rm", "rmdir", "unlink", "del", "erase", "shred", "trash", "rd"]);
const CHANGE_PROGRAMS = new Set(["mv", "move", "ren", "rename", "cp", "copy", "tee", "dd", "truncate", "touch", "chmod", "chown", "sed", "ln", "install", "rsync"]);

/** The folder a shell command runs in: scratch, or a folder inside it (a relative `cwd` is under scratch, as `isReadOnlyCommand` and the shell tool read it). */
export function shellWorkingDir(cwd: string | undefined): string {
  return resolve(scratchDir(), (cwd ?? "").trim());
}

/** Split a shell line into command segments, each a list of words (program first). Quotes are removed. */
export function shellSegments(command: string): string[][] {
  return scanShell(command).segments.map((segment) => [...(segment.program === null ? [] : [segment.program]), ...segment.args]);
}

/** Split a shell line into words: quotes are removed, separators and redirections split words. */
export function shellWords(command: string): string[] {
  return shellSegments(command).flat();
}

/**
 * What a shell command does to files, by its programs wherever they sit (after `;`, inside `$( )` or
 * backticks, behind `sudo`, `env` or `xargs`): deleting, changing, or something else (run).
 */
export function commandOperation(command: string): Operation {
  const scan = scanShell(command);
  const programs = scan.segments.flatMap((segment) => chainOf(segment).names);
  if (programs.some((program) => DELETE_PROGRAMS.has(program))) return "delete";
  if (programs.some((program) => CHANGE_PROGRAMS.has(program)) || scan.segments.some((segment) => segment.redirects.some((redirect) => redirect.kind === "out"))) return "change";
  return "run";
}

/** A word as a comparison key: `~` expanded, relative to `cwd`, links followed unless the word holds a pattern. */
function wordKey(word: string, cwd: string, home: string): string {
  const expanded = word === "~" ? home : word.startsWith("~/") || word.startsWith("~\\") ? resolve(home, word.slice(2)) : word;
  const absolute = resolve(cwd, expanded);
  // A word with a pattern in it cannot be followed to a real file; any other is resolved the way a file tool resolves it, links included.
  return /[*?[]/.test(word) ? foldPath(absolute) : pathKey(absolute);
}

/**
 * What a command is working on, for recording a refusal: the words that can name a file or folder. A program's
 * own name is not one unless it is itself a path (`./run.sh`); redirect targets and assignment values always are.
 */
export function commandPaths(command: string, cwd: string): string[] {
  const home = homedir();
  const keys = new Set<string>();
  const add = (word: string): void => {
    if (!word) return;
    const at = word.indexOf("=");
    const flag = word.startsWith("-");
    // An option is not a file, but its value can be (`--out=file`); a plain word with an `=` and no path is an assignment-looking word.
    const value = at >= 0 && (flag || !/[\\/]/.test(word)) ? word.slice(at + 1) : word;
    if (flag && at < 0) return;
    if (value) keys.add(wordKey(value, cwd, home));
  };
  for (const segment of scanShell(command).segments) {
    const chain = chainOf(segment);
    for (const assignment of [...segment.assignments, ...chain.skipped.filter((word) => word.includes("="))]) add(assignment.slice(assignment.indexOf("=") + 1));
    if (chain.program !== null && /[\\/.~*?]/.test(chain.program)) add(chain.program);
    for (const word of chain.rest) add(word);
    for (const redirect of segment.redirects) add(redirect.target);
  }
  return [...keys];
}

export function commandResources(command: string, cwd: string): ToolResource[] {
  return commandPaths(command, cwd).map((value) => ({ kind: "path" as const, value }));
}

/**
 * Everything in the command that could be a file or folder, for asking "does this reach what the owner refused":
 * every word, program names and option values and the pieces of quoted strings included. More than
 * `commandResources`, on purpose: a refusal must not be dodged by how the line is written.
 */
export function shellCandidates(command: string, cwd: string): ToolResource[] {
  const home = homedir();
  const keys = new Set<string>();
  for (const word of scanShell(command).words) keys.add(wordKey(word, cwd, home));
  return [...keys].map((value) => ({ kind: "path" as const, value }));
}

/** True when `candidate` is `denied`, lies inside it, or contains it (a command on the folder reaches the file). */
export function pathsOverlap(denied: string, candidate: string): boolean {
  if (denied === candidate) return true;
  return candidate.startsWith(denied + sep) || denied.startsWith(candidate + sep) || denied.startsWith(candidate + "/") || candidate.startsWith(denied + "/");
}

/** A shell glob word (`*.txt`) against the base name of a denied file in the same folder. */
export function globCovers(denied: string, candidate: string): boolean {
  const name = basename(candidate);
  if (!/[*?[]/.test(name) || foldPath(dirname(candidate)) !== foldPath(dirname(denied))) return false;
  const pattern = name.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  try {
    return new RegExp(`^${pattern}$`, CASE_INSENSITIVE ? "i" : "").test(basename(denied));
  } catch {
    return false;
  }
}
