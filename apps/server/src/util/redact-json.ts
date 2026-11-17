/**
 * Masking text that holds serialized JSON (Sprint 3 fix rounds 7 and 8).
 *
 * `redact` on a whole serialized document is wrong in three ways. JSON escaping changes a secret that holds
 * a quote, a backslash or a control character, so the registered value does not match the text; a field that
 * holds JSON inside a string (a tool's args or result) is escaped a second time; and a short registered value
 * can equal JSON syntax (`":"`), so masking it in the blob corrupts the document. This masks the strings of
 * the parsed value, one at a time, as the text they are. Round 8: the parser and the raw bytes can disagree
 * (`JSON.parse` keeps the last of two equal keys), so parsed JSON is never returned as the raw text.
 */
import { REDACTED, redact } from "./redact";

/** How many layers of JSON inside a string are opened. Deeper text that parses as JSON is withheld; deeper text that does not is masked as plain text. */
const MAX_JSON_DEPTH = 6;

/** True when `text` could be a JSON object, array or string: the only JSON worth opening, and a cheap test. */
const looksLikeJSON = (text: string): boolean => {
  const first = text.trimStart().charAt(0);
  return first === "{" || first === "[" || first === '"';
};

/**
 * `text` with every registered secret masked. When `text` parses as JSON its strings, keys and numbers are masked
 * one at a time, and a string that is itself JSON is opened the same way. The result is always the walked value
 * serialized again, never the raw text: `JSON.parse` keeps only the last of two equal keys, so the first value is
 * never walked, and returning the raw text "because nothing was masked" would put it on disk. Formatting of parsed
 * JSON is therefore compact; its values are the ones any JSON reader sees.
 *
 * Text that is not JSON is masked as plain text. A number that would not survive the round trip (an id above
 * 2^53, a decimal with more digits than a double holds) does not change any of this: its digits are swapped for a
 * placeholder string before the parse and put back after the walk (`swapLossyNumbers`, `spliceLossyNumbers`), so
 * the walk and the serialization see exactly what they see for any other JSON. If a placeholder does not come
 * back exactly once and unaltered, nothing is put back and the walked value is written as it is; the number then
 * has the value a double gives it. Masking such input as plain text would let a `\u`-escaped secret, or a secret
 * in the first of two equal keys, through for anyone who adds a big number to force that path.
 */
export function redactJSONText(text: string, depth = 0): string {
  if (typeof text !== "string" || text.length === 0) return text;
  if (!looksLikeJSON(text)) return redact(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return redact(text);
  }
  // Too deep to open, but it parses as JSON: masking it as plain text would miss a secret written with a JSON
  // escape, so it is withheld whole. Only text that is not JSON is masked as text at this depth.
  if (depth >= MAX_JSON_DEPTH) return REDACTED;
  try {
    const swapped = swapLossyNumbers(text);
    if (swapped.literals.length > 0) {
      const exact = walkWithPlaceholders(swapped, depth);
      if (exact !== null) return exact;
    }
    const walked = walk(parsed, depth);
    return withBackstop(JSON.stringify(walked), walked);
  } catch {
    // Nested too deep to walk. The text parsed, so it is not returned as text either: plain-text masking would miss
    // a `\u`-escaped secret or one in the first of two equal keys, and anyone can nest deep enough to get here.
    return REDACTED;
  }
}

/** The text of `swapped` parsed, walked and written again, with the digits put back; null when a placeholder did not survive. */
function walkWithPlaceholders(swapped: SwappedNumbers, depth: number): string | null {
  const walked = walk(JSON.parse(swapped.text), depth);
  return spliceLossyNumbers(withBackstop(JSON.stringify(walked), walked), swapped);
}

/**
 * The serialized walked value with a text-level pass over it, kept only when it leaves the document's structure
 * as it was. Every string, key and number was masked on its own, so a registered value that still appears in the
 * serialized text can only straddle two tokens (`","`), and masking that would corrupt the document; a pass that
 * changes the structure is dropped.
 */
function withBackstop(serialized: string, walked: unknown): string {
  const masked = redact(serialized);
  if (masked === serialized) return serialized;
  try {
    return sameShape(JSON.parse(masked), walked) ? masked : serialized;
  } catch {
    return serialized;
  }
}

