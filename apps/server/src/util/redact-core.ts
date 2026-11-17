/**
 * Secret redaction (S3-03). The implementation. Production code imports `util/redact`, which re-exports the
 * production names; `clearSecretsForTests` and `unregisterSecret` are here only, for tests.
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
 *   - the JSON-escaped form, one level deep (a key with quotes or newlines inside a JSON frame) and two
 *     levels deep (the same key inside JSON text that is itself a string of a JSON frame: a tool's args or
 *     result). Both only where escaping changes the value, so a value with no quote, backslash or control
 *     character adds neither. The forms belong to the value: they are held, queued, staged and released with it;
 *   - the base64 of the value inside a longer string, at each of the three
 *     byte alignments (the part of the encoding the neighbouring bytes cannot
 *     change), in the standard and URL-safe alphabets.
 *
 * Who holds a value: a value is masked while anything holds it. Every registration names a
 * holder (a vault entry, an environment variable, a store's slot; `registerSecret` is the
 * holder "anonymous"), and a holder lets go of its own hold only. So a store that stops using a
 * value cannot unmask one a vault entry, an environment variable or a provider key still has.
 * Nothing outside this file removes a value from the registry. A store that replaces or drops a
 * token does not unmask it at once either (it may still be valid), and no revoke unmasks it: see
 * "secrets a store replaces".
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
 * paired device); a refreshed token's old values leave the registry after a bounded wait
 * (`RETIRED_PER_SLOT` per slot, `RETIRED_MAX` in all), so refreshing does not fill it.
 */
export const MAX_SECRETS = 10_000;

/** variants of each registered secret, by secret. */
const registry = new Map<string, readonly string[]>();

/** Who holds each registered value. A value is in `registry` exactly while this set is not empty. */
const holders = new Map<string, Set<string>>();

/** The holder of `registerSecret`: values registered with no holder named, and let go of only by `unregisterSecret`. */
const ANONYMOUS = "anonymous";

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

/** `text` as it appears between the quotes of a JSON string. */
const jsonEscaped = (text: string): string => JSON.stringify(text).slice(1, -1);

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
    // How the value looks inside a JSON string (a frame, a document), and inside a JSON string that is itself
    // inside a JSON string (a tool's args or result, which hold serialized JSON). Escaping changes a value that has
    // a quote, a backslash or a control character, so the raw form no longer matches; when it does not change,
    // `add` takes the form again and the set drops it.
    const once = jsonEscaped(base);
    add(once);
    add(jsonEscaped(once));
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
  releaseDue();
  const list = needles ?? rebuild();
  let out = text;
  for (const needle of list) {
    if (out.includes(needle)) out = out.split(needle).join(REDACTED);
  }
  return out;
}

/**
 * Hold `value` for `holder`: it is masked until every holder has let go. Values shorter than
 * `MIN_SECRET_LENGTH` are ignored. Throws, holding nothing, when the registry is full.
 */
export function registerSecretFor(holder: string, value: string): void {
  if (typeof value !== "string" || value.trim().length < MIN_SECRET_LENGTH) return;
  let held = holders.get(value);
  if (!held) {
    if (registry.size >= MAX_SECRETS) {
      throw new Error(`secret registry is full (${MAX_SECRETS}): refusing to leave a secret unmasked`);
    }
    registry.set(value, variantsOf(value));
    held = new Set();
    holders.set(value, held);
    needles = null;
  }
  held.add(holder);
}

/** `holder` stops holding `value`. It stays masked while another holder holds it. */
export function releaseSecretFor(holder: string, value: string): void {
  const held = holders.get(value);
  if (!held?.delete(holder) || held.size > 0) return;
  holders.delete(value);
  registry.delete(value);
  needles = null;
}

/** Remember a secret value so `redact` masks it. Values shorter than `MIN_SECRET_LENGTH` are ignored. */
export function registerSecret(value: string): void {
  registerSecretFor(ANONYMOUS, value);
}

/**
 * TEST ONLY (not re-exported by `util/redact`). Let go of what `registerSecret` registered (a test cleaning up after
 * itself). Only that hold:
 * a value a vault entry, an environment variable or a slot holds stays masked.
 */
export function unregisterSecret(value: string): void {
  releaseSecretFor(ANONYMOUS, value);
}

/** TEST ONLY (not re-exported by `util/redact`). Forget every registered secret and every slot: a test starts with an empty registry. */
export function clearSecretsForTests(): void {
  registry.clear();
  holders.clear();
  slots.clear();
  nextExpiry = Infinity;
  needles = null;
}

/** How many secrets are registered. */
export function secretCount(): number {
  releaseDue();
  return registry.size;
}

