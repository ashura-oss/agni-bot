/**
 * Web Push (RFC 8030/8291/8292) for the web client. Encryption and VAPID
 * signing come from the `web-push` package (verified to run under Bun); the
 * request itself goes out through fetch. The VAPID private key lives in
 * AGNI_HOME, mode 600, never in the repo. The server only calls out to the
 * browsers' push services; nothing new listens.
 *
 * Not built: APNs for the Mac app (needs an Apple key).
 */
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname } from "node:path";
import webpush from "web-push";
import { homePath } from "../home";
import { log } from "../log";
import { allowPush } from "../stores/proactivity";
import { nowISO } from "../util/ids";
import { writePrivateFileSync } from "../util/private-file";
import { assertPublicHost, isPrivateAddress } from "../tools/fetch-url";

export interface VapidKeys { publicKey: string; privateKey: string }
export interface PushPayload { title: string; body: string; threadID?: string }
export interface PushSubscriptionRow { endpoint: string; device_id: string; p256dh: string; auth: string }

/** Read the keypair, generating it once. `path` ":memory:" keeps it in memory (tests). */
export function loadVapid(path = homePath("push-vapid.json")): VapidKeys {
  if (path !== ":memory:" && existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as VapidKeys;
  const keys = webpush.generateVAPIDKeys();
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
    // The private key is a credential: owner-only before it is written
    // (mode 600, or an owner-only ACL on Windows). If that cannot be done, throw
    // rather than store it readable.
    writePrivateFileSync(path, JSON.stringify(keys));
  }
  return keys;
}

export function saveSubscription(db: Database, deviceId: string, sub: { endpoint: string; keys: { p256dh: string; auth: string } }): void {
  db.run(
    `INSERT INTO push_subscriptions (endpoint, device_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET device_id = excluded.device_id, p256dh = excluded.p256dh, auth = excluded.auth`,
    [sub.endpoint, deviceId, sub.keys.p256dh, sub.keys.auth, nowISO()],
  );
}

export function removeSubscription(db: Database, endpoint: string): void {
  db.run("DELETE FROM push_subscriptions WHERE endpoint = ?", [endpoint]);
}

export type PushSender = (url: string, init: { method: string; headers: Record<string, string>; body: Uint8Array }) => Promise<{ status: number }>;

/** Host names that are on the machine's own network by their shape. */
const LOCAL_NAME = /(^|\.)(localhost|local|internal|lan|home|corp|intranet)$/;

/**
 * Why a push endpoint may not be posted to, judged from the address alone (no lookup), or null. The server POSTs
 * to this address, so it must be https on the default port, with no credentials, at a named public host or a
 * public IP: never a loopback, private, link-local or reserved address, and never a name that is on the local
 * network by its shape (no dot, `.local`, `.internal`, `localhost`).
 */
export function pushEndpointProblem(endpoint: string): string | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return "the endpoint is not an address";
  }
  if (url.protocol !== "https:") return "the endpoint must be https";
  if (url.username || url.password) return "the endpoint must not carry credentials";
  if (url.port !== "" && url.port !== "443") return "the endpoint must use the default https port";
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (host === "") return "the endpoint has no host";
  if (isIP(host)) return isPrivateAddress(host) ? "the endpoint is a private or reserved address" : null;
  if (!host.includes(".") || LOCAL_NAME.test(host)) return "the endpoint is a name on the local network";
  return null;
}

/** The address check for a push about to be sent: the shape check, then every address the name resolves to. */
export async function assertPublicPushEndpoint(endpoint: string): Promise<void> {
  const problem = pushEndpointProblem(endpoint);
  if (problem) throw new Error(problem);
  await assertPublicHost(new URL(endpoint).hostname);
}

/** A key the push service gave the browser: base64url of exactly this many bytes. */
function keyLengthProblem(name: string, value: string, bytes: number): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return `${name} is not base64url`;
  return Buffer.from(value, "base64url").length === bytes ? null : `${name} has the wrong length`;
}

/** Why a subscription is not accepted (a bad endpoint, or keys of the wrong shape), or null. */
export function subscriptionProblem(sub: { endpoint: string; keys: { p256dh: string; auth: string } }): string | null {
  return pushEndpointProblem(sub.endpoint) ?? keyLengthProblem("p256dh", sub.keys.p256dh, 65) ?? keyLengthProblem("auth", sub.keys.auth, 16);
}

/**
 * The real sender. The address is checked again just before the request (a name can start to resolve somewhere
 * private after it was saved), and a redirect is an error: the push service answers the one address that was
 * checked, never another.
 */
export function createFetchSender(options: { checkEndpoint?: (endpoint: string) => Promise<void> } = {}): PushSender {
  const check = options.checkEndpoint ?? assertPublicPushEndpoint;
  return async (url, init) => {
    await check(url);
    return fetch(url, { ...init, signal: AbortSignal.timeout(10_000), redirect: "error" });
  };
}

const fetchSender: PushSender = createFetchSender();

export class PushService {
  private keys: VapidKeys | undefined;
  constructor(
    private readonly db: Database,
    private readonly opts: { vapidPath?: string; timeZone?: string; send?: PushSender; subject?: string } = {},
  ) {}

  publicKey(): string {
    this.keys ??= loadVapid(this.opts.vapidPath);
    return this.keys.publicKey;
  }

  /**
   * Push a notify to every subscribed device that has no live socket. A
   * proactive notify (one with an agentId) first passes that bot's quiet hours
   * and daily cap. Dead subscriptions (404/410) are dropped.
   */
  async notify(body: PushPayload & { agentId?: string }, connectedDeviceIds: ReadonlySet<string>, now = new Date()): Promise<number> {
    const subs = this.db
      .query<PushSubscriptionRow, []>("SELECT endpoint, device_id, p256dh, auth FROM push_subscriptions")
      .all()
      .filter((s) => !connectedDeviceIds.has(s.device_id));
    if (subs.length === 0) return 0;
    if (body.agentId && !allowPush(this.db, body.agentId, now, this.opts.timeZone)) return 0;
    this.publicKey();
    const payload = JSON.stringify({ title: body.title, body: body.body, threadID: body.threadID });
    const send = this.opts.send ?? fetchSender;
    let sent = 0;
    await Promise.all(subs.map(async (s) => {
      try {
        const d = webpush.generateRequestDetails(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload,
          { vapidDetails: { subject: this.opts.subject ?? "mailto:agni@localhost.invalid", ...this.keys! }, TTL: 3600 },
        );
        const res = await send(d.endpoint, { method: d.method, headers: d.headers as Record<string, string>, body: d.body as Uint8Array });
        if (res.status === 404 || res.status === 410) removeSubscription(this.db, s.endpoint);
        else if (res.status >= 200 && res.status < 300) sent += 1;
        else log.warn(`web push to ${new URL(s.endpoint).host} answered ${res.status}`);
      } catch (error) {
        log.warn(`web push failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));
    return sent;
  }
}
