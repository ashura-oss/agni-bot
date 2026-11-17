import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDatabase } from "../src/db";
import { McpHub } from "../src/plugins/mcp";
import { checkMcpUrl, guardedFetch, mcpUrlShapeError } from "../src/plugins/mcp-url";
import { listPins } from "../src/plugins/mcp-pins";
import { PluginService } from "../src/plugins/service";
import { getConnectionFor } from "../src/plugins/store";

/** A resolver that answers from a table, so no test touches DNS. */
const resolves = (table: Record<string, string[]>) => async (host: string): Promise<string[]> => {
  const answer = table[host];
  if (!answer) throw new Error(`ENOTFOUND ${host}`);
  return answer;
};
const PUBLIC = "93.184.216.34";

describe("MCP server URL check (S3-06)", () => {
  test("a public https server passes", async () => {
    await checkMcpUrl("https://mcp.example.com/mcp", { lookup: resolves({ "mcp.example.com": [PUBLIC] }) });
  });

  test("http is refused for anything that is not loopback, flagged local or not", () => {
    expect(mcpUrlShapeError("http://mcp.example.com/mcp")).toMatch(/https/);
    expect(mcpUrlShapeError("http://192.168.1.5/mcp")).toMatch(/https/);
    expect(mcpUrlShapeError("http://127.0.0.1:9000/mcp")).toBeUndefined();
    expect(mcpUrlShapeError("http://localhost:9000/mcp")).toBeUndefined();
    expect(mcpUrlShapeError("http://[::1]:9000/mcp")).toBeUndefined();
    expect(mcpUrlShapeError("ftp://x.example/mcp")).toMatch(/https/);
    expect(mcpUrlShapeError("not a url")).toBeTruthy();
    expect(mcpUrlShapeError("https://user:pw@mcp.example.com/mcp")).toMatch(/credentials/);
  });

  for (const [label, address] of [
    ["private 10/8", "10.0.0.5"],
    ["private 172.16/12", "172.20.1.1"],
    ["private 192.168/16", "192.168.1.5"],
    ["loopback", "127.0.0.1"],
    ["link-local", "169.254.10.10"],
    ["cloud metadata", "169.254.169.254"],
    ["Azure metadata", "168.63.129.16"],
    ["Alibaba metadata (CGNAT)", "100.100.100.200"],
    ["CGNAT", "100.64.0.1"],
    ["unspecified", "0.0.0.0"],
    ["IPv6 loopback", "::1"],
    ["IPv6 unique-local metadata", "fd00:ec2::254"],
    ["IPv6 link-local", "fe80::1"],
    ["IPv4-mapped private", "::ffff:10.0.0.1"],
  ] as const) {
    test(`a host that resolves to ${label} (${address}) is refused`, async () => {
      await expect(checkMcpUrl("https://mcp.example.com/mcp", { lookup: resolves({ "mcp.example.com": [address] }) })).rejects.toThrow(/private|reserved|blocked/i);
    });
  }

  test("one private answer among public ones refuses the host", async () => {
    await expect(checkMcpUrl("https://mcp.example.com/mcp", { lookup: resolves({ "mcp.example.com": [PUBLIC, "10.0.0.5"] }) })).rejects.toThrow(/private/i);
  });

  test("an IP literal is checked without any lookup", async () => {
    const lookup = async (): Promise<string[]> => { throw new Error("must not resolve a literal"); };
    await expect(checkMcpUrl("https://169.254.169.254/latest", { lookup })).rejects.toThrow(/private/i);
    await expect(checkMcpUrl("https://[fd00:ec2::254]/", { lookup })).rejects.toThrow(/private/i);
  });

  test("localhost and .internal names are private too", async () => {
    await expect(checkMcpUrl("https://localhost/mcp", { lookup: resolves({}) })).rejects.toThrow(/private/i);
    await expect(checkMcpUrl("https://db.internal/mcp", { lookup: resolves({}) })).rejects.toThrow(/private/i);
  });

  test("the owner's local flag lifts the address check but not the scheme rule", async () => {
    await checkMcpUrl("https://192.168.1.5/mcp", { local: true });
    await checkMcpUrl("http://127.0.0.1:9000/mcp", { local: true });
    await checkMcpUrl("https://nas.lan/mcp", { local: true, lookup: resolves({ "nas.lan": ["192.168.1.9"] }) });
    await expect(checkMcpUrl("http://192.168.1.5/mcp", { local: true })).rejects.toThrow(/https/);
    await expect(checkMcpUrl("http://127.0.0.1:9000/mcp", { local: false })).rejects.toThrow(/private/i);
  });

  test("a host that cannot be resolved is refused, not allowed through", async () => {
    await expect(checkMcpUrl("https://gone.example/mcp", { lookup: resolves({}) })).rejects.toThrow(/resolve|ENOTFOUND/i);
  });

  test("DNS is asked again on every check: a host that turns private later is caught", async () => {
    let answer = PUBLIC;
    const lookup = async () => [answer];
    await checkMcpUrl("https://mcp.example.com/mcp", { lookup });
    answer = "169.254.169.254";
    await expect(checkMcpUrl("https://mcp.example.com/mcp", { lookup })).rejects.toThrow(/private/i);
  });

  test("hub.connect refuses a private URL before opening any connection", async () => {
    const hub = new McpHub();
    await expect(hub.connect("p", "https://169.254.169.254/mcp")).rejects.toThrow(/private/i);
    await expect(hub.connect("p", "http://mcp.example.com/mcp")).rejects.toThrow(/https/);
    expect(hub.tools()).toEqual([]);
  });

  test("the transport's fetch re-checks the host for every request and does not call out when it turns private", async () => {
    let answer = PUBLIC;
    const seen: string[] = [];
    const inner = (async (input: string | URL | Request) => { seen.push(String(input)); return new Response("ok"); }) as typeof fetch;
    const guarded = guardedFetch({ lookup: async () => [answer], fetch: inner });
    expect((await guarded("https://mcp.example.com/mcp")).status).toBe(200);
    answer = "10.0.0.5";
    await expect(guarded("https://mcp.example.com/mcp")).rejects.toThrow(/private/i);
    expect(seen).toHaveLength(1);
  });
});

