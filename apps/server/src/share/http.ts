/**
 * Share links over HTTP.
 *
 *   GET    /share/<token>   the exported thread; whoever holds the link may read it
 *   DELETE /share/<token>   revoke the link; a paired device only
 *
 * A link works for 7 days from publish (see `SHARE_TTL_MS`) and stops working
 * the moment it is revoked. An expired or revoked link answers exactly like one
 * that never existed, so a stale token reveals nothing.
 */
import type { Database } from "bun:sqlite";
import { requestToken, verifyToken } from "../auth/tokens";
import type { OriginPolicy } from "../auth/origin";
import { SHARE_PAGE_HEADERS } from "../ws/csp";
import { readShareFile, revokeShare } from "./document";

export const SHARE_ROUTE = /^\/share\/([0-9a-f]{32})(?:\.html)?$/;

const NOT_FOUND = "This export no longer exists.";

export async function shareRequest(request: Request, db: Database, policy: OriginPolicy): Promise<Response | null> {
  const token = SHARE_ROUTE.exec(new URL(request.url).pathname)?.[1];
  if (!token) return null;

  if (request.method === "DELETE") {
    // A revoke changes state: it needs a paired device and a page we trust.
    const foreign = policy.rejectForeignOrigin(request);
    if (foreign) return foreign;
    const credential = requestToken(request);
    if (!credential || !(await verifyToken(db, credential))) {
      return Response.json({ error: "Pair this device before revoking a link." }, { status: 401, headers: { "cache-control": "no-store" } });
    }
    return revokeShare(token)
      ? Response.json({ ok: true }, { headers: { "cache-control": "no-store" } })
      : Response.json({ error: NOT_FOUND }, { status: 404, headers: { "cache-control": "no-store" } });
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method not allowed", { status: 405, headers: { allow: "GET, HEAD, DELETE" } });
  }
  const html = readShareFile(token);
  if (html === null) return new Response(NOT_FOUND, { status: 404, headers: { "cache-control": "no-store" } });
  return new Response(request.method === "HEAD" ? null : html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...SHARE_PAGE_HEADERS },
  });
}
