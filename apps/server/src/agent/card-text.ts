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

/**
 * Characters that draw nothing, or change how what is around them reads: control characters, bidirectional
 * marks, zero-width and word-joiner characters, the Hangul fillers (U+115F, U+1160, U+3164, U+FFA0, which
 * render as blank), the combining grapheme joiner (U+034F), the variation selectors (U+FE00-FE0F and
 * U+E0100-E01EF) and the tag characters.
 */
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff9-\ufffb]|[\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;
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

/**
 * One model-chosen entry on one line. Past `max` characters the middle is cut,
 * never the end: the start and the end are both kept, with a marker between
 * that says how many characters are not shown.
 */
export function entry(value: unknown, max = 320): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  if (raw.length <= max) return escapeUnsafe(raw);
  const head = Math.ceil(max / 2);
  const tail = Math.floor(max / 2);
  return `${escapeUnsafe(raw.slice(0, head))}… (+${raw.length - max} chars) …${escapeUnsafe(raw.slice(raw.length - tail))}`;
}

/**
 * Several lines of model-written text, each quoted, so a line that looks like a
 * card field is plainly quoted text. The cap is applied to the quoted text, so
 * the quote marks cannot push it over, and it keeps the start and the end.
 */
export function quoted(text: string, max: number): string {
  const lines = escapeUnsafe(text.replace(/\r\n/g, "\n"), true).split("\n").map((line) => `> ${line}`);
  return clip(lines.join("\n"), max);
}

/**
 * Model-written text as the owner reads it when the text is part of what will run: quoted line by line like `quoted`, and never cut.
 * A card that cannot hold all of it is not shown (`agent/card-preview.ts`), so nothing here ever drops a character.
 */
export function quotedWhole(text: string): string {
  return escapeUnsafe(text.replace(/\r\n/g, "\n"), true).split("\n").map((line) => `> ${line}`).join("\n");
}

/** One model-chosen value on one line, with every character shown (hidden ones as escapes). For a field that is part of what will run. */
export function whole(value: unknown): string {
  return escapeUnsafe(typeof value === "string" ? value : JSON.stringify(value) ?? "");
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

/**
 * One entry on one line whose escaped text is at most `max` characters long. An escape is longer than the
 * character it shows (`\u202E` is six), so a cap on the raw text is not a cap on what is sent; this keeps
 * the start and the end and narrows the raw cap until the escaped text fits. For frame fields that have a
 * length limit in the protocol.
 */
export function fitEntry(value: unknown, max: number): string {
  let raw = max;
  for (;;) {
    const shown = entry(value, raw);
    if (shown.length <= max || raw <= 8) return shown.length <= max ? shown : shown.slice(0, max);
    raw = Math.max(8, Math.floor(raw * (max / shown.length)) - 1);
  }
}
