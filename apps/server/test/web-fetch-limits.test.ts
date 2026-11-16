/**
 * S1-25: web_fetch maxChars has its own schema (1 to 20,000) and the summary
 * honours it instead of being cut at 600. S1-41 (text): the "no search
 * provider" message names a real setting.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { fetchPage } from "../src/tools/fetch-url";
import { webFetch, webSearch } from "../src/tools/web";
import { buildTaskToolRegistry } from "../src/tools/task-registry";

// IP literals skip DNS and fetch is stubbed, so nothing here touches the network.
const realFetch = globalThis.fetch;
const savedEnv = { ...process.env };
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const key of ["AGNI_FIRECRAWL_URL", "AGNI_FIRECRAWL_API_KEY", "AGNI_SEARXNG_URL"]) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

const PAGE = `<html><head><title>Long page</title></head><body>${"word ".repeat(3000)}</body></html>`;
const ctx = { threadID: "thr_t", turnID: "trn_t", signal: new AbortController().signal };

function stubPage(): void {
  globalThis.fetch = (async () => new Response(PAGE, { headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
}

describe("S1-25: the summary length is the caller's maxChars", () => {
  test("fetchPage keeps its 600-character default for callers that do not ask", async () => {
    stubPage();
    const page = await fetchPage("http://93.184.216.34/");
    expect(page.summary!.length).toBe(600);
  });

  test("fetchPage honours a larger maxChars", async () => {
    stubPage();
    const page = await fetchPage("http://93.184.216.34/", undefined, 5000);
    expect(page.summary!.length).toBe(5000);
  });

  test("webFetch defaults to 4,000 characters, not 600", async () => {
    stubPage();
    const page = await webFetch({ url: "http://93.184.216.34/" });
    expect(page.summary!.length).toBe(4001); // 4000 plus the ellipsis marker
    expect(page.summary!.endsWith("…")).toBe(true);
  });

  test("webFetch honours maxChars up to 20,000", async () => {
    stubPage();
    expect((await webFetch({ url: "http://93.184.216.34/", maxChars: 1000 })).summary!.length).toBe(1001);
    expect((await webFetch({ url: "http://93.184.216.34/", maxChars: 12_000 })).summary!.length).toBe(12_001);
  });

  test("a short page is returned whole", async () => {
    globalThis.fetch = (async () => new Response("<html><title>t</title><body>tiny</body></html>", { headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    expect((await webFetch({ url: "http://93.184.216.34/" })).summary).toBe("t tiny");
  });
});

describe("S1-25: the web_fetch tool takes maxChars from 1 to 20,000", () => {
  let db: Database | undefined;
  afterEach(() => { db?.close(); db = undefined; });

  test("the schema allows 20,000 and nothing above or below", () => {
    db = openDatabase(":memory:");
    const registry = buildTaskToolRegistry(db);
    const schema = registry.get("web_fetch")!.schema as { properties: { maxChars: { minimum: number; maximum: number } } };
    expect(schema.properties.maxChars).toMatchObject({ type: "integer", minimum: 1, maximum: 20_000 });
    expect(registry.validateArgs("web_fetch", { url: "https://example.com", maxChars: 20_000 })).toBeNull();
    expect(registry.validateArgs("web_fetch", { url: "https://example.com", maxChars: 20_001 })).toMatch(/"maxChars" must be at most 20000/);
    expect(registry.validateArgs("web_fetch", { url: "https://example.com", maxChars: 0 })).toMatch(/"maxChars" must be at least 1/);
  });

  test("the handler passes a value above 20 through instead of dropping it", async () => {
    db = openDatabase(":memory:");
    stubPage();
    const registry = buildTaskToolRegistry(db);
    const result = (await registry.get("web_fetch")!.handler({ url: "http://93.184.216.34/", maxChars: 9000 } as never, ctx)) as { summary: string };
    expect(result.summary.length).toBe(9001);
  });

  test("other tools keep their limit of 20", () => {
    db = openDatabase(":memory:");
    const registry = buildTaskToolRegistry(db);
    expect(registry.validateArgs("web_search", { query: "x", count: 21 })).toMatch(/"count" must be at most 20/);
  });
});

describe("S1-41: the no-provider message", () => {
  test("names a real setting, not a function call", async () => {
    delete process.env.AGNI_FIRECRAWL_URL;
    delete process.env.AGNI_FIRECRAWL_API_KEY;
    delete process.env.AGNI_SEARXNG_URL;
    globalThis.fetch = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const result = await webSearch({ query: "anything" });
    expect(result.results).toEqual([]);
    expect(result.provider).not.toContain("()");
    expect(result.provider).toContain("AGNI_FIRECRAWL_URL");
  });
});
