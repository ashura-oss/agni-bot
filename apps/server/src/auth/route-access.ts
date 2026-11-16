/**
 * Which HTTP routes need a paired device (S3-05).
 *
 * One table, read by the server before any route handler runs, so a route is
 * protected by default and a handler that forgets its own check is still behind
 * the gate. Public means one of:
 *
 *   - the app shell: any GET or HEAD that falls through every other route
 *     (index.html and its assets, and the client-side routes such as /group);
 *   - pairing: `/auth/*` (a browser cannot hold a device before it pairs);
 *   - `/health`: a liveness answer; the full report asks for a device itself;
 *   - `/ws`: the upgrade; the `hello` frame (or the session cookie) authenticates;
 *   - `/oauth/callback`: the redirect from the identity provider, bound to a
 *     single-use `state` the server issued;
 *   - `GET /share/<token>`: the link is the credential (revoke needs a device).
 *
 * Everything else that is not a GET/HEAD falls through to a plain 404.
 */
import { SHARE_ROUTE } from "../share/route";

export type RouteAccess = "public" | "device";

/** Prefixes that serve the owner's data, with what an unpaired caller is told. */
const DEVICE_ROUTES: ReadonlyArray<{ prefix: string; exact: boolean; message: string }> = [
  { prefix: "/attachments", exact: true, message: "Pair this device before uploading or opening files." },
  { prefix: "/backgrounds", exact: true, message: "Pair this device before changing appearance." },
  { prefix: "/debug/", exact: false, message: "Pair this device first." },
];

const SHARE_REVOKE_MESSAGE = "Pair this device before revoking a link.";

/** The paths a request could mean: as sent, and with dot-segments and percent-escapes resolved. */
function candidates(pathname: string): string[] {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // keep the raw path
  }
  const segments: string[] = [];
  for (const part of decoded.split("/")) {
    if (part === "..") segments.pop();
    else if (part !== "." && part !== "") segments.push(part);
  }
  return [...new Set([pathname, decoded, `/${segments.join("/")}`])];
}

function matchDeviceRoute(pathname: string): { message: string } | null {
  for (const path of candidates(pathname)) {
    for (const route of DEVICE_ROUTES) {
      const hit = route.exact ? path === route.prefix || path.startsWith(`${route.prefix}/`) : path.startsWith(route.prefix);
      if (hit) return { message: route.message };
    }
  }
  return null;
}

export function routeAccess(method: string, pathname: string): RouteAccess {
  if (SHARE_ROUTE.test(pathname)) return method === "GET" || method === "HEAD" ? "public" : "device";
  return matchDeviceRoute(pathname) ? "device" : "public";
}

/** What to tell an unpaired caller of a device route. */
export function unpairedMessage(pathname: string): string {
  if (SHARE_ROUTE.test(pathname)) return SHARE_REVOKE_MESSAGE;
  return matchDeviceRoute(pathname)?.message ?? "Pair this device first.";
}
