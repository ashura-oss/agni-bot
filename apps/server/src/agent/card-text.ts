/**
 * Text the owner reads on a card, a prompt or a form that the model chose.
 *
 * Nothing the model writes may add a line to what the owner sees, reorder it,
 * or read differently from what it is. Control characters, bidirectional
 * overrides and isolates, and zero-width or invisible characters are shown as
 * visible escapes (a line break becomes backslash-n, U+202E becomes
 * backslash-u202E); each entry is capped; free text that really is several
 * lines (a mail body, a shell script) is quoted line by line or keeps only its
 * own line breaks. Every owner-facing surface for model-written text goes
 * through this one module.
 */

const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]|[\u{e0000}-\u{e007f}]/gu;
const NAMED_ESCAPES: Record<string, string> = { "\n": "\\n", "\r": "\\r", "\t": "\\t" };

/** Show every character that could change how the card reads as a visible escape. `keepLineBreaks` leaves line breaks and tabs alone (the text's own structure). */
export function escapeUnsafe(text: string, keepLineBreaks = false): string {
  return text.replace(UNSAFE_CHARS, (ch) => {
    if (keepLineBreaks && (ch === "\n" || ch === "\t")) return ch;
    const named = NAMED_ESCAPES[ch];
    if (named) return named;
    const code = ch.codePointAt(0)!;
    return code > 0xffff ? `\\u{${code.toString(16).toUpperCase()}}` : `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
  });
}

/** One model-chosen entry on one line, cut at `max` characters with a marker that says how much is missing. */
export function entry(value: unknown, max = 320): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return raw.length > max ? `${escapeUnsafe(raw.slice(0, max))}… (+${raw.length - max} chars)` : escapeUnsafe(raw);
}

/** Several lines of model-written text, each quoted, so a line that looks like a card field is plainly quoted text. */
export function quoted(text: string, max: number): string {
  return escapeUnsafe(clip(text.replace(/\r\n/g, "\n"), max), true).split("\n").map((line) => `> ${line}`).join("\n");
}

/** Cap long text without hiding its end: the dangerous part is often the tail. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)} … ${text.length - 2 * half} chars omitted … ${text.slice(-half)}`;
}

/** Text that is meant to be several lines (a question, a mail body): its own line breaks stay, nothing else unsafe does. */
export function multiLine(text: string): string {
  return escapeUnsafe(text.replace(/\r\n/g, "\n"), true);
}
