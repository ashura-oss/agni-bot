/**
 * What a call touches, read from its arguments: files, recipients, hosts.
 * The engine uses these for denials ("the owner said no to this file"), for
 * the egress binding ("this address is not one the owner named") and for the
 * audit trail. Nothing here runs a model or the network; it is string work
 * plus a few `realpath` calls, so it stays well under a millisecond.
 */
import { resolve, sep } from "node:path";
import type { Operation } from "./types";
import type { ToolResource } from "./tool-meta";
import { resolveWritePath, scratchDir } from "../tools/write-file";
import { proveShell } from "./shell-proof";

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

/** The folder a shell command runs in: scratch, or a folder inside it (a relative `cwd` is under scratch, as `isReadOnlyCommand` and the shell tool read it). */
export function shellWorkingDir(cwd: string | undefined): string {
  return resolve(scratchDir(), (cwd ?? "").trim());
}

/** What the policy knows about a shell command. */
export interface ShellFacts {
  /** Was it proven to be one allowlisted program on plain literal words (policy/shell-proof.ts)? */
  proven: boolean;
  /** What it does to files. An unproven command is `run`: nothing about it is read. */
  operation: Operation;
  /** The files it names, as comparison keys. Empty when unproven: no file name is read out of a line the server cannot follow. */
  resources: ToolResource[];
}

/** The one reading of a shell line the policy uses, for the card, for denials and for the audit trail. */
export function shellFacts(command: string, cwd: string): ShellFacts {
  const proof = proveShell(command, cwd);
  if (!proof.proven) return { proven: false, operation: "run", resources: [] };
  return { proven: true, operation: proof.operation, resources: proof.paths.map(pathResource) };
}

/** True when `candidate` is `denied`, lies inside it, or contains it (a command on the folder reaches the file). */
export function pathsOverlap(denied: string, candidate: string): boolean {
  if (denied === candidate) return true;
  return candidate.startsWith(denied + sep) || denied.startsWith(candidate + sep) || denied.startsWith(candidate + "/") || candidate.startsWith(denied + "/");
}
