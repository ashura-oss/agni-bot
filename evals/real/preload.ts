// Test-only preload for the throwaway eval server (round 5's `preload.ts`, hardened). It does not change product code.
// web_fetch refuses loopback and private hosts (the SSRF guard in tools/fetch-url.ts). To serve fixture pages from the
// local fixture server: (1) the module's `resolver` seam says fixtures.example is a public address, so the guard
// passes; (2) at connect time the pinned lookup for that host is swapped for 127.0.0.1, but only for plain http on the
// fixture server's own port (AGNI_EVAL_FIXTURE_PORT). The fixture host on any other port or scheme, or with no port
// set, is refused, so nothing can use the name to reach another local service or the real address.
import http from "node:http";
import https from "node:https";
import { resolve } from "node:path";
import { FIXTURE_HOST, fixturePortFrom, fixtureRoute } from "./web-fixtures";

// Resolve exactly as the app's own `import "./fetch-url"` does, so the same module instance is patched.
const target = Bun.resolveSync("./fetch-url", resolve(import.meta.dir, "../../apps/server/src/tools"));
const { resolver } = await import(target);
const fixturePort = fixturePortFrom(process.env);

const realLookup = resolver.lookup;
resolver.lookup = async (name: string, opts: unknown) => {
  if (String(name).toLowerCase() === FIXTURE_HOST) {
    if (fixturePort === null) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${name}`), { code: "ENOTFOUND" });
    return [{ address: "93.184.216.34", family: 4 }];
  }
  return (realLookup as (n: string, o: unknown) => unknown)(name, opts);
};

/** Protocol, host name and port of a request's first argument (a URL, a URL string or an options object). */
function targetOf(first: unknown, protocol: "http:" | "https:"): { protocol: string; hostname: string; port: string } {
  const fallback = protocol === "https:" ? "443" : "80";
  if (first instanceof URL || typeof first === "string") {
    const u = new URL(String(first));
    return { protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === "https:" ? "443" : "80") };
  }
  const o = (first ?? {}) as { protocol?: string; hostname?: string; host?: string; port?: number | string };
  return { protocol: o.protocol ?? protocol, hostname: String(o.hostname ?? o.host ?? "").replace(/:\d+$/, ""), port: String(o.port ?? fallback) };
}

function patch(mod: typeof http | typeof https, protocol: "http:" | "https:"): void {
  const original = mod.request.bind(mod) as (...args: unknown[]) => unknown;
  (mod as unknown as { request: unknown }).request = (first: unknown, opts: any, cb: any) => {
    let route: "local" | "refuse" | "pass";
    try {
      route = fixtureRoute(targetOf(first, protocol), fixturePort);
    } catch {
      // Unreadable target: refuse it if it names the fixture host at all.
      route = String(first).toLowerCase().includes(FIXTURE_HOST) ? "refuse" : "pass";
    }
    if (route === "refuse") throw new Error(`eval preload: refused a request to ${FIXTURE_HOST} outside the fixture server`);
    if (route === "local") {
      opts = {
        ...(opts ?? {}),
        lookup: (_h: string, o: any, c: any) => (o?.all ? c(null, [{ address: "127.0.0.1", family: 4 }]) : c(null, "127.0.0.1", 4)),
      };
    }
    return original(first, opts, cb);
  };
}
patch(http, "http:");
patch(https, "https:");
console.error(`[eval preload] ${FIXTURE_HOST}:${fixturePort ?? "(none)"} -> 127.0.0.1 for web_fetch; other ports and schemes refused`);
