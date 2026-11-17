import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpHub } from "../src/plugins/mcp";
import { guardedFetch } from "../src/plugins/mcp-url";

/** A resolver that answers from a table, so no test touches DNS. */
const resolves = (table: Record<string, string[]>) => async (host: string): Promise<string[]> => {
  const answer = table[host];
  if (!answer) throw new Error(`ENOTFOUND ${host}`);
  return answer;
};
const PUBLIC = "93.184.216.34";

/** A fake sender: answers every request with the given response and records what it was asked. */
function fakeSender(respond: () => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), ...(init ? { init } : {}) });
    return respond();
  }) as typeof fetch;
  return { fetchFn, calls };
}
const redirectTo = (location: string, status = 302) => () => new Response(null, { status, headers: { location } });

describe("MCP transport refuses redirects (S3-4 review)", () => {
  const lookup = resolves({ "mcp.example.com": [PUBLIC], "rebind.example.com": ["10.0.0.5"], "other.example.org": [PUBLIC] });
  for (const [label, target] of [
    ["loopback", "http://127.0.0.1:8080/admin"],
    ["private 10/8", "https://10.1.2.3/mcp"],
    ["cloud metadata", "http://169.254.169.254/latest/meta-data"],
    ["a name that resolves private", "https://rebind.example.com/mcp"],
    ["another origin entirely", "https://other.example.org/mcp"],
    ["the same origin", "https://mcp.example.com/other"],
  ] as const) {
    test(`a 302 to ${label} is refused and the sender is called once, with redirect "manual"`, async () => {
      const sender = fakeSender(redirectTo(target));
      const guarded = guardedFetch({ lookup, fetch: sender.fetchFn });
      await expect(guarded("https://mcp.example.com/mcp", { method: "POST", headers: { authorization: "Bearer secret-token" }, body: "{}" })).rejects.toThrow(/redirect/i);
      expect(sender.calls).toHaveLength(1);
      expect(sender.calls[0]!.url).toBe("https://mcp.example.com/mcp");
      expect(sender.calls[0]!.init?.redirect).toBe("manual");
    });
  }

  for (const status of [301, 303, 307, 308]) {
    test(`a ${status} is refused like a 302`, async () => {
      const sender = fakeSender(redirectTo("https://other.example.org/mcp", status));
      await expect(guardedFetch({ lookup, fetch: sender.fetchFn })("https://mcp.example.com/mcp")).rejects.toThrow(new RegExp(String(status)));
      expect(sender.calls).toHaveLength(1);
    });
  }

  test("the refusal names the status but never echoes the Location URL back (it may carry a secret)", async () => {
    const sender = fakeSender(redirectTo("https://other.example.org/cb?token=hunter2"));
    const guarded = guardedFetch({ lookup: resolves({ "mcp.example.com": [PUBLIC] }), fetch: sender.fetchFn });
    const error = await guarded("https://mcp.example.com/mcp").catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/302/);
    expect((error as Error).message).not.toContain("hunter2");
  });

  test("a non-redirect answer, including 304-free ordinary ones, still passes through", async () => {
    const sender = fakeSender(() => new Response("ok", { status: 200 }));
    const guarded = guardedFetch({ lookup: resolves({ "mcp.example.com": [PUBLIC] }), fetch: sender.fetchFn });
    expect(await (await guarded("https://mcp.example.com/mcp")).text()).toBe("ok");
  });
});

