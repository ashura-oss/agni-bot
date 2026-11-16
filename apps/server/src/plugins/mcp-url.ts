/**
 * Where an MCP server may live (S3-06). The owner types the URL, but a URL that
 * reaches the cloud metadata service, the daemon's own loopback services or the
 * home network is a way to make the daemon fetch things on the owner's behalf
 * that the owner never meant to expose, and DNS can change after the owner
 * looked. So:
 *
 *  - https only; http is accepted for a loopback host (a local dev server).
 *  - no credentials in the URL (the bearer token has its own field).
 *  - the host is resolved and every answer must be public: no private, loopback,
 *    link-local, CGNAT, metadata or reserved address. Unless the owner flagged
 *    the plugin `"local": true` in plugins.json, which lifts only this address check.
 *  - the check runs again at every connect, and the transport's fetch runs it
 *    again before every request, so a name that starts resolving somewhere else
 *    is stopped.
 *  - the transport never follows a redirect: a 3xx from an MCP server is an error
 *    (no MCP server needs one, and a Location is the server's choice of where the
 *    daemon, and the owner's bearer token, goes next).
 *  - the connection is pinned: the name is resolved once per request, every answer
 *    is checked, and the socket is opened to one of those checked addresses (the
 *    original Host header and, for https, the original name for SNI and certificate
 *    verification are kept), so a resolver that changes its answer between the
 *    check and the connect has nothing to change. Verified on Bun 1.4.3:
 *    `node:https` honours the `lookup` option and still verifies the certificate
 *    against the URL's host name. When a test injects its own `fetch` there is no
 *    socket of ours to pin; the per-request check is all that remains there.
 */
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { isPrivateAddress, resolver } from "../tools/fetch-url";

export type Lookup = (host: string) => Promise<string[]>;

/** Public addresses of cloud metadata services that `isPrivateAddress` does not already cover. */
const METADATA_ADDRESSES = new Set(["168.63.129.16"]);

const defaultLookup: Lookup = async (host) => (await resolver.lookup(host, { all: true, verbatim: true })).map(({ address }) => address);

function bareHost(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function isLoopbackHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
  return isIP(host) === 4 && host.startsWith("127.");
}

/** What is wrong with the URL before any lookup, or undefined. */
export function mcpUrlShapeError(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "The MCP server URL is not a valid URL.";
  }
  if (url.username || url.password) return "The MCP server URL must not contain credentials; put the token in its own field.";
  if (url.protocol === "https:") return undefined;
  if (url.protocol === "http:" && isLoopbackHost(bareHost(url))) return undefined;
  return "MCP server URLs must use https (http is accepted only for a loopback address).";
}

/** Throws unless `raw` is an acceptable MCP server URL right now. */
export async function checkMcpUrl(raw: string, options: { local?: boolean; lookup?: Lookup } = {}): Promise<void> {
  const shape = mcpUrlShapeError(raw);
  if (shape) throw new Error(shape);
  if (options.local === true) return;
  await checkedAddresses(raw, options);
}

/**
 * Resolve the URL's host once and return the addresses a connection may use. Every
 * answer must be public unless the owner flagged the plugin `local`, which lifts only
 * the address check (the name is still resolved, so the connection can be pinned to
 * the answers). An IP literal is its own answer and needs no lookup.
 */
