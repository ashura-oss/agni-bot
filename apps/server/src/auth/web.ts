/**
 * Browser pairing over HTTP, so the web app never sees a token:
 *
 *   POST /auth/pair     {code, name}  spend a one-time code, set the session cookie
 *   GET  /auth/session                is this browser's cookie a live device?
 *   POST /auth/logout                 revoke this browser's device, clear the cookie
 *
 * The cookie is HttpOnly + SameSite=Strict, and POSTs must come from an
 * allowed origin, so another site can neither read nor ride the session.
 * It lasts 30 days and slides: `/auth/session` (which the app calls on every
 * load) sends it again with a fresh lifetime, so a browser in regular use
 * stays paired and an abandoned one expires. Pairing attempts are limited per
 * address (see `PairLimiter`), whatever the code turns out to be.
 */
import type { Database } from "bun:sqlite";
import { purgeRevokedQueues } from "../ws/dispatch";
import { cancelTurnsForDevice } from "../ws/turn-registry";
import type { PairLimiter } from "./rate-limit";
import { cookieToken, mintToken, redeemPairCode, requestToken, revokeDevice, SESSION_COOKIE, SESSION_MAX_AGE_S, verifyToken } from "./tokens";

export interface AuthOptions {
  /** Who is asking, for the pairing limit (the peer address; see `clientAddress` in the server). */
  clientKey?: string;
  /** Left out, pairing is not limited (a unit test of the route alone). */
  pairLimiter?: PairLimiter;
  /** `AGNI_PUBLIC_ORIGIN`: an https public origin makes the cookie Secure when it is reached by that name. */
  publicOrigin?: string | undefined;
}

/** Is this request arriving over https (directly, through a proxy, or by the public https name)? */
function overHttps(request: Request, publicOrigin: string | undefined): boolean {
  if (request.headers.get("origin")?.startsWith("https:")) return true;
  if (request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https") return true;
  if (!publicOrigin?.startsWith("https:")) return false;
  try {
    return request.headers.get("host")?.toLowerCase() === new URL(publicOrigin).host.toLowerCase();
  } catch {
    return false;
  }
}

export async function authRequest(
  request: Request,
  db: Database,
  originAllowed: (origin: string) => boolean,
  options: AuthOptions = {},
): Promise<Response> {
  const { pathname } = new URL(request.url);
  const reply = (data: unknown, status = 200, cookie?: string) =>
    Response.json(data, {
      status,
      headers: { "cache-control": "no-store", ...(cookie ? { "set-cookie": cookie } : {}) },
    });

  const cookie = (value: string, maxAge: number) =>
    `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${overHttps(request, options.publicOrigin) ? "; Secure" : ""}`;

  if (pathname === "/auth/session" && request.method === "GET") {
    const token = requestToken(request);
    const device = token ? await verifyToken(db, token) : null;
    if (!device) return reply({ paired: false });
    // Sliding renewal: a browser whose cookie got it here gets the cookie again with a fresh 30 days.
    // A native client's bearer token has no cookie to renew.
    const cookieValue = cookieToken(request);
    return reply({ paired: true, deviceName: device.name }, 200, cookieValue !== undefined && cookieValue === token ? cookie(cookieValue, SESSION_MAX_AGE_S) : undefined);
  }
  if (request.method !== "POST" || (pathname !== "/auth/pair" && pathname !== "/auth/logout")) {
    return reply({ error: "not found" }, 404);
  }
  const origin = request.headers.get("origin");
  if (origin === null || !originAllowed(origin)) return reply({ error: "forbidden origin" }, 403);

  if (pathname === "/auth/pair") {
    const allowed = options.pairLimiter?.attempt(options.clientKey ?? "unknown");
    if (allowed && !allowed.ok) {
      const retryAfter = Math.ceil(allowed.retryAfterMs / 1000);
      return Response.json(
        { error: `Too many pairing attempts. Wait ${retryAfter} second${retryAfter === 1 ? "" : "s"} and try again.` },
        { status: 429, headers: { "cache-control": "no-store", "retry-after": String(retryAfter) } },
      );
    }
    const body = (await request.json().catch(() => null)) as { code?: unknown; name?: unknown } | null;
    if (typeof body?.code !== "string" || !(await redeemPairCode(db, body.code))) {
      return reply({ error: "That code is wrong or expired. Run `agni open` on the server for a new one." }, 401);
    }
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 64) : "Browser";
    const { device, token } = await mintToken(db, name);
    return reply({ paired: true, deviceName: device.name }, 200, cookie(token, SESSION_MAX_AGE_S));
  }

  const token = requestToken(request);
  const device = token ? await verifyToken(db, token) : null;
  if (device) {
    revokeDevice(db, device.id);
    // Turns outlive their sockets: logging out must stop what this device started,
    // and its queued messages must not run once the turn ends.
    purgeRevokedQueues(db);
    cancelTurnsForDevice(device.id);
  }
  return reply({ paired: false }, 200, cookie("", 0));
}
