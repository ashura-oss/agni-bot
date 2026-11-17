import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { PluginService } from "../src/plugins/service";
import { getConnectionFor } from "../src/plugins/store";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Config } from "../src/config";
import { McpHub } from "../src/plugins/mcp";
import { listPins } from "../src/plugins/mcp-pins";
import { registerSecret } from "../src/util/redact";

/**
 * Sprint 3 fix round 6: text that comes from outside (an upstream server's answer, a provider's error, an
 * exception message) can echo a secret back. The frame path masks it; every place the server writes such text to
 * disk must mask it too, or the plaintext sits in the database and its write-ahead log.
 */

const BEARER = "mcp-bearer-fix6-9f8e7d6c5b4a3210";
const dirs: string[] = [];
const dbs: Database[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const db of dbs.splice(0)) db.close();
});

function pluginHarness() {
  const dir = mkdtempSync(join(tmpdir(), "agni-s3-storage-"));
  dirs.push(dir);
  const pluginsPath = join(dir, "plugins.json");
  writeFileSync(pluginsPath, JSON.stringify({ version: 1, plugins: {} }));
  const db = openDatabase(":memory:");
  dbs.push(db);
  const service = new PluginService({ config: {} as never, db, pluginsPath, emit: () => {} });
  return { service, db, dir };
}

describe("plugin connection errors", () => {
  test("an MCP server that answers 500 and echoes the bearer leaves no plaintext in plugin_connections.error", async () => {
    const { service, db } = pluginHarness();
    service.mcpHubOverride = {
      connect: async () => {
        throw new Error(`Streamable HTTP error: HTTP 500: {"echo":{"authorization":"Bearer ${BEARER}"}}`);
      },
      disconnect: async () => {},
    } as never;
    expect(service.configure("notion", "owner", { url: "https://mcp.example.com/mcp", key: BEARER }).error).toBeUndefined();
    await Bun.sleep(20);
    const row = getConnectionFor(db, "notion", "owner")!;
    expect(row.status).toBe("error");
    expect(row.error).toContain("HTTP 500");
    expect(row.error).not.toContain(BEARER);
    expect(row.error).toContain("[redacted]");
  });
});

describe("OAuth sign-in errors", () => {
  test("a token endpoint that echoes the client secret in its error leaves no plaintext in plugin_connections.error", async () => {
    const CLIENT_SECRET = "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e5f";
    const dir = mkdtempSync(join(tmpdir(), "agni-s3-storage-oauth-"));
    dirs.push(dir);
    const pluginsPath = join(dir, "plugins.json");
    writeFileSync(pluginsPath, JSON.stringify({ version: 1, oauthClients: { google: { clientID: "cid", clientSecret: CLIENT_SECRET } }, plugins: {} }));
    const db = openDatabase(":memory:");
    dbs.push(db);
    const service = new PluginService({ config: { host: "127.0.0.1", port: 8787 } as Config, db, emit: () => {}, pluginsPath });
    service.fetchOverride = (async () => Response.json({ error: "invalid_client", error_description: `bad client_secret=${CLIENT_SECRET}` }, { status: 401 })) as typeof fetch;
    const state = new URL(service.connect("calendar", "agent").authorizeURL!).searchParams.get("state")!;
    const result = await service.completeSignIn(state, "code-1");
    const row = getConnectionFor(db, "calendar", "agent")!;
    expect(row.status).toBe("error");
    expect(row.error).toContain("bad client_secret=");
    expect(row.error).not.toContain(CLIENT_SECRET);
    expect(result.error).toBeDefined();
  });
});

describe("MCP tool pins", () => {
  async function connectEchoingServer(db: Database, description: string) {
    const server = new McpServer({ name: "echo", version: "1" });
    server.registerTool("search", { description, inputSchema: {} }, async () => ({ content: [{ type: "text" as const, text: "ok" }] }));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const hub = new McpHub();
    await hub.connect("notion", "https://mcp.example.com/mcp", undefined, clientSide, [], { pins: db });
    return hub;
  }

  test("a tool description that echoes the bearer is stored masked, and the pin's hash is still the real definition's", async () => {
    const description = `Search. Debug: authorization=Bearer ${BEARER}`;
    // The same server first, before the bearer is a known secret: what its pin looks like unmasked.
    const baselineDB = openDatabase(":memory:");
    dbs.push(baselineDB);
    await (await connectEchoingServer(baselineDB, description)).disconnect("notion");
    const baseline = listPins(baselineDB, "notion")[0]!;
    expect(baseline.definition).toContain(BEARER);

    registerSecret(BEARER);
    const db = openDatabase(":memory:");
    dbs.push(db);
    const hub = await connectEchoingServer(db, description);
    await hub.disconnect("notion");
    const [pin] = listPins(db, "notion");
    expect(pin!.definition).not.toContain(BEARER);
    expect(pin!.definition).toContain("[redacted]");
    // The hash is of what the server offered, so the same tool offered again is still the approved one.
    expect(pin!.hash).toBe(baseline.hash);
    // And what is stored still parses, so `agni mcp approve` can show a diff.
    expect(() => JSON.parse(pin!.definition)).not.toThrow();
  });
});
