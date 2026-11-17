/**
 * Masking text that holds serialized JSON (Sprint 3 fix round 7).
 *
 * `redact` on a whole serialized document is wrong in three ways. JSON escaping changes a secret that holds
 * a quote, a backslash or a control character, so the registered value does not match the text; a field that
 * holds JSON inside a string (a tool's args or result) is escaped a second time; and a short registered value
 * can equal JSON syntax (`":"`), so masking it in the blob corrupts the document. This masks the strings of
 * the parsed value, one at a time, as the text they are.
 */
import { redact } from "./redact";

/** How many layers of JSON inside a string are opened. Deeper text is masked as it is; the registry covers two levels of escaping. */
const MAX_JSON_DEPTH = 6;

/** True when `text` could be a JSON object or array: the only JSON worth opening, and a cheap test. */
const looksLikeJSON = (text: string): boolean => {
  const first = text.trimStart().charAt(0);
  return first === "{" || first === "[";
};

/**
 * `text` with every registered secret masked. When `text` is a JSON object or array (a tool's args, a result)
 * its strings, keys and numbers are masked one at a time, and a string that is itself JSON is opened the
 * same way; the result is written back as JSON, and only when something was masked, so text with nothing to
 * mask comes back byte for byte. Text that is not JSON is masked as plain text, which covers the secret's raw
 * form and its escaped forms.
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
  if (typeof parsed !== "object" || parsed === null) return redact(text);
  try {
    const walked = walk(parsed, depth);
    return walked.changed ? JSON.stringify(walked.value) : text;
  } catch {
    // Nested too deep to walk: mask it as plain text rather than let any of it through.
    return redact(text);
  }
}

interface Walked {
  value: unknown;
  changed: boolean;
}

function walk(value: unknown, depth: number): Walked {
  if (typeof value === "string") {
    const masked = redactJSONText(value, depth + 1);
    return { value: masked, changed: masked !== value };
  }
  if (typeof value === "number") {
    // A registered number (a PIN written as a JSON number) is replaced by the mask, as a string.
    const masked = redact(JSON.stringify(value));
    return masked === JSON.stringify(value) ? { value, changed: false } : { value: masked, changed: true };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const walked = walk(item, depth);
      changed ||= walked.changed;
      return walked.value;
    });
    return { value: items, changed };
  }
  if (typeof value === "object" && value !== null) {
    let changed = false;
    // `fromEntries` defines own properties, so a key named `__proto__` stays a key.
    const entries = Object.entries(value).map(([key, item]): [string, unknown] => {
      const maskedKey = redact(key);
      const walked = walk(item, depth);
      changed ||= walked.changed || maskedKey !== key;
      return [maskedKey, walked.value];
    });
    return { value: Object.fromEntries(entries), changed };
  }
  return { value, changed: false };
}
