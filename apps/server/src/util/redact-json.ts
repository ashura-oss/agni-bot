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
import { redact } from "./redact";

/** How many layers of JSON inside a string are opened. Deeper text is masked as it is; the registry covers two levels of escaping. */
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
 * Two kinds of input are masked as plain text instead, which covers the secret's raw form and its escaped forms
 * and changes nothing else: text that is not JSON, and JSON holding a number that would not survive the round trip
 * (an id above 2^53, a decimal with more digits than a double holds), so those digits stay exact.
 */
export function redactJSONText(text: string, depth = 0): string {
  if (typeof text !== "string" || text.length === 0) return text;
  if (depth >= MAX_JSON_DEPTH || !looksLikeJSON(text)) return redact(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return redact(text);
  }
  if (hasLossyNumber(text)) return redact(text);
  try {
    const walked = walk(parsed, depth);
    return withBackstop(JSON.stringify(walked), walked);
  } catch {
    // Nested too deep to walk: mask it as plain text rather than let any of it through.
    return redact(text);
  }
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

/**
 * True when `text` (valid JSON) holds a number literal outside a string whose value is not the value it has once
 * parsed and written again: a double cannot hold it exactly, or it is out of range (`1e999` becomes `null`).
 * A literal that only changes its spelling (`1.0`, `1e2`) is not lossy.
 */
function hasLossyNumber(text: string): boolean {
  const end = text.length;
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
      if (!survives(text.slice(i, j))) return true;
      i = j;
    } else {
      i += 1;
    }
  }
  return false;
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
