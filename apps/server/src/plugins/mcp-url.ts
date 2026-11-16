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
 *
 * Residual risk, by design: the check and the connection each resolve the name,
 * so a resolver that answers differently within milliseconds could still win
 * the race. Pinning the connection to the checked address would need a
 * streaming-capable pinned transport; not built here.
 */
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
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
  const host = bareHost(new URL(raw));
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
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
  if (addresses.some((address) => isPrivateAddress(address) || METADATA_ADDRESSES.has(address))) {
    throw new Error(`MCP server host ${host} is a private or reserved address; flag the plugin "local": true in plugins.json to allow it`);
  }
}

/**
 * A fetch for the MCP transport that runs the URL check before every request.
 * Redirects are left to the transport, which by default follows only same-origin ones.
 */
export function guardedFetch(options: { local?: boolean; lookup?: Lookup; fetch?: typeof fetch } = {}): typeof fetch {
  const inner = options.fetch ?? fetch;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    await checkMcpUrl(url, { ...(options.local === undefined ? {} : { local: options.local }), ...(options.lookup ? { lookup: options.lookup } : {}) });
    return inner(input as never, init);
  }) as typeof fetch;
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

/**
 * Copy each entry's `local` flag from the file on disk into the in-memory config, so
 * a later save writes the owner's current choice back. Without this, removing the
 * flag by hand would be undone by the next save from stale memory.
 */
export function syncLocalFlags(pluginsPath: string, config: { plugins: Record<string, object> }): void {
  let onDisk: { plugins?: Record<string, { local?: unknown }> };
  try {
    onDisk = JSON.parse(readFileSync(pluginsPath, "utf-8"));
  } catch {
    return;
  }
  if (!onDisk?.plugins || typeof onDisk.plugins !== "object") return;
  for (const [id, entry] of Object.entries(config.plugins)) {
    if (onDisk.plugins[id]?.local === true) (entry as { local?: boolean }).local = true;
    else delete (entry as { local?: boolean }).local;
  }
}
