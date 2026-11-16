/**
 * Sprint 2 security round, item 4: a call that carries a credential or a private request never follows a
 * redirect. Each test points the call at a loopback server that answers 3xx towards a second loopback
 * server; the second server must see nothing, and the call must fail (or answer nothing) instead.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { embedText } from "../src/agent/embeddings";
import type { Config } from "../src/config";
import { fetchHealth } from "../src/daemon";
import { ProviderError, streamChat } from "../src/models/client";
import { HealthTracker } from "../src/models/health";
import { Router } from "../src/models/router";
import { createFetchSender } from "../src/push/web-push";
import { createGoogleTools } from "../src/tools/google";

interface Hit { url: string; method: string; authorization: string | null; body: string }
const stops: Array<() => void> = [];
afterEach(() => { while (stops.length) stops.pop()!(); });

/** A server that answers every request with a redirect to a second server, which records what reaches it. */
function redirectPair(status = 307): { base: string; reached: Hit[]; redirected: Hit[] } {
  const reached: Hit[] = [];
  const redirected: Hit[] = [];
  const record = async (into: Hit[], req: Request): Promise<void> => {
    into.push({ url: req.url, method: req.method, authorization: req.headers.get("authorization"), body: await req.text() });
  };
  const target = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) { await record(reached, req); return Response.json({ data: [{ id: "stolen-model", embedding: [1, 2, 3] }], ok: true, items: [] }); },
  });
  const redirector = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) { await record(redirected, req); return new Response(null, { status, headers: { location: `http://127.0.0.1:${target.port}/elsewhere` } }); },
  });
  stops.push(() => { target.stop(true); redirector.stop(true); });
  return { base: `http://127.0.0.1:${redirector.port}`, reached, redirected };
}

