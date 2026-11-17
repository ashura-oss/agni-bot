// Test-only preload for the throwaway eval server (round 5's `preload.ts`). It does not change product code.
// web_fetch refuses loopback and private hosts (the SSRF guard in tools/fetch-url.ts). To serve fixture pages
// from a local server: (1) the module's `resolver` seam says fixtures.example is a public address, so the guard
// passes; (2) at connect time the pinned lookup for that one host is swapped for 127.0.0.1.
import http from "node:http";
import { resolve } from "node:path";

// Resolve exactly as the app's own `import "./fetch-url"` does, so the same module instance is patched.
const target = Bun.resolveSync("./fetch-url", resolve(import.meta.dir, "../../apps/server/src/tools"));
const { resolver } = await import(target);

const HOST = "fixtures.example";
const realLookup = resolver.lookup;
resolver.lookup = async (name: string, opts: unknown) => {
  if (String(name).toLowerCase() === HOST) return [{ address: "93.184.216.34", family: 4 }];
  return (realLookup as (n: string, o: unknown) => unknown)(name, opts);
};
const originalRequest = http.request.bind(http) as (...args: unknown[]) => unknown;
(http as unknown as { request: unknown }).request = (url: any, opts: any, cb: any) => {
  try {
    const host = typeof url === "string" ? new URL(url).hostname : url?.hostname;
    if (host === HOST) {
      opts = {
        ...(opts ?? {}),
        lookup: (_h: string, o: any, c: any) => (o?.all ? c(null, [{ address: "127.0.0.1", family: 4 }]) : c(null, "127.0.0.1", 4)),
      };
    }
  } catch {
    // fall through to the real request
  }
  return originalRequest(url, opts, cb);
};
console.error("[eval preload] fixtures.example -> 127.0.0.1 for web_fetch");
