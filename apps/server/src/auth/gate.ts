/**
 * The paired-device check for HTTP routes, run once per request.
 *
 * `requestDevice` remembers its answer for the request it was asked about, so
 * the server's gate and a handler's own check cost one hash and one database
 * write between them, not two.
 */
import type { Database } from "bun:sqlite";
import type { OriginPolicy } from "./origin";
import { routeAccess, unpairedMessage } from "./route-access";
import { requestToken, verifyToken, type Device } from "./tokens";

const answers = new WeakMap<Request, Promise<Device | null>>();

/** The device this request belongs to (bearer token or session cookie), or null. */
export function requestDevice(request: Request, db: Database): Promise<Device | null> {
  let answer = answers.get(request);
  if (!answer) {
    const token = requestToken(request);
    answer = token ? verifyToken(db, token) : Promise.resolve(null);
    answers.set(request, answer);
  }
  return answer;
}

/**
 * Null when the request may continue; otherwise the refusal. Order matters and
 * matches the handlers: a foreign page gets 403 whatever it carries, a CORS
 * preflight goes to the handler (it cannot carry credentials), and only then
 * is a device required.
 */
export async function gateDevice(request: Request, db: Database, policy: OriginPolicy): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (routeAccess(request.method, pathname) !== "device") return null;
  const foreign = policy.rejectForeignOrigin(request);
  if (foreign) return foreign;
  if (request.method === "OPTIONS") return null;
  if (await requestDevice(request, db)) return null;
  return Response.json({ error: unpairedMessage(pathname) }, { status: 401, headers: { "cache-control": "no-store" } });
}