/** True when both values are arrays of the same length, or objects with the same keys, all the way down; leaves may differ. */
function sameShape(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => sameShape(item, b[index]));
  }
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const keys = Object.keys(a);
    const other = Object.keys(b);
    return keys.length === other.length && keys.every((key, index) => key === other[index] && sameShape((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
  }
  return (typeof a === "object" && a !== null) === (typeof b === "object" && b !== null);
}

/** What every placeholder starts with. A registered value equal to this alters them all, which is the fail-closed path. */
export const LOSSY_PLACEHOLDER_PREFIX = "agni_lossy_number_";

/** `text` with its lossy number literals swapped out: the literals in order, and the marker every placeholder starts with. */
export interface SwappedNumbers {
  /** The input with each lossy literal replaced by the string `"<marker><index>_"`. */
  text: string;
  /** The digits that were swapped out, in order of appearance. */
  literals: string[];
  /** The prefix and a nonce made for this call: `<LOSSY_PLACEHOLDER_PREFIX><32 hex digits>_`. */
  marker: string;
}

/**
 * Swaps every number literal outside a string whose value is not the value it has once parsed and written again
 * (a double cannot hold it exactly, or it is out of range: `1e999` becomes `null`) for a placeholder string. A
 * literal that only changes its spelling (`1.0`, `1e2`) is not lossy and stays. String contents are skipped, so
 * a digit run inside a string is never touched. `text` must be valid JSON. The marker carries a nonce made fresh
 * for each call, so no one can write a string the walk would take for a placeholder.
 */
export function swapLossyNumbers(text: string): SwappedNumbers {
  const marker = `${LOSSY_PLACEHOLDER_PREFIX}${crypto.randomUUID().replaceAll("-", "")}_`;
  const literals: string[] = [];
  const parts: string[] = [];
  const end = text.length;
  let copied = 0;
  let i = 0;
  while (i < end) {
    const c = text.charCodeAt(i);
    if (c === 34) {
      i += 1;
      while (i < end) {
        const d = text.charCodeAt(i);
        i += d === 92 ? 2 : 1;
        if (d === 34) break;
      }
    } else if (c === 45 || (c >= 48 && c <= 57)) {
      let j = i + 1;
      while (j < end && isNumberChar(text.charCodeAt(j))) j += 1;
      const literal = text.slice(i, j);
      if (!survives(literal)) {
        parts.push(text.slice(copied, i), `"${marker}${literals.length}_"`);
        literals.push(literal);
        copied = j;
      }
      i = j;
    } else {
      i += 1;
    }
  }
  parts.push(text.slice(copied));
  return { text: parts.join(""), literals, marker };
}

/**
 * `serialized` with each placeholder put back as the digits it stood for, or null when that cannot be trusted:
 * the marker must appear exactly as many times as numbers were swapped, and each placeholder exactly once as a
 * whole string. A placeholder that was masked, dropped (the parser keeps the last of two equal keys) or written
 * twice makes the count wrong. A literal that is itself a registered value is masked, as a string.
 */
function spliceLossyNumbers(serialized: string, swapped: SwappedNumbers): string | null {
  const { marker, literals } = swapped;
  if (serialized.split(marker).length - 1 !== literals.length) return null;
  const seen = new Array<number>(literals.length).fill(0);
  let intact = true;
  const spliced = serialized.replace(new RegExp(`"${marker}(\\d+)_"`, "g"), (whole, index: string) => {
    const at = Number(index);
    if (at >= literals.length || (seen[at] = (seen[at] ?? 0) + 1) > 1) {
      intact = false;
      return whole;
    }
    const literal = literals[at]!;
    const masked = redact(literal);
    return masked === literal ? literal : JSON.stringify(masked);
  });
  return intact && seen.every((count) => count === 1) ? spliced : null;
}

const isNumberChar = (c: number): boolean => (c >= 48 && c <= 57) || c === 46 || c === 43 || c === 45 || c === 69 || c === 101;

/** An integer of up to 15 digits is exact in a double; anything else is compared by value. */
function survives(literal: string): boolean {
  if (literal.length <= 15 && /^-?(?:0|[1-9]\d*)$/.test(literal)) return true;
  const there = decimalForm(literal);
  const back = decimalForm(String(Number(literal)));
  return there !== null && there === back;
}

/** A number's value as `<sign><digits>e<exponent>` with no leading or trailing zeros in the digits; null when it is not a finite number. */
function decimalForm(literal: string): string | null {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(literal);
  if (!match) return null;
  const [, sign, whole, fraction = "", exponent = "0"] = match;
  const digits = (whole + fraction).replace(/^0+/, "");
  const trimmed = digits.replace(/0+$/, "");
  if (trimmed === "") return "0";
  return `${sign}${trimmed}e${Number(exponent) - fraction.length + (digits.length - trimmed.length)}`;
}

function walk(value: unknown, depth: number): unknown {
  if (typeof value === "string") return redactJSONText(value, depth + 1);
  if (typeof value === "number") {
    // A registered number (a PIN written as a JSON number) is replaced by the mask, as a string.
    const text = JSON.stringify(value);
    const masked = redact(text);
    return masked === text ? value : masked;
  }
  if (Array.isArray(value)) return value.map((item) => walk(item, depth));
  if (typeof value === "object" && value !== null) {
    // `fromEntries` defines own properties, so a key named `__proto__` stays a key.
    return Object.fromEntries(Object.entries(value).map(([key, item]): [string, unknown] => [redact(key), walk(item, depth)]));
  }
  return value;
}