describe("plugin service and the local flag (S3-06)", () => {
  const dirs: string[] = [];
  const dbs: Database[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    for (const db of dbs.splice(0)) db.close();
  });

  function harness(plugins: Record<string, unknown> = {}) {
    const dir = mkdtempSync(join(tmpdir(), "agni-s3-mcp-"));
    dirs.push(dir);
    const pluginsPath = join(dir, "plugins.json");
    writeFileSync(pluginsPath, JSON.stringify({ version: 1, plugins }));
    const db = openDatabase(":memory:");
    dbs.push(db);
    const calls: unknown[][] = [];
    const service = new PluginService({ config: {} as any, db, pluginsPath, emit: () => {} });
    service.mcpHubOverride = { connect: async (...args: unknown[]) => { calls.push(args); return 0; }, disconnect: async () => {} } as any;
    return { service, db, calls, pluginsPath };
  }
  const entry = (extra: Record<string, unknown> = {}) => ({ account: "owner", enabled: true, auth: { kind: "mcp", url: "https://mcp.example.com/mcp" }, ...extra });

  test("configuring an http URL for a remote host is refused with a clear message", () => {
    const { service } = harness();
    const result = service.configure("notion", "owner", { url: "http://mcp.example.com/mcp" });
    expect(result.error?.code).toBe("plugin_not_configured");
    expect(result.error?.message).toMatch(/https/);
  });

  test("the hub is told whether the owner flagged the plugin local, and re-configuring keeps the flag", async () => {
    const { service, calls, pluginsPath } = harness({ notion: entry({ local: true }) });
    expect(service.configure("notion", "owner", { url: "https://192.168.1.5/mcp" }).error).toBeUndefined();
    await Promise.resolve();
    expect((calls[0]![5] as any).local).toBe(true);
    expect(JSON.parse(readFileSync(pluginsPath, "utf-8")).plugins.notion.local).toBe(true);
  });

  test("an unflagged plugin connects with local false", async () => {
    const { service, calls } = harness({ notion: entry() });
    service.configure("notion", "owner", { url: "https://mcp.example.com/mcp" });
    await Promise.resolve();
    expect((calls[0]![5] as any).local).toBe(false);
  });

  test("removing the flag by hand is not undone by a later save from stale memory", async () => {
    const { service, calls, pluginsPath } = harness({ notion: entry({ local: true }) });
    writeFileSync(pluginsPath, JSON.stringify({ version: 1, plugins: { notion: entry() } })); // owner edits the file
    service.configure("notion", "owner", { url: "https://mcp.example.com/mcp" }); // saves
    await Promise.resolve();
    expect((calls[0]![5] as any).local).toBe(false);
    expect(JSON.parse(readFileSync(pluginsPath, "utf-8")).plugins.notion.local).toBeUndefined();
  });

  test("the hub gets the database for pins", async () => {
    const { service, calls, db } = harness({ notion: entry() });
    service.configure("notion", "owner", { url: "https://mcp.example.com/mcp" });
    await Promise.resolve();
    expect((calls[0]![5] as any).pins).toBe(db);
  });

  async function pinSomething(db: Database) {
    const hub = new McpHub();
    const mcp = new McpServer({ name: "fake", version: "1" });
    mcp.registerTool("search", { description: "find", inputSchema: {} }, async () => ({ content: [{ type: "text" as const, text: "x" }] }));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverSide);
    await hub.connect("notion", "https://mcp.example.com/mcp", undefined, clientSide, [], { pins: db });
    await hub.disconnect("notion");
    expect(listPins(db, "notion")).toHaveLength(1);
  }

  test("disconnecting the plugin forgets its pins, so a reconnect is a fresh first trust", async () => {
    const { service, db } = harness({ notion: entry() });
    service.configure("notion", "owner", { url: "https://mcp.example.com/mcp" });
    await pinSomething(db);
    const row = getConnectionFor(db, "notion", "owner")!;
    await service.disconnect(row.id);
    expect(listPins(db, "notion")).toEqual([]);
  });

  test("pointing the plugin at a different server forgets the old server's pins; the same URL keeps them", async () => {
    const { service, db } = harness({ notion: entry() });
    service.configure("notion", "owner", { url: "https://mcp.example.com/mcp" });
    await pinSomething(db);
    service.configure("notion", "owner", { url: "https://mcp.example.com/mcp", key: "new-token" });
    expect(listPins(db, "notion")).toHaveLength(1);
    service.configure("notion", "owner", { url: "https://other.example.com/mcp" });
    expect(listPins(db, "notion")).toEqual([]);
  });
});

describe("MCP over a real loopback HTTP server", () => {
  async function loopbackServer() {
    const { createServer } = await import("node:http");
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
    const port = (http.address() as { port: number }).port;
    return { url: `http://127.0.0.1:${port}/mcp`, close: () => new Promise<void>((resolve) => http.close(() => resolve())) };
  }

  test("a loopback server connects only when the plugin is flagged local, and its tool runs", async () => {
    const server = await loopbackServer();
    try {
      const hub = new McpHub();
      await expect(hub.connect("dev", server.url)).rejects.toThrow(/private/i);
      expect(await hub.connect("dev", server.url, undefined, undefined, [], { local: true })).toBe(1);
      const out = await hub.tools()[0]!.handler({}, {} as any);
      expect(out).toMatchObject({ text: "found" });
      await hub.disconnect("dev");
    } finally {
      await server.close();
    }
  });
});