/** Real loopback servers: what was asked of them is the proof that nothing followed a redirect. */
describe("MCP transport over real sockets (S3-4 review)", () => {
  interface Seen { method: string; url: string; headers: IncomingHttpHeaders; body: string }
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); })));
  });

  async function listen(handler: (seen: Seen, respond: (status: number, headers?: Record<string, string>, body?: string) => void) => void) {
    const seen: Seen[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const entry = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
        seen.push(entry);
        handler(entry, (status, headers = {}, text = "") => { res.writeHead(status, headers); res.end(text); });
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { seen, port: (server.address() as { port: number }).port };
  }

  test("a redirect to a second server is refused: that server sees no request, and only the first saw the Authorization header", async () => {
    const target = await listen((_seen, respond) => respond(200, {}, "reached"));
    const origin = await listen((_seen, respond) => respond(302, { location: `http://127.0.0.1:${target.port}/steal` }));
    const guarded = guardedFetch({ local: true });
    await expect(
      guarded(`http://127.0.0.1:${origin.port}/mcp`, { method: "POST", headers: { authorization: "Bearer secret-token", "content-type": "application/json" }, body: "{}" }),
    ).rejects.toThrow(/redirect/i);
    expect(origin.seen).toHaveLength(1);
    expect(origin.seen[0]!.headers.authorization).toBe("Bearer secret-token");
    expect(target.seen).toHaveLength(0);
  });

  test("a redirect to the same origin is refused too (no MCP server needs one)", async () => {
    const origin = await listen((seen, respond) => (seen.url === "/mcp" ? respond(307, { location: "/elsewhere" }) : respond(200, {}, "followed")));
    const guarded = guardedFetch({ local: true });
    await expect(guarded(`http://127.0.0.1:${origin.port}/mcp`)).rejects.toThrow(/redirect/i);
    expect(origin.seen.map((entry) => entry.url)).toEqual(["/mcp"]);
  });

  test("the connection goes to the address that was checked, with the original Host header", async () => {
    const origin = await listen((_seen, respond) => respond(200, { "content-type": "text/plain" }, "pinned"));
    let lookups = 0;
    // The system resolver cannot answer for this name: reaching the server proves the connection used the checked address.
    const lookup = async (host: string) => { lookups += 1; expect(host).toBe("mcp.pinned.localhost"); return ["127.0.0.1"]; };
    const guarded = guardedFetch({ local: true, lookup });
    const response = await guarded(`http://mcp.pinned.localhost:${origin.port}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"a":1}' });
    expect(await response.text()).toBe("pinned");
    expect(lookups).toBe(1);
    expect(origin.seen[0]!.headers.host).toBe(`mcp.pinned.localhost:${origin.port}`);
    expect(origin.seen[0]!.body).toBe('{"a":1}');
  });

  test("one lookup serves the check and the connection: a second, different answer is never consulted", async () => {
    const origin = await listen((_seen, respond) => respond(200, {}, "ok"));
    const answers = [["127.0.0.1"], ["169.254.169.254"]];
    let lookups = 0;
    const guarded = guardedFetch({ local: true, lookup: async () => answers[Math.min(lookups++, 1)]! });
    await guarded(`http://rebind.pinned.localhost:${origin.port}/mcp`);
    expect(lookups).toBe(1);
    expect(origin.seen).toHaveLength(1);
  });

  test("a pooled socket is keyed by the pinned address too: the same name and port at a new address gets a new connection", async () => {
    // Listening on every interface, so 127.0.0.1 and 127.0.0.2 both reach it and each request shows which one it came in on.
    const arrived: string[] = [];
    let connections = 0;
    const server = createServer((req, res) => { arrived.push(req.socket.localAddress ?? ""); res.writeHead(200, { "content-type": "text/plain" }); res.end("ok"); });
    server.on("connection", () => { connections += 1; });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
    const port = (server.address() as { port: number }).port;
    const answers = [["127.0.0.1"], ["127.0.0.1"], ["127.0.0.2"]];
    let asked = 0;
    const guarded = guardedFetch({ local: true, lookup: async () => answers[asked++]! });
    for (let round = 0; round < 3; round += 1) {
      const response = await guarded(`http://mcp.pooled.localhost:${port}/mcp`);
      expect(await response.text()).toBe("ok");
    }
    expect(arrived.map((address) => address.replace("::ffff:", ""))).toEqual(["127.0.0.1", "127.0.0.1", "127.0.0.2"]);
    // The first two share a connection (same name, port and address); the third cannot ride on the 127.0.0.1 socket.
    expect(connections).toBeLessThanOrEqual(2);
  });

  test("an unflagged host with one private answer among public ones is refused before any connection", async () => {
    const guarded = guardedFetch({ lookup: resolves({ "mcp.example.com": [PUBLIC, "10.0.0.5"] }) });
    await expect(guarded("https://mcp.example.com/mcp")).rejects.toThrow(/private/i);
  });

  test("a caller's abort signal cancels the request", async () => {
    const origin = await listen(() => { /* never answers */ });
    const controller = new AbortController();
    const guarded = guardedFetch({ local: true });
    const pending = guarded(`http://127.0.0.1:${origin.port}/mcp`, { signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    await expect(pending).rejects.toThrow();
  });

  test("hub.connect to a server that redirects fails and the redirect target is never contacted", async () => {
    const target = await listen((_seen, respond) => respond(200, {}, "reached"));
    const origin = await listen((_seen, respond) => respond(302, { location: `http://127.0.0.1:${target.port}/mcp` }));
    const hub = new McpHub();
    await expect(hub.connect("dev", `http://127.0.0.1:${origin.port}/mcp`, "tok", undefined, [], { local: true })).rejects.toThrow(/redirect/i);
    expect(target.seen).toHaveLength(0);
    expect(hub.tools()).toEqual([]);
  });

  test("a streamed (SSE) answer arrives in pieces, before the server ends the response", async () => {
    const sse = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: one\n\n");
      setTimeout(() => res.end("data: two\n\n"), 150);
    });
    servers.push(sse);
    await new Promise<void>((resolve) => sse.listen(0, "127.0.0.1", resolve));
    const port = (sse.address() as { port: number }).port;
    const response = await guardedFetch({ local: true })(`http://127.0.0.1:${port}/mcp`, { headers: { accept: "text/event-stream" } });
    const reader = response.body!.getReader();
    const started = Date.now();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toBe("data: one\n\n");
    expect(Date.now() - started).toBeLessThan(120);
    reader.cancel().catch(() => {});
  });
});

describe("a real MCP server still works through the pinned transport", () => {
  test("initialize, list and call over http loopback", async () => {
    const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
    const http = createServer(async (req, res) => {
      const mcp = new McpServer({ name: "fake", version: "1" });
      mcp.registerTool("search", { description: "find", inputSchema: {} }, async () => ({ content: [{ type: "text" as const, text: "found" }] }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => { void transport.close(); void mcp.close(); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    try {
      const port = (http.address() as { port: number }).port;
      const hub = new McpHub();
      expect(await hub.connect("dev", `http://127.0.0.1:${port}/mcp`, "tok", undefined, [], { local: true })).toBe(1);
      expect(await hub.tools()[0]!.handler({}, {} as any)).toMatchObject({ text: "found" });
      await hub.disconnect("dev");
    } finally {
      http.closeAllConnections?.();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  });
});