describe("a model call does not follow a redirect", () => {
  test("a chat request with the provider key stops at the redirect", async () => {
    const { base, reached, redirected } = redirectPair();
    const error = await streamChat({
      baseUrl: base, apiKey: "sk-secret", model: "m", messages: [{ role: "user", content: "hi" }],
      firstTokenTimeoutMs: 3_000, onDelta: () => undefined,
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect(redirected).toHaveLength(1);
    expect(reached).toHaveLength(0);
  });

  test("the model list request with the provider key stops at the redirect", async () => {
    const { base, reached, redirected } = redirectPair(302);
    const router = new Router([{ id: "p", label: "P", baseUrl: base, apiKey: "sk-secret", model: "m" }], new HealthTracker());
    await expect(router.listModels("p")).rejects.toThrow();
    expect(redirected).toHaveLength(1);
    expect(reached).toHaveLength(0);
  });

  test("an embedding request stops at the redirect and answers nothing", async () => {
    const { base, reached, redirected } = redirectPair();
    const vector = await embedText("some memory text", { baseURL: base, model: "e", kind: "openai", timeoutMs: 3_000 });
    expect(vector).toBeNull();
    expect(redirected).toHaveLength(1);
    expect(reached).toHaveLength(0);
  });
});

describe("the local health check does not carry the device token across a redirect", () => {
  test("a redirect from the health address ends the check, and the second address sees nothing", async () => {
    const { base, reached, redirected } = redirectPair(302);
    const port = Number(new URL(base).port);
    const health = await fetchHealth({ host: "127.0.0.1", port } as Config, 3_000, { AGNI_TOKEN: "device-token" });
    expect(health).toBeNull();
    expect(redirected[0]!.authorization).toBe("Bearer device-token");
    expect(reached).toHaveLength(0);
  });
});

describe("Google calls do not follow a redirect", () => {
  const pluginsFile = (): string => {
    const path = join(mkdtempSync(join(tmpdir(), "agni-sec-google-")), "plugins.json");
    writeFileSync(path, JSON.stringify({
      version: 1, oauthClients: { google: { clientID: "c", clientSecret: "s" } },
      plugins: {
        calendar: { account: "agent", enabled: true, auth: { kind: "oauth", access_token: "tok", expires_at: Date.now() + 3_600_000 } },
        drive: { account: "owner", enabled: true, auth: { kind: "oauth", access_token: "tok", expires_at: Date.now() + 3_600_000 } },
      },
    }));
    return path;
  };

  test("a calendar read with the owner's token stops at the redirect", async () => {
    const { base, reached, redirected } = redirectPair(302);
    const toLoopback = ((url: string | URL | Request, init?: RequestInit) => fetch(String(url).replace("https://www.googleapis.com", base), init)) as typeof fetch;
    const tools = createGoogleTools(pluginsFile(), toLoopback);
    const list = tools.find((tool) => tool.name === "calendar_list")!;
    const out = await list.handler({ timeMin: "2026-11-01T00:00:00Z", timeMax: "2026-11-02T00:00:00Z" }, {} as never);
    expect(out.error).toBeTruthy();
    expect(redirected).toHaveLength(1);
    expect(reached).toHaveLength(0);
  });

  test("an event id and a file id are sent as one path part", async () => {
    const urls: string[] = [];
    const recorder = (async (url: string | URL | Request) => { urls.push(String(url)); return Response.json({ id: "e", name: "n", mimeType: "text/plain", size: "1" }); }) as typeof fetch;
    const tools = createGoogleTools(pluginsFile(), recorder);
    await tools.find((tool) => tool.name === "calendar_update")!.handler({ eventId: "ev_1-a" }, {} as never);
    await tools.find((tool) => tool.name === "drive_read")!.handler({ fileId: "file_1-a" }, {} as never);
    expect(urls[0]).toEndWith("/events/ev_1-a");
    expect(urls[1]).toContain("/files/file_1-a?");
  });
});

describe("a push delivery does not follow a redirect", () => {
  test("the sender stops at the redirect and the second address sees nothing", async () => {
    const { base, reached, redirected } = redirectPair(307);
    // The address check is a separate step (see the endpoint tests); this one is about the request itself.
    const send = createFetchSender({ checkEndpoint: async () => undefined });
    await expect(send(`${base}/push/abc`, { method: "POST", headers: { ttl: "60" }, body: new Uint8Array([1, 2, 3]) })).rejects.toThrow();
    expect(redirected).toHaveLength(1);
    expect(reached).toHaveLength(0);
  });
});

describe("a self-hosted Firecrawl is never asked to fetch a page", () => {
  const realFetch = globalThis.fetch;
  const savedUrl = process.env.AGNI_FIRECRAWL_URL;
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (savedUrl === undefined) delete process.env.AGNI_FIRECRAWL_URL; else process.env.AGNI_FIRECRAWL_URL = savedUrl;
  });

  /** IP literals skip DNS and fetch is stubbed, so nothing here touches the network. */
  function stub(routes: Record<string, Response>): string[] {
    const requested: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      const response = routes[url];
      if (!response) throw new Error(`unexpected request ${url}`);
      return response;
    }) as typeof fetch;
    return requested;
  }

  test("the page is fetched here, hop by hop, and Firecrawl sees no request", async () => {
    process.env.AGNI_FIRECRAWL_URL = "http://firecrawl.test:3002";
    const requested = stub({
      "http://93.184.216.34/": new Response(null, { status: 302, headers: { location: "http://93.184.216.35/final" } }),
      "http://93.184.216.35/final": new Response("<html><title>Hi</title><body>hello</body></html>", { headers: { "content-type": "text/html" } }),
    });
    const { webFetch } = await import("../src/tools/web");
    const page = await webFetch({ url: "http://93.184.216.34/" });
    expect(page.title).toBe("Hi");
    expect(requested).toEqual(["http://93.184.216.34/", "http://93.184.216.35/final"]);
  });

  test("a redirect to a private address is refused before it is requested", async () => {
    process.env.AGNI_FIRECRAWL_URL = "http://firecrawl.test:3002";
    const requested = stub({
      "http://93.184.216.34/": new Response(null, { status: 302, headers: { location: "http://127.0.0.1:8080/admin" } }),
    });
    const { webFetch } = await import("../src/tools/web");
    await expect(webFetch({ url: "http://93.184.216.34/" })).rejects.toThrow("blocked");
    expect(requested).toEqual(["http://93.184.216.34/"]);
  });
});
