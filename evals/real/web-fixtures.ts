/**
 * The fixture web server: serves `<root>/<ep>/<path>.html` at
 * `http://fixtures.example:<port>/<ep>/<path>`. The episode server reaches it
 * through `preload.ts`, which sends that one host name, on that one port, to
 * 127.0.0.1 and refuses it on any other port or scheme (`fixtureRoute`).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

export const FIXTURE_HOST = "fixtures.example";
/** The environment variable that tells the episode server's preload the fixture server's port. */
export const FIXTURE_PORT_ENV = "AGNI_EVAL_FIXTURE_PORT";

export interface WebFixtures {
  root: string;
  port: number;
  /** Every path asked for, with its query, in order. */
  hits: string[];
  baseFor(ep: string): string;
  stop(): void;
}

/** The fixture port from an environment, or null when it is missing or not a port number. */
export function fixturePortFrom(env: Record<string, string | undefined>): number | null {
  const n = Number(env[FIXTURE_PORT_ENV]);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

/**
 * What the preload does with an outgoing request: `local` (serve it from the fixture server on 127.0.0.1),
 * `refuse`, or `pass` (not the fixture host: leave it alone). Only plain http to the fixture host on the
 * fixture port is local; the fixture host on any other port or scheme, or with no fixture port known, is refused.
 */
export function fixtureRoute(target: { protocol: string; hostname: string; port: string }, fixturePort: number | null): "local" | "refuse" | "pass" {
  if (target.hostname.toLowerCase() !== FIXTURE_HOST) return "pass";
  if (fixturePort === null || target.protocol !== "http:") return "refuse";
  return target.port === String(fixturePort) ? "local" : "refuse";
}

/** The file a request path names, or null when it is not a plain page inside `root`. */
export function fixtureFile(root: string, pathname: string): string | null {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname).replace(/^\/+/, "");
  } catch {
    return null;
  }
  // No backslash (a Windows separator), colon (a drive or a stream) or NUL, and no empty or `..` segment.
  if (rel === "" || /[\\:\0]/.test(rel) || rel.split("/").some((part) => part === ".." || part === "")) return null;
  const rootFull = resolve(root);
  const file = resolve(rootFull, `${rel}.html`);
  return file.startsWith(rootFull + sep) ? file : null;
}

export function startWebFixtures(root: string): WebFixtures {
  const hits: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      hits.push(url.pathname + url.search);
      const file = fixtureFile(root, url.pathname);
      if (file === null || !existsSync(file)) return new Response("not found", { status: 404 });
      return new Response(readFileSync(file), { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  const port = server.port!;
  return { root, port, hits, baseFor: (ep) => `http://${FIXTURE_HOST}:${port}/${ep}`, stop: () => { void server.stop(true); } };
}
