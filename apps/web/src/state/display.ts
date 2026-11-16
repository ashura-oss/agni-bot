/**
 * Small pure helpers for how the app words things: previews, labels and
 * initials. No state, so each one is pinned by a unit test.
 */

/** A one-line preview with the markdown syntax removed, so `**bold**` reads as bold. */
export function plainPreview(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n?([\s\S]*?)```/gu, "$1 ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/<[^>\n]+>/gu, "")
    .replace(/^\s{0,3}#{1,6}\s+/gmu, "")
    .replace(/^\s{0,3}>\s?/gmu, "")
    .replace(/^\s*[-*+]\s+(?:\[[ xX]\]\s+)?/gmu, "")
    .replace(/^\s*\d+[.)]\s+/gmu, "")
    .replace(/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/gmu, "")
    .replace(/\|/gu, " ")
    .replace(/(\*\*|__)(.+?)\1/gu, "$2")
    .replace(/(?<![\w*])([*_])(?!\s)(.+?)(?<!\s)\1(?![\w*])/gu, "$2")
    .replace(/~~(.+?)~~/gu, "$1")
    .replace(/`([^`]*)`/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * A provider's name for the list. The daemon labels OpenRouter "(:free)" for
 * its default free model; once the owner picks another model that suffix is
 * wrong, so it only stays while the chosen model really is a free one.
 */
export function providerLabel(provider: { label: string; model: string }): string {
  if (provider.model.endsWith(":free")) return provider.label;
  return provider.label.replace(/\s*\(:free\)\s*$/u, "");
}

/**
 * Initials for the owner's avatar, or null when there is no person's name to
 * take them from. The device name is "Ada's Mac" for a person, but just "This
 * PC" or "This Browser" otherwise; initials of those would be "TP" and "TB".
 */
export function ownerInitials(deviceName: string): string | null {
  const marker = deviceName.indexOf("'s ");
  if (marker <= 0) return null;
  const parts = deviceName.slice(0, marker).split(/\s+/u).filter(Boolean).slice(0, 2);
  const letters = parts.map((part) => Array.from(part)[0] ?? "").join("").toUpperCase();
  return letters.length > 0 ? letters : null;
}

/** Tags the app or the daemon fills in when nobody has written one. */
const PLACEHOLDER_ROLES = new Set(["unnamed", "agent"]);

/** The role as a person wrote it, or "" when it is only a placeholder. */
export function writtenRole(role: string | null | undefined): string {
  const trimmed = role?.trim() ?? "";
  return PLACEHOLDER_ROLES.has(trimmed.toLowerCase()) ? "" : trimmed;
}

export const MAX_AGENT_NAME_CHARS = 64;

export type NameCheck = { ok: true; name: string } | { ok: false; message: string };

/** The rules a bot's name has to meet, with the sentence to show when it does not. */
export function checkAgentName(raw: string): NameCheck {
  const name = raw.trim();
  if (name.length === 0) return { ok: false, message: "A name can't be empty." };
  if (Array.from(name).length > MAX_AGENT_NAME_CHARS) {
    return { ok: false, message: `Names can be up to ${MAX_AGENT_NAME_CHARS} characters. This one is ${Array.from(name).length}.` };
  }
  return { ok: true, name };
}

const FAILED_PREFIX = /^This turn failed:\s*/iu;

/** What a failed turn says, in words a person can act on. */
export interface Failure {
  /** One readable sentence. */
  summary: string;
  /** The daemon's own text, when it says more than the summary does. */
  detail: string | null;
}

/**
 * The daemon reports a provider failure as one long string that repeats the raw
 * HTTP body once per provider it tried. Say it once, plainly, and keep the raw
 * text for the owner who wants it.
 */
export function describeFailure(reason: string): Failure {
  const raw = reason.replace(FAILED_PREFIX, "").trim();
  const all = /^all providers failed\s*[—-]\s*([\s\S]+)$/iu.exec(raw);
  if (!all) return { summary: raw.length > 0 ? raw : "The turn failed.", detail: null };
  const causes = new Set<string>();
  for (const part of (all[1] ?? "").split(/\s+\|\s+/u)) {
    const status = /HTTP (\d{3})/u.exec(part)?.[1];
    const code = status ? Number(status) : null;
    if (code === 429) causes.add("rate limited");
    else if (code === 401 || code === 403) causes.add("the key was refused");
    else if (code !== null && code >= 500) causes.add("the provider had an error");
    else if (code === 408 || /time(?:d)?[ -]?out/iu.test(part)) causes.add("timed out");
    else causes.add("it returned an error");
  }
  return { summary: `Couldn't get an answer: every model provider failed (${[...causes].join(", ")}).`, detail: raw };
}

/** The failure a stored message text describes, or null when it is not one. */
export function failureOf(text: string): Failure | null {
  return FAILED_PREFIX.test(text) ? describeFailure(text) : null;
}

/** One line for a roster row: a failed turn reads as its summary, anything else as plain text. */
export function previewLine(raw: string): string {
  return failureOf(raw)?.summary ?? plainPreview(raw);
}

/** True on Apple platforms, where the command key is the shortcut modifier. */
function isApplePlatform(): boolean {
  const platform = typeof navigator === "undefined" ? "" : `${navigator.platform} ${navigator.userAgent}`;
  return /Mac|iPhone|iPad/u.test(platform);
}

/** The shortcut as this computer writes it: "⌘." on a Mac, "Ctrl+." elsewhere. */
export function shortcutLabel(key: string): string {
  return isApplePlatform() ? `\u2318${key}` : `Ctrl+${key}`;
}

const JOB_KIND_LABELS: Record<string, string> = {
  "task.reminder": "Task reminder",
  turn: "Background task",
  routine: "Routine",
  brief: "Morning brief",
};

/** A job kind as a person would say it, for a job that has no title of its own. */
export function jobKindLabel(kind: string): string {
  return JOB_KIND_LABELS[kind] ?? kind.replace(/[._]+/gu, " ").replace(/^./u, (first) => first.toUpperCase());
}

/** A job's last result without the daemon's bookkeeping prefix ("thread thr_...: "). */
export function plainJobResult(result: string): string {
  return result.replace(/^thread\s+\S+:\s*/u, "");
}