async function checkedAddresses(raw: string, options: { local?: boolean; lookup?: Lookup }): Promise<string[]> {
  const host = bareHost(new URL(raw));
  const local = options.local === true;
  if (!local && (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal"))) {
    throw new Error(`MCP server host ${host} is a private host; flag the plugin "local": true in plugins.json to allow it`);
  }
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else {
    try {
      addresses = await (options.lookup ?? defaultLookup)(host);
    } catch (error) {
      throw new Error(`could not resolve MCP server host ${host}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (addresses.length === 0) throw new Error(`could not resolve MCP server host ${host}`);
  if (!local && addresses.some((address) => isPrivateAddress(address) || METADATA_ADDRESSES.has(address))) {
    throw new Error(`MCP server host ${host} is a private or reserved address; flag the plugin "local": true in plugins.json to allow it`);
  }
  return addresses;
}

/** Why a redirect is refused. The Location is not repeated: it is the server's text and may carry a secret. */
function redirectRefusal(status: number): Error {
  return new Error(`the MCP server answered with a redirect (HTTP ${status}); redirects are refused, so configure the server's final URL`);
}

/**
 * The transport's fetch. Before every request the URL is checked and its host resolved
 * once; the request is then sent over a socket pinned to those checked addresses, and
 * any 3xx answer is an error. `options.fetch` replaces the socket (tests only): it is
 * still called with `redirect: "manual"` and its 3xx answers are still refused.
 */
export function guardedFetch(options: { local?: boolean; lookup?: Lookup; fetch?: typeof fetch } = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const shape = mcpUrlShapeError(url);
    if (shape) throw new Error(shape);
    const addresses = await checkedAddresses(url, { ...(options.local === undefined ? {} : { local: options.local }), ...(options.lookup ? { lookup: options.lookup } : {}) });
    const response = options.fetch
      ? await options.fetch(input as never, { ...init, redirect: "manual" })
      : await pinnedRequest(new URL(url), addresses, input, init);
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      throw redirectRefusal(response.status);
    }
    return response;
  }) as typeof fetch;
}

/** The body kinds the MCP transport sends (JSON text); anything else is a bug here, not something to guess at. */
async function bodyBytes(input: string | URL | Request, init: RequestInit | undefined): Promise<Buffer | undefined> {
  const body = init?.body ?? undefined;
  if (body === undefined) {
    if (input instanceof Request && input.method !== "GET" && input.method !== "HEAD") return Buffer.from(await input.arrayBuffer());
    return undefined;
  }
  if (typeof body === "string") return Buffer.from(body, "utf-8");
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), "utf-8");
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new Error("the MCP transport sent a request body of a kind the pinned connection does not support");
}

/**
 * One HTTP request to `url` over a socket opened only to `addresses` (already checked).
 * The Host header, SNI and certificate verification still use the URL's own host name.
 * Redirects are returned as they are; the caller refuses them. The response body streams.
 */
function pinnedRequest(url: URL, addresses: string[], input: string | URL | Request, init: RequestInit | undefined): Promise<Response> {
  const pinned = addresses.map((address) => ({ address, family: isIP(address) }));
  const lookupPinned = (_host: string, opts: { all?: boolean }, cb: (...args: unknown[]) => void) =>
    opts?.all ? cb(null, pinned) : cb(null, pinned[0]!.address, pinned[0]!.family);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
  if (!headers.has("accept-encoding")) headers.set("accept-encoding", "identity");
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const mod = url.protocol === "https:" ? https : http;
  return bodyBytes(input, init).then(
    (body) =>
      new Promise<Response>((resolve, reject) => {
        if (body && !headers.has("content-length")) headers.set("content-length", String(body.byteLength));
        const request = mod.request(url, {
          method,
          headers: Object.fromEntries(headers.entries()),
          lookup: lookupPinned as never,
          ...(signal ? { signal } : {}),
        }, (res) => {
          const out = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (value === undefined) continue;
            if (Array.isArray(value)) for (const item of value) out.append(name, item);
            else out.set(name, value);
          }
          const status = res.statusCode ?? 502;
          const nullBody = method === "HEAD" || status < 200 || status === 204 || status === 205 || status === 304;
          if (nullBody) res.resume();
          resolve(new Response(nullBody ? null : (Readable.toWeb(res) as unknown as ReadableStream), { status, headers: out }));
        });
        request.on("error", reject);
        request.end(body);
      }),
  );
}

/**
 * The owner's `"local": true` on a plugin's entry in plugins.json, read from the
 * file itself each time (the file is the authority, as for `trustedTools`).
 * Only the literal `true` counts; a missing or unreadable file means not local.
 */
export function readLocalFlag(pluginsPath: string, pluginID: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(pluginsPath, "utf-8")) as { plugins?: Record<string, { local?: unknown }> };
    return parsed.plugins?.[pluginID]?.local === true;
  } catch {
    return false;
  }
}
