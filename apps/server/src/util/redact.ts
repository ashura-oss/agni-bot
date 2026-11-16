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
 *   - the JSON-escaped form (a key with quotes or newlines inside a JSON frame);
 *   - the base64 of the value inside a longer string, at each of the three
 *     byte alignments (the part of the encoding the neighbouring bytes cannot
 *     change), in the standard and URL-safe alphabets.
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

import { SECRET_NAME_PATTERN } from "./secret-names";

/** What a masked value is replaced with. */
export const REDACTED = "[redacted]";

/** Shorter values are ignored: too common to mask without damage. */
export const MIN_SECRET_LENGTH = 8;

/**
 * A defensive cap so a bug that registers per-request values cannot grow without bound.
 * Reaching it throws: a secret that cannot be registered is a secret that would go out unmasked.
 * Sized for a real home (provider keys, plugin credentials, OAuth tokens, a device token per
 * paired device); values that leave the vault are unregistered, so refreshing does not fill it.
 */
export const MAX_SECRETS = 10_000;

/** variants of each registered secret, by secret. */
const registry = new Map<string, readonly string[]>();

/** All variants, longest first, so a secret that contains another is masked as a whole. Null = rebuild. */
let needles: readonly string[] | null = [];

/** The same variants in plain sort order, for prefix lookups by `holdbackLength`. Rebuilt with `needles`. */
let sortedNeedles: readonly string[] = [];
/** The first character of every variant, so most suffixes of a stream are ruled out with one lookup. */
let firstChars: ReadonlySet<string> = new Set();

/**
 * Base64 of `bytes` as it appears when other bytes sit before and after them.
 * `lead` bytes before shift the grouping by `lead % 3`; the first chars that
 * mix in those bytes, and the last char that mixes in the bytes after, are
 * dropped, so what is left is the same whatever surrounds the value.
 */
function embeddedBase64(bytes: Buffer, lead: 0 | 1 | 2): string[] {
  const padded = Buffer.concat([Buffer.alloc(lead), bytes]);
  const skip = [0, 2, 3][lead] ?? 0;
  const trailing = padded.length % 3 === 0 ? 0 : 1;
  return [padded.toString("base64").replace(/=+$/, ""), padded.toString("base64url")]
    .map((encoded) => encoded.slice(skip, encoded.length - trailing));
}

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
    for (const lead of [0, 1, 2] as const) for (const form of embeddedBase64(bytes, lead)) add(form);
  }
  return [...forms];
}

function rebuild(): readonly string[] {
  const all = new Set<string>();
  for (const forms of registry.values()) for (const form of forms) all.add(form);
  needles = [...all].sort((a, b) => b.length - a.length);
  sortedNeedles = [...all].sort();
  firstChars = new Set(sortedNeedles.map((form) => form.charAt(0)));
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
  if (registry.size >= MAX_SECRETS) {
    throw new Error(`secret registry is full (${MAX_SECRETS}): refusing to leave a secret unmasked`);
  }
  registry.set(value, variantsOf(value));
  needles = null;
}

/** Stop masking a value (a deleted credential, or a test cleaning up after itself). */
export function unregisterSecret(value: string): void {
  if (registry.delete(value)) needles = null;
}

/** How many secrets are registered. */
export function secretCount(): number {
  return registry.size;
}

/**
 * Register the value of each named variable. Unset and too-short values are
 * skipped, like any other `registerSecret` call. The caller chooses the names
 * (see `secretEnvNames`): which variables are secrets is a naming question,
 * answered once in `util/secret-names.ts`.
 */
export function registerSecretsFromEnv(names: Iterable<string>, env: Record<string, string | undefined> = process.env): void {
  for (const name of names) {
    const value = env[name];
    if (typeof value === "string") registerSecret(value);
  }
}

/**
 * The names in `env` that carry a secret and can be recognised as one:
 * a secret by shape (`SECRET_NAME_PATTERN`: `*_API_KEY`, `*_TOKEN`, `*_PASSWORD`,
 * `AGNI_CUSTOM_KEY_n`...) or a catalog provider's key variable. This is the
 * "secret by name" half of `isSecretSettingName`, not the whole of it: that
 * function calls every unknown name a secret (right for "keep it out of a
 * child process"), which over a whole environment would mask `PATH` and the
 * home directory everywhere they appear.
 */
export function secretEnvNames(env: Record<string, string | undefined>, providerEnvNames: Iterable<string> = []): string[] {
  const providers = [...providerEnvNames];
  return Object.keys(env).filter((name) => SECRET_NAME_PATTERN.test(name) || inExtra(name, providers));
}

function inExtra(name: string, list: readonly string[]): boolean {
  const upper = name.toUpperCase();
  return list.some((entry) => entry.toUpperCase() === upper);
}

/**
 * How many characters at the end of `text` could be the start of a registered
 * secret, and so must wait for the next piece of a stream before they are sent.
 * Zero for ordinary text, so a stream is held back only while it is in the
 * middle of something that looks like a secret.
 */
export function holdbackLength(text: string): number {
  const list = needles ?? rebuild();
  const longest = list[0]?.length ?? 0;
  for (let k = Math.min(text.length, longest - 1); k >= 1; k--) {
    if (!firstChars.has(text.charAt(text.length - k))) continue;
    if (startsLongerNeedle(text.slice(text.length - k))) return k;
  }
  return 0;
}

/** True when some variant starts with `prefix` and is longer than it. */
function startsLongerNeedle(prefix: string): boolean {
  let low = 0;
  let high = sortedNeedles.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((sortedNeedles[mid] as string) < prefix) low = mid + 1;
    else high = mid;
  }
  for (let i = low; i < sortedNeedles.length; i++) {
    const form = sortedNeedles[i] as string;
    if (!form.startsWith(prefix)) return false;
    if (form.length > prefix.length) return true;
  }
  return false;
}