// --- secrets a store replaces ----------------------------------------------------------
//
// A token that is refreshed replaces an earlier one, and one that is disconnected goes away.
// A store registers such a secret under a named slot. A slot is one holder, and it is
// conservative about letting go: a value the slot replaces or drops is not unmasked at once,
// because it may still be valid until it expires. Masking a dead value costs nothing;
// unmasking a live one leaks it. So the slot queues what it let go of, and a value leaves the
// queue when
//   - its known expiry has passed (`releaseExpiredSecrets`, which `redact` runs by itself), or
//   - it is the oldest of too many: more than `RETIRED_PER_SLOT` in its slot, or more than
//     `RETIRED_MAX` in all slots.
// A revoke is not on that list, on purpose. A provider that confirms it revoked a refresh token
// says nothing about an access token it already issued, which works until it expires, and a
// store cannot tell which of its values a given revoke killed. So nothing is unmasked because
// of a revoke, and no caller can unmask the wrong value by getting that wrong.
// A value with no known expiry (a refresh token, a password) is let go only by age. That is the
// only way a value that might still be valid is unmasked, and it is the price of a registry that
// cannot grow without bound (a hundred refreshes without a restart would otherwise leave a hundred
// dead tokens, each with about fifty masked forms). The bounds are generous for that reason.
// A value is only ever released by the slot's own hold: one another holder also holds stays masked.

/**
 * How many values one slot keeps masked after letting go of them (and, separately, how many it
 * keeps staged ahead of a save). A refresh of a token set replaces two or three values, so this
 * is about ten refreshes: far more than a refresh that is still in use somewhere can lag behind.
 */
export const RETIRED_PER_SLOT = 32;

/**
 * How many retired values, in all slots together, stay masked: when more pile up, the oldest (by
 * when it was queued) goes, whichever slot it is in. This keeps the registry under `MAX_SECRETS`
 * however many slots there are (one per plugin, account and connection). It is small on purpose,
 * because every retired value adds about fifty forms that each `redact` call scans for: at 2,000 a
 * `redact()` of a 100 KB frame measured 56 ms, so the bound is 512 (per slot
 * 32 still covers ten refreshes, and many slots rarely all have full queues). With the two JSON-escaped
 * forms, 512 values that all hold a quote, a backslash and a newline (the worst case) measured about 47 ms
 * for a 100 KB frame, against about 39 ms before the second form and about 21 ms for 512 plain values. It is about a twentieth
 * of `MAX_SECRETS`, so the live values of the vault, the environment and every store always fit.
 */
export const RETIRED_MAX = 512;

/** A value to hold for a slot, with the time (epoch ms) after which it is known to be dead, when known. */
export type SlotSecret = string | undefined | null | { value: string | undefined | null; expiresAt?: number };

interface Queued {
  value: string;
  until?: number;
  /** When it was queued (a counter, not a time), so the oldest across all slots can be found. */
  seq: number;
}

let nextSeq = 0;

interface Slot {
  /** What the slot holds now, with each value's known expiry. */
  live: Map<string, number | undefined>;
  /** What it let go of, oldest first: at most `RETIRED_PER_SLOT` (and `RETIRED_MAX` in all slots). */
  queue: Queued[];
  /** Values masked ahead of a save that has not succeeded (yet), oldest first: bounded the same way. */
  staged: Queued[];
}

const slots = new Map<string, Slot>();

/** The earliest expiry of any queued value, so `redact` looks at the clock only when something is due. */
let nextExpiry = Infinity;

const slotHolder = (slot: string): string => `slot:${slot}`;

function normalize(secrets: readonly SlotSecret[]): Map<string, number | undefined> {
  const out = new Map<string, number | undefined>();
  for (const secret of secrets) {
    const value = typeof secret === "object" && secret !== null ? secret.value : secret;
    if (typeof value !== "string" || value === "") continue;
    const expiresAt = typeof secret === "object" && secret !== null ? secret.expiresAt : undefined;
    out.set(value, expiresAt ?? out.get(value));
  }
  return out;
}

/** Hold each value for the slot, all or none: a registry that refuses leaves the slot as it was. */
function holdAll(slot: string, values: Iterable<string>): void {
  const holder = slotHolder(slot);
  const added: string[] = [];
  try {
    for (const value of values) {
      const fresh = !holders.get(value)?.has(holder);
      registerSecretFor(holder, value);
      if (fresh) added.push(value);
    }
  } catch (error) {
    for (const value of added) releaseSecretFor(holder, value);
    throw error;
  }
}

function slotOf(name: string): Slot {
  let slot = slots.get(name);
  if (!slot) {
    slot = { live: new Map(), queue: [], staged: [] };
    slots.set(name, slot);
  }
  return slot;
}

const holds = (slot: Slot, value: string): boolean =>
  slot.live.has(value) || slot.queue.some((queued) => queued.value === value) || slot.staged.some((staged) => staged.value === value);

/** Keep both queues within their bounds (oldest out), then drop the slot's hold on every value it no longer has. */
function settleSlot(name: string, slot: Slot, candidates: Iterable<string>): void {
  const gone = [...candidates];
  for (const list of [slot.queue, slot.staged]) {
    while (list.length > RETIRED_PER_SLOT) gone.push(list.shift()!.value);
  }
  for (const value of gone) if (!holds(slot, value)) releaseSecretFor(slotHolder(name), value);
  if (slot.live.size === 0 && slot.queue.length === 0 && slot.staged.length === 0) slots.delete(name);
  for (const queued of [...slot.queue, ...slot.staged]) if (queued.until !== undefined) nextExpiry = Math.min(nextExpiry, queued.until);
  trimRetired();
}

