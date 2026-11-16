import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db";
import { MIGRATIONS } from "../src/db/migrations";
import { newPkce } from "../src/plugins/oauth";
import { PluginService } from "../src/plugins/service";
import { getConnectionFor } from "../src/plugins/store";
import type { Config } from "../src/config";

const dir = mkdtempSync(join(tmpdir(), "agni-s3-oauth-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const config = { host: "127.0.0.1", port: 8787 } as Config;
const TEN_MINUTES = 10 * 60 * 1000;

/** A service against an in-memory database, a fake Google (the injected fetch) and a clock the test moves. */
function harness() {
  const db = openDatabase(":memory:");
  const pluginsPath = join(dir, `plugins-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(pluginsPath, JSON.stringify({ version: 1, oauthClients: { google: { clientID: "cid", clientSecret: "csecret" } }, plugins: {} }));
  const clock = { now: 1_800_000_000_000 };
  const calls: { url: string; body?: URLSearchParams }[] = [];
  const service = new PluginService({ config, db, emit: () => {}, pluginsPath, now: () => clock.now });
  service.fetchOverride = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init?.body ? { body: init.body as URLSearchParams } : {}) });
    if (String(url).includes("/token")) return Response.json({ access_token: "at", refresh_token: "rt", expires_in: 3600 });
    return Response.json({ email: "agni@example.test" });
  }) as typeof fetch;
  const start = () => new URL(service.connect("calendar", "agent").authorizeURL!);
  return { service, db, clock, calls, start };
}

describe("OAuth PKCE (S3-08)", () => {
  test("newPkce gives a 43+ char unreserved verifier and its S256 challenge", () => {
    const { verifier, challenge } = newPkce();
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(newPkce().verifier).not.toBe(verifier);
  });

  test("the authorize URL carries an S256 challenge and never the verifier", () => {
    const { start } = harness();
    const url = start();
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.has("code_verifier")).toBe(false);
  });

  test("the token exchange sends the verifier whose S256 is the challenge that was sent", async () => {
    const { service, calls, start } = harness();
    const url = start();
    const result = await service.completeSignIn(url.searchParams.get("state")!, "code-1");
    expect(result.plugin).toBe("calendar");
    const body = calls.find((call) => call.url.includes("/token"))!.body!;
    const verifier = body.get("code_verifier")!;
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(url.searchParams.get("code_challenge")!);
  });

  test("each connect gets its own state and its own challenge", () => {
    const { start } = harness();
    const first = start();
    const second = start();
    expect(second.searchParams.get("state")).not.toBe(first.searchParams.get("state"));
    expect(second.searchParams.get("code_challenge")).not.toBe(first.searchParams.get("code_challenge"));
  });

  test("the verifier is kept off the connection row", () => {
    const { db, start } = harness();
    start();
    const row = getConnectionFor(db, "calendar", "agent")!;
    const stored = db.query<{ code_verifier: string }, []>("SELECT code_verifier FROM oauth_states").get()!.code_verifier;
    expect(stored.length).toBeGreaterThanOrEqual(43);
    expect(row.tokens ?? "").not.toContain(stored);
  });
});

describe("OAuth state (S3-08)", () => {
  test("a sign-in finished inside ten minutes works", async () => {
    const { service, clock, start } = harness();
    const state = start().searchParams.get("state")!;
    clock.now += TEN_MINUTES - 1_000;
    expect((await service.completeSignIn(state, "c")).plugin).toBe("calendar");
  });

  test("a sign-in finished after ten minutes is refused before any token request", async () => {
    const { service, db, clock, calls, start } = harness();
    const state = start().searchParams.get("state")!;
    clock.now += TEN_MINUTES + 1;
    const result = await service.completeSignIn(state, "c");
    expect(result.plugin).toBeUndefined();
    expect(result.error).toMatch(/stale|expired|again/i);
    expect(calls.filter((call) => call.url.includes("/token"))).toHaveLength(0);
    expect(getConnectionFor(db, "calendar", "agent")!.status).toBe("pending");
    // And the expired state is gone, so it cannot be tried again later.
    expect(db.query("SELECT 1 FROM oauth_states").all()).toHaveLength(0);
  });

  test("a state works once", async () => {
    const { service, calls, start } = harness();
    const state = start().searchParams.get("state")!;
    expect((await service.completeSignIn(state, "c")).plugin).toBe("calendar");
    expect((await service.completeSignIn(state, "c")).error).toMatch(/stale|already/i);
    expect(calls.filter((call) => call.url.includes("/token"))).toHaveLength(1);
  });

  test("a failed token exchange still uses the state up", async () => {
    const { service, calls, start } = harness();
    service.fetchOverride = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), ...(init?.body ? { body: init.body as URLSearchParams } : {}) });
      return Response.json({ error_description: "bad code" }, { status: 400 });
    }) as typeof fetch;
    const state = start().searchParams.get("state")!;
    expect((await service.completeSignIn(state, "c")).error).toBe("bad code");
    expect((await service.completeSignIn(state, "c")).error).toMatch(/stale|already/i);
  });

  test("the lookup is an exact match: wildcards, prefixes and look-alikes find nothing", async () => {
    const { service, calls, start } = harness();
    const state = start().searchParams.get("state")!;
    for (const guess of ["%", "_", `${state.slice(0, -1)}%`, state.slice(0, -1), `${state}x`, state.toUpperCase(), `%${state.slice(4)}`, "\"", ""]) {
      const result = await service.completeSignIn(guess, "c");
      expect(result.plugin).toBeUndefined();
    }
    expect(calls.filter((call) => call.url.includes("/token"))).toHaveLength(0);
    expect((await service.completeSignIn(state, "c")).plugin).toBe("calendar");
  });

  test("starting over kills the earlier state", async () => {
    const { service, start } = harness();
    const first = start().searchParams.get("state")!;
    const second = start().searchParams.get("state")!;
    expect((await service.completeSignIn(first, "c")).error).toMatch(/stale|already/i);
    expect((await service.completeSignIn(second, "c")).plugin).toBe("calendar");
  });

  test("disconnecting removes a pending state", async () => {
    const { service, db, start } = harness();
    const state = start().searchParams.get("state")!;
    await service.disconnect(getConnectionFor(db, "calendar", "agent")!.id);
    expect(db.query("SELECT 1 FROM oauth_states").all()).toHaveLength(0);
    expect((await service.completeSignIn(state, "c")).plugin).toBeUndefined();
  });
});

describe("migrations 60 and 61", () => {
  test("they exist, in order, and create the pin and state tables", () => {
    const ids = MIGRATIONS.map((entry) => entry.id);
    expect(ids).toContain(60);
    expect(ids).toContain(61);
    const db = openDatabase(":memory:");
    const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
    expect(tables).toContain("mcp_tool_pins");
    expect(tables).toContain("mcp_pin_plugins");
    expect(tables).toContain("oauth_states");
    db.close();
  });
});
