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

/**
 * Split a shell line into command segments, each a list of words. Quotes are removed; whitespace and
 * redirections split words; `;`, `&&`, `||`, `|`, `&`, newlines, subshell parentheses and backticks end a
 * segment, so the first word of each segment is the program that segment runs.
 */
export function shellSegments(command: string): string[][] {
  const segments: string[][] = [];
  let words: string[] = [];
  let current = "";
  let quote: string | null = null;
  const flushWord = (): void => { if (current) words.push(current); current = ""; };
  const endSegment = (): void => { flushWord(); if (words.length) segments.push(words); words = []; };
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null; else current += ch;
    } else if (ch === "'" || ch === "\"") {
      quote = ch;
    } else if (/[;|&\n()`]/.test(ch)) {
      endSegment();
    } else if (/[\s<>]/.test(ch)) {
      flushWord();
    } else {
      current += ch;
    }
  }
  endSegment();
  return segments;
}

/** Split a shell line into words: quotes are removed, separators and redirections split words. */
export function shellWords(command: string): string[] {
  return shellSegments(command).flat();
}

/** What a shell command does to files, by its programs: deleting, changing, or something else (run). */
export function commandOperation(command: string): Operation {
  const programs = command.split(/[;|&\n]+/).map((part) => shellWords(part)[0]?.split(/[\\/]/).pop()?.toLowerCase() ?? "");
  if (programs.some((program) => DELETE_PROGRAMS.has(program))) return "delete";
  if (programs.some((program) => CHANGE_PROGRAMS.has(program)) || /[^<]>(?!>)|>>/.test(command)) return "change";
  return "run";
}

/** The words of one command segment that can name a file: the program name is dropped unless it is itself a path (`./run.sh`). */
function segmentArguments(words: string[]): string[] {
  const [program = "", ...rest] = words;
  return /[\\/.~*?]/.test(program) ? words : rest;
}

/** Every word of the command that could name a file or folder, resolved against `cwd`, as comparison keys. */
export function commandPaths(command: string, cwd: string): string[] {
  const home = homedir();
  const keys = new Set<string>();
  for (const word of shellSegments(command).flatMap(segmentArguments)) {
    if (word.startsWith("-") || word.includes("=") && !/[\\/]/.test(word)) continue;
    const expanded = word === "~" ? home : word.startsWith("~/") || word.startsWith("~\\") ? resolve(home, word.slice(2)) : word;
    const absolute = resolve(cwd, expanded);
    // A word with a pattern in it cannot be followed to a real file; any other is resolved the way a file tool resolves it, links included.
    keys.add(/[*?[]/.test(word) ? foldPath(absolute) : pathKey(absolute));
  }
  return [...keys];
}

export function commandResources(command: string, cwd: string): ToolResource[] {
  return commandPaths(command, cwd).map((value) => ({ kind: "path" as const, value }));
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