/**
 * Keep the retired values of all slots together within `RETIRED_MAX`: the oldest queued goes first, whichever slot it is
 * in. Staged values count toward the total but are never evicted here: a staged value is the newest token a store has
 * seen and has not yet had a save settle it, so it is still in use, and unmasking it because other slots rotated would
 * leak a live credential. Staged stays bounded by `RETIRED_PER_SLOT` per slot (`settleSlot`).
 */
function trimRetired(): void {
  let total = 0;
  for (const slot of slots.values()) total += slot.queue.length + slot.staged.length;
  while (total > RETIRED_MAX) {
    let oldest: { name: string; slot: Slot } | undefined;
    for (const [name, slot] of slots) {
      if (slot.queue.length > 0 && (!oldest || slot.queue[0]!.seq < oldest.slot.queue[0]!.seq)) oldest = { name, slot };
    }
    if (!oldest) return; // only staged values are left: none of them is evicted
    const { value } = oldest.slot.queue.shift()!;
    total -= 1;
    if (!holds(oldest.slot, value)) releaseSecretFor(slotHolder(oldest.name), value);
    if (oldest.slot.live.size === 0 && oldest.slot.queue.length === 0 && oldest.slot.staged.length === 0) slots.delete(oldest.name);
  }
}

/**
 * Mask `secrets` before they are saved, holding them for `slot` without touching what the slot
 * already holds or has queued. A save that fails then leaves the old values (still in the file)
 * and the new ones masked, and nothing is pushed out of the queue by a value that was never
 * saved. `rememberSecretsAt` settles the slot once the save has succeeded.
 */
export function stageSecretsAt(slot: string, ...secrets: SlotSecret[]): void {
  const next = normalize(secrets);
  holdAll(slot, next.keys());
  const state = slotOf(slot);
  for (const [value, until] of next) {
    if (state.live.has(value) || state.queue.some((entry) => entry.value === value)) continue;
    const staged = state.staged.find((entry) => entry.value === value);
    if (staged) staged.until = until ?? staged.until;
    else state.staged.push({ value, until, seq: nextSeq++ });
  }
  settleSlot(slot, state, []);
}

/**
 * Set `slot` to `secrets`, once the save that holds them has succeeded (never before: a save
 * that fails keeps the old values). What the slot held and no longer does, and what was staged
 * and is not among `secrets`, is queued, not unmasked; a value already past its expiry is let go
 * of now. With no secrets, the slot is emptied the same way.
 */
export function rememberSecretsAt(slot: string, ...secrets: SlotSecret[]): void {
  const next = normalize(secrets);
  holdAll(slot, next.keys());
  const state = slotOf(slot);
  const now = Date.now();
  const dropped = [...state.live].filter(([value]) => !next.has(value));
  const unsettled = state.staged.filter((entry) => !next.has(entry.value));
  state.live = next;
  state.staged = [];
  state.queue = state.queue.filter((entry) => !next.has(entry.value));
  for (const entry of [...dropped.map(([value, until]) => ({ value, until, seq: nextSeq++ })), ...unsettled]) {
    if (entry.until !== undefined && entry.until <= now) continue;
    state.queue.push(entry);
  }
  settleSlot(slot, state, [...dropped.map(([value]) => value), ...unsettled.map((entry) => entry.value)]);
}

/** Let go of every slot whose name starts with `prefix` and is not in `keep` (an account or plugin that is gone). */
export function forgetSecretSlots(prefix: string, keep: ReadonlySet<string> = new Set()): void {
  for (const slot of [...slots.keys()]) if (slot.startsWith(prefix) && !keep.has(slot)) rememberSecretsAt(slot);
}

/**
 * Release the queued values whose expiry has passed. A value a slot holds live is never released here. It reads the clock
 * itself and takes no time argument: a caller that could name a future time could unmask tokens that still work (tests move
 * the clock with `setSystemTime`).
 */
export function releaseExpiredSecrets(): void {
  const now = Date.now();
  nextExpiry = Infinity;
  for (const [name, slot] of [...slots]) {
    const due = (entry: Queued): boolean => entry.until !== undefined && entry.until <= now;
    const expired = [...slot.queue, ...slot.staged].filter(due);
    slot.queue = slot.queue.filter((entry) => !due(entry));
    slot.staged = slot.staged.filter((entry) => !due(entry));
    settleSlot(name, slot, expired.map((entry) => entry.value));
  }
}

/** Run the expiry check when a queued value's expiry is due. */
function releaseDue(): void {
  if (nextExpiry !== Infinity && nextExpiry <= Date.now()) releaseExpiredSecrets();
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
    if (typeof value === "string") registerSecretFor(`env:${name}`, value);
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
  releaseDue();
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
