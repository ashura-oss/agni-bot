/**
 * Device tokens. The plaintext token leaves the server exactly once (at
 * `pair`); only its SHA-256 hash is stored. Revocation is a single column.
 */
import type { Database } from "bun:sqlite";
import { newID, nowISO } from "../util/ids";
import { registerSecretFor } from "../util/redact";

export interface Device {
  id: string;
  name: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

const TOKEN_PREFIX = "agni_";

/**
 * A device token no one has used for this long stops working: a lost phone or a
 * forgotten browser does not stay paired forever. It slides: every use (a page
 * check-in, a socket hello, a CLI or Mac request, an open socket) moves it forward.
 * Browser sessions, the Mac app and the CLI all authenticate through `verifyToken`,
 * so they share this rule; a CLI or Mac token idle 30 days is paired again.
 */
export const SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000;

/** `last_seen_at` is written at most this often per device, so a busy client does not write on every request. */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Buffer.from(digest).toString("hex");
}

export async function mintToken(db: Database, name: string): Promise<{ device: Device; token: string }> {
  const token = `${TOKEN_PREFIX}${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
  const device: Device = {
    id: newID("dev"),
    name,
    created_at: nowISO(),
    last_seen_at: null,
    revoked_at: null,
  };
  // Registered before it is stored or handed out: from here on no log line or frame can carry it. Held under its
  // device, and kept until the server restarts even if the device is revoked or idles out: a dead token costs nothing
  // to keep masked (a restart loads only the hashes, so the registry does not grow across runs).
  registerSecretFor(`device-token:${device.id}`, token);
  db.run("INSERT INTO devices (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)", [
    device.id,
    device.name,
    await hashToken(token),
    device.created_at,
  ]);
  return { device, token };
}

export async function verifyToken(db: Database, token: string): Promise<Device | null> {
  const row = db
    .query<Device, [string]>(
      "SELECT id, name, created_at, last_seen_at, revoked_at FROM devices WHERE token_hash = ?",
    )
    .get(await hashToken(token));
  if (!row || row.revoked_at) return null;
  // Idle too long: judged by the last use, or by pairing time for a device never seen.
  // A timestamp that cannot be read means the idle rule cannot be applied, so the token is refused.
  const created = Date.parse(row.created_at);
  const lastActive = row.last_seen_at === null ? created : Date.parse(row.last_seen_at);
  if (!Number.isFinite(created) || !Number.isFinite(lastActive)) return null;
  if (Date.now() - lastActive > SESSION_IDLE_MS) return null;
  registerSecretFor(`device-token:${row.id}`, token); // after a restart this is how a paired token is masked again
  touchDevice(db, row.id);
  return row;
}

/** Mark a device as in use now, unless it was marked within the last hour. */
export function touchDevice(db: Database, deviceID: string): void {
  const now = Date.now();
  db.run(
    "UPDATE devices SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL AND (last_seen_at IS NULL OR last_seen_at < ?)",
    [new Date(now).toISOString(), deviceID, new Date(now - TOUCH_INTERVAL_MS).toISOString()],
  );
}

/** A prefix names more than one device, so no device was revoked. */
export class AmbiguousDevicePrefixError extends Error {
  constructor(readonly prefix: string, readonly count: number) {
    super(`"${prefix}" matches ${count} devices; give more of the id so it names one`);
    this.name = "AmbiguousDevicePrefixError";
  }
}

/**
 * Revoke a device by its full id or a unique prefix. Null when nothing matches.
 * A prefix that matches several devices throws `AmbiguousDevicePrefixError` and
 * revokes none: revoking whichever row came first would cut off the wrong device.
 */
export function revokeDevice(db: Database, idOrPrefix: string): Device | null {
  // A prefix, compared as text: `LIKE` would read `%` and `_` in the argument as wildcards.
  if (idOrPrefix.length === 0) return null;
  const columns = "id, name, created_at, last_seen_at, revoked_at";
  const exact = db.query<Device, [string]>(`SELECT ${columns} FROM devices WHERE id = ?`).get(idOrPrefix);
  let row = exact;
  if (!row) {
    const matches = db
      .query<Device, [string]>(`SELECT ${columns} FROM devices WHERE substr(id, 1, length(?1)) = ?1 LIMIT 2`)
      .all(idOrPrefix);
    if (matches.length > 1) {
      const count = db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM devices WHERE substr(id, 1, length(?1)) = ?1").get(idOrPrefix)!.n;
      throw new AmbiguousDevicePrefixError(idOrPrefix, count);
    }
    row = matches[0] ?? null;
  }
  if (!row) return null;
  if (!row.revoked_at) {
    db.run("UPDATE devices SET revoked_at = ? WHERE id = ?", [nowISO(), row.id]);
    row.revoked_at = nowISO();
  }
  return row;
}

/** True when the device is gone or revoked: an open session must not outlive its token. */
export function isDeviceRevoked(db: Database, deviceID: string): boolean {
  const row = db.query<{ revoked_at: string | null }, [string]>("SELECT revoked_at FROM devices WHERE id = ?").get(deviceID);
  return !row || row.revoked_at !== null;
}

export function listDevices(db: Database): Device[] {
  return db
    .query<Device, []>(
      "SELECT id, name, created_at, last_seen_at, revoked_at FROM devices ORDER BY created_at ASC",
    )
    .all();
}

// --- browser sessions --------------------------------------------------------

/** The HttpOnly cookie a paired browser carries; its value is a device token. */
export const SESSION_COOKIE = "agni_session";

/** How long a browser keeps the session cookie after its last renewal: 30 days, renewed whenever the page checks in. */
export const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;

/** The session cookie's value, if the request carries one. */
export function cookieToken(request: Request): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === SESSION_COOKIE && value.length > 0) {
      try {
        return decodeURIComponent(value.join("="));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** A device token from `Authorization: Bearer` (Mac, CLI) or the session cookie (browser). */
export function requestToken(request: Request): string | undefined {
  const bearer = /^Bearer (.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  if (bearer) return bearer;
  return cookieToken(request);
}

// 32 symbols, no 0/O/1/I: a byte % 32 is unbiased and the code is easy to type.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const PAIR_CODE_TTL_MS = 10 * 60_000;

/** A one-time pairing code, shown as `ABCD-EFGH`. Only its hash is stored. */
export async function mintPairCode(db: Database, ttlMs = PAIR_CODE_TTL_MS): Promise<string> {
  const raw = Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => CODE_ALPHABET[byte % 32]).join("");
  db.run("DELETE FROM pair_codes WHERE expires_at < ?", [nowISO()]);
  db.run("INSERT INTO pair_codes (code_hash, expires_at) VALUES (?, ?)", [
    await hashToken(raw),
    new Date(Date.now() + ttlMs).toISOString(),
  ]);
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** Spend a pairing code: true once, while it is unexpired; false ever after. */
export async function redeemPairCode(db: Database, code: string): Promise<boolean> {
  const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (normalized.length !== 8) return false;
  const row = db
    .query<{ expires_at: string }, [string]>("DELETE FROM pair_codes WHERE code_hash = ? RETURNING expires_at")
    .get(await hashToken(normalized));
  return row !== null && row.expires_at > nowISO();
}
