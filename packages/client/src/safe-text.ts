/**
 * Text a bot chose, drawn on a card the owner decides from. Control
 * characters, bidirectional overrides and isolates, and zero-width or
 * invisible characters are shown as visible escapes, so nothing a bot writes
 * can add a line to a card, reorder it, or read differently from what it is.
 * This is the same rule the daemon applies to approval previews
 * (`apps/server/src/agent/approval-broker.ts`); the app applies it again to
 * every card field, because the daemon only covers the ones it builds.
 *
 * Cards draw their fields as React text: never HTML, never markdown.
 */
/** Code point ranges: C0 and C1 controls, soft hyphen, bidi marks and overrides, zero-width and invisible characters, tags. */
const UNSAFE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f], [0x007f, 0x009f], [0x00ad, 0x00ad], [0x061c, 0x061c], [0x180e, 0x180e],
  [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff], [0xfff9, 0xfffb], [0xe0000, 0xe007f],
];
const UNSAFE_CHARS = new RegExp(
  UNSAFE_RANGES.map(([from, to]) => `[${String.fromCodePoint(from)}-${String.fromCodePoint(to)}]`).join("|"),
  "gu",
);
const NAMED_ESCAPES: Record<string, string> = { "\n": "\\n", "\r": "\\r", "\t": "\\t" };

function escapeUnsafe(text: string, keepLineBreaks: boolean): string {
  return text.replace(UNSAFE_CHARS, (ch) => {
    if (keepLineBreaks && ch === "\n") return ch;
    const named = NAMED_ESCAPES[ch];
    if (named) return named;
    const code = ch.codePointAt(0)!;
    return code > 0xffff ? `\\u{${code.toString(16).toUpperCase()}}` : `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
  });
}

/**
 * A cap that keeps both ends. What a bot hides is at the end as often as at the start (a thousand
 * harmless lines, then the command that matters), so a cut never takes only the tail.
 */
function middleCut(value: string, max: number, keepLineBreaks: boolean): string {
  const head = Math.ceil(max / 2);
  const tail = Math.floor(max / 2);
  const hidden = value.length - head - tail;
  const note = `… (${hidden} characters not shown) …`;
  const marker = keepLineBreaks ? `\n${note}\n` : ` ${note} `;
  return `${escapeUnsafe(value.slice(0, head), keepLineBreaks)}${marker}${escapeUnsafe(value.slice(value.length - tail), keepLineBreaks)}`;
}

/** One entry on one line: line breaks become visible escapes. Longer than `max` characters, the start and the end are kept. */
export function safeLine(value: string, max?: number): string {
  if (max !== undefined && value.length > max) return middleCut(value, max, false);
  return escapeUnsafe(value, false);
}

/** Several lines (a mail body, a command's preview): line breaks stay, everything else unsafe is escaped. Start and end are kept past `max`. */
export function safeText(value: string, max?: number): string {
  if (max !== undefined && value.length > max) return middleCut(value, max, true);
  return escapeUnsafe(value, true);
}
