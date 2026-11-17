/**
 * The fixture web server: serves `<root>/<ep>/<path>.html` at
 * `http://fixtures.example:<port>/<ep>/<path>`. The episode server reaches it
 * through `preload.ts`, which points that one host name at 127.0.0.1.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const FIXTURE_HOST = "fixtures.example";

export interface WebFixtures {
  root: string;
  port: number;
  /** Every path asked for, with its query, in order. */
  hits: string[];
  baseFor(ep: string): string;
  stop(): void;
}

export function startWebFixtures(root: string): WebFixtures {
  const hits: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      hits.push(url.pathname + url.search);
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      if (rel === "" || rel.split("/").some((part) => part === ".." || part === "")) return new Response("not found", { status: 404 });
      const file = join(root, `${rel}.html`);
      if (!existsSync(file)) return new Response("not found", { status: 404 });
      return new Response(readFileSync(file), { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  const port = server.port!;
  return { root, port, hits, baseFor: (ep) => `http://${FIXTURE_HOST}:${port}/${ep}`, stop: () => { void server.stop(true); } };
}
