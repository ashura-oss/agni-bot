/**
 * Secret redaction (S3-03).
 *
 * Every secret the server holds (provider keys, plugin passwords, OAuth
 * tokens, device tokens) is registered here once. `redact` then masks it, and
 * the common ways it turns up in text, wherever the server is about to log,
 * send or store a string. Callers use only `redact` and `registerSecret`;
 * those two signatures are frozen shared API.
 *
 * What is masked, for each registered value:
 *   - the value itself (and its trimmed form, for a value read from a file);
 *   - base64 and base64url of the whole value, with and without padding;
 *   - the `encodeURIComponent` form (a key inside a URL);
 *   - the JSON-escaped form (a key with quotes or newlines inside a JSON frame).
 *
 * A value shorter than `MIN_SECRET_LENGTH` is not registered: masking a
 * four-letter word everywhere would wreck ordinary text and protect nothing.
 *
 * Cost per `redact` call: one native substring scan per variant, so
 * O(variants x text length), with no allocation when nothing matches.
 * A vault of 10 secrets is about 50 variants; 100 KB of text takes well under
 * a millisecond per 10 variants on a laptop. The list of variants is rebuilt
 * only when a secret is added or removed, never per call.
 */

/** What a masked value is replaced with. */
export const REDACTED = "[redacted]";

/** Shorter values are ignored: too common to mask without damage. */
export const MIN_SECRET_LENGTH = 8;

/** A defensive cap so a bug that registers per-request values cannot grow without bound. */
const MAX_SECRETS = 2_000;

/** variants of each registered secret, by secret. */
const registry = new Map<string, readonly string[]>();

/** All variants, longest first, so a secret that contains another is masked as a whole. Null = rebuild. */
let needles: readonly string[] | null = [];

function variantsOf(value: string): string[] {
  const forms = new Set<string>();
  const add = (form: string): void => {
    if (form.length >= MIN_SECRET_LENGTH && form !== REDACTED) forms.add(form);
  };
  const bases = new Set([value]);
  const trimmed = value.trim();
  if (trimmed !== value) bases.add(trimmed);
  for (const base of bases) {
    add(base);
    const bytes = Buffer.from(base, "utf8");
    const b64 = bytes.toString("base64");
    add(b64);
    add(b64.replace(/=+$/, ""));
    add(bytes.toString("base64url"));
    add(encodeURIComponent(base));
    add(JSON.stringify(base).slice(1, -1));
  }
  return [...forms];
}

function rebuild(): readonly string[] {
  const all = new Set<string>();
  for (const forms of registry.values()) for (const form of forms) all.add(form);
  needles = [...all].sort((a, b) => b.length - a.length);
  return needles;
}

/** Return `text` with registered secrets masked. */
export function redact(text: string): string {
  if (typeof text !== "string" || text.length < MIN_SECRET_LENGTH) return text;
  const list = needles ?? rebuild();
  let out = text;
  for (const needle of list) {
    if (out.includes(needle)) out = out.split(needle).join(REDACTED);
  }
  return out;
}

/** Remember a secret value so `redact` masks it. Values shorter than `MIN_SECRET_LENGTH` are ignored. */
export function registerSecret(value: string): void {
  if (typeof value !== "string" || value.trim().length < MIN_SECRET_LENGTH) return;
  if (registry.has(value)) return;
  if (registry.size >= MAX_SECRETS) return;
  registry.set(value, variantsOf(value));
  needles = null;
}

/** Stop masking a value (a deleted credential, or a test cleaning up after itself). */
export function unregisterSecret(value: string): void {
  if (registry.delete(value)) needles = null;
}
