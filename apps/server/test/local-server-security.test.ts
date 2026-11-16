import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@agni/protocol";
import { publishShare, readShareFile } from "../src/share/document";
import type { ShareDocument } from "../src/share/render";
import { startHarness, type Harness } from "./ws-harness";

/**
 * Local-server security for Sprint 1: exact Origin allowlist, Host check,
 * CSP on served HTML, expiring and revocable share links, a status-only
 * /health, and CORS that never says `*` on the authenticated routes.
 */

let harness: Harness | undefined;
const dirs: string[] = [];
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["AGNI_ALLOWED_ORIGINS", "AGNI_SHARE_DIR", "AGNI_WEB_DIR"];

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** A WebSocket upgrade request, sent as plain HTTP so the status is visible. */
function upgrade(base: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/ws`, {
    headers: { upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", ...headers },
  });
}

/** Does a real WebSocket handshake with these headers succeed? (Closes the socket again.) */
function opens(base: string, headers: Record<string, string>): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws`, { headers } as unknown as string[]);
    ws.addEventListener("open", () => { ws.close(); resolve(true); }, { once: true });
    ws.addEventListener("error", () => resolve(false), { once: true });
  });
}

function sampleDoc(): ShareDocument {
  return {
    title: "Test export",
    agentName: "Agni",
    agentID: "ea",
    conversationID: "cnv_test",
    createdAt: new Date().toISOString(),
    records: [{ id: "u1", kind: "user", at: new Date().toISOString(), text: "hello" }],
  };
}

describe("Host header check (S1: DNS rebinding)", () => {
  test("a request addressed to a foreign name is refused on every route", async () => {
    harness = await startHarness();
    const evil = { host: "evil.example" };
    expect((await fetch(`${harness.base}/health`, { headers: evil })).status).toBe(403);
    expect((await fetch(`${harness.base}/`, { headers: evil })).status).toBe(403);
    expect((await fetch(`${harness.base}/auth/session`, { headers: evil })).status).toBe(403);
    expect((await fetch(`${harness.base}/share/0123456789abcdef0123456789abcdef`, { headers: evil })).status).toBe(403);
    expect((await upgrade(harness.base, evil)).status).toBe(403);
    // Same machine, same port, honest name: fine.
    expect((await fetch(`${harness.base}/health`, { headers: { host: `localhost:${harness.server.port}` } })).status).toBe(200);
    expect((await fetch(`${harness.base}/health`)).status).toBe(200);
  });

  test("a configured public origin's name is accepted", async () => {
    harness = await startHarness({ config: { publicOrigin: "https://box.tail1.ts.net" } });
    expect((await fetch(`${harness.base}/health`, { headers: { host: "box.tail1.ts.net" } })).status).toBe(200);
  });
});

describe("Origin allowlist on the socket and pairing", () => {
  test("another loopback port is refused until it is configured", async () => {
    harness = await startHarness();
    expect((await upgrade(harness.base, { origin: "http://127.0.0.1:5173" })).status).toBe(403);
    expect(await opens(harness.base, { origin: `http://127.0.0.1:${harness.server.port}` })).toBe(true);
    expect((await upgrade(harness.base, { origin: "https://evil.example" })).status).toBe(403);
  });

  test("AGNI_ALLOWED_ORIGINS adds exactly the origins it names", async () => {
    process.env.AGNI_ALLOWED_ORIGINS = "http://127.0.0.1:5173,http://localhost:5173";
    harness = await startHarness();
    expect(await opens(harness.base, { origin: "http://127.0.0.1:5173" })).toBe(true);
    expect(await opens(harness.base, { origin: "http://localhost:5173" })).toBe(true);
    expect((await upgrade(harness.base, { origin: "http://127.0.0.1:5174" })).status).toBe(403);
  });

  test("pairing needs an allowed origin", async () => {
    harness = await startHarness();
    const pair = (origin: string) => fetch(`${harness!.base}/auth/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ code: "AAAA-AAAA", name: "x" }),
    });
    expect((await pair("http://127.0.0.1:5173")).status).toBe(403);
    expect((await pair(`http://127.0.0.1:${harness.server.port}`)).status).toBe(401); // allowed; the code is just wrong
  });
});

describe("/health is status only", () => {
  test("an unauthenticated caller learns the server is up and nothing about the owner or config", async () => {
    harness = await startHarness();
    const body = await (await fetch(`${harness.base}/health`)).json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["ok", "serverTime", "uptimeMs", "v"]);
    expect(body.ok).toBe(true);
    expect(body.v).toBe(PROTOCOL_VERSION);
  });

  test("a paired device gets the full report", async () => {
    harness = await startHarness();
    const body = await (await fetch(`${harness.base}/health`, { headers: { authorization: `Bearer ${harness.token}` } })).json() as Record<string, unknown>;
    expect(body.providers).toBeDefined();
    expect(body.usageToday).toBeDefined();
  });

  test("a wrong token gets the minimal report, not an error", async () => {
    harness = await startHarness();
    const response = await fetch(`${harness.base}/health`, { headers: { authorization: "Bearer nope" } });
    expect(response.status).toBe(200);
    expect((await response.json() as Record<string, unknown>).providers).toBeUndefined();
  });
});

describe("Content-Security-Policy on served HTML", () => {
  test("a shared thread cannot run script or load anything", async () => {
    process.env.AGNI_SHARE_DIR = tempDir("agni-share-");
    harness = await startHarness();
    const published = publishShare(sampleDoc(), { baseURL: harness.base });
    const response = await fetch(`${harness.base}/share/${published.token}`);
    expect(response.status).toBe(200);
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("script-src");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  test("the OAuth callback page carries a strict policy", async () => {
    harness = await startHarness();
    const response = await fetch(`${harness.base}/oauth/callback`);
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("style-src 'sha256-");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  test("the web app's HTML allows only its own scripts and this server's socket", async () => {
    const web = tempDir("agni-web-");
    writeFileSync(join(web, "index.html"), "<!doctype html><html><body>app</body></html>");
    process.env.AGNI_WEB_DIR = web;
    harness = await startHarness();
    const response = await fetch(`${harness.base}/agent/ea`);
    expect(await response.text()).toContain("app");
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).not.toMatch(/script-src[^;]*unsafe-eval/);
    expect(csp).toContain(`connect-src 'self' ws://127.0.0.1:${harness.server.port} wss://127.0.0.1:${harness.server.port}`);
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
  });
});

describe("share links expire and can be revoked", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const age = (path: string, ms: number) => {
    const then = new Date(Date.now() - ms);
    utimesSync(path, then, then);
  };

  test("a link works for 7 days and then is gone, file included", () => {
    process.env.AGNI_SHARE_DIR = tempDir("agni-share-");
    const fresh = publishShare(sampleDoc(), { baseURL: "http://127.0.0.1:8787" });
    age(fresh.path, 6 * DAY);
    expect(readShareFile(fresh.token)).not.toBeNull();

    const stale = publishShare(sampleDoc(), { baseURL: "http://127.0.0.1:8787" });
    age(stale.path, 7 * DAY + 60_000);
    expect(readShareFile(stale.token)).toBeNull();
    expect(existsSync(stale.path)).toBe(false);
  });

  test("an expired link is a 404 over HTTP", async () => {
    process.env.AGNI_SHARE_DIR = tempDir("agni-share-");
    harness = await startHarness();
    const published = publishShare(sampleDoc(), { baseURL: harness.base });
    expect((await fetch(`${harness.base}/share/${published.token}`)).status).toBe(200);
    age(published.path, 8 * DAY);
    expect((await fetch(`${harness.base}/share/${published.token}`)).status).toBe(404);
  });

  test("the owner can revoke a link with their device token", async () => {
    process.env.AGNI_SHARE_DIR = tempDir("agni-share-");
    harness = await startHarness();
    const published = publishShare(sampleDoc(), { baseURL: harness.base });
    const url = `${harness.base}/share/${published.token}`;

    // Anyone with the link may read it; only a paired device may revoke it.
    expect((await fetch(url, { method: "DELETE" })).status).toBe(401);
    expect((await fetch(url, { method: "DELETE", headers: { authorization: "Bearer nope" } })).status).toBe(401);
    expect((await fetch(url, { method: "DELETE", headers: { authorization: `Bearer ${harness.token}`, origin: "https://evil.example" } })).status).toBe(403);
    expect((await fetch(url)).status).toBe(200);

    const revoked = await fetch(url, { method: "DELETE", headers: { authorization: `Bearer ${harness.token}` } });
    expect(revoked.status).toBe(200);
    expect((await fetch(url)).status).toBe(404);
    expect(existsSync(published.path)).toBe(false);
    // Revoking twice is a clean 404, not a crash.
    expect((await fetch(url, { method: "DELETE", headers: { authorization: `Bearer ${harness.token}` } })).status).toBe(404);
  });
});

describe("CORS on the authenticated routes", () => {
  const routes: Array<[string, string]> = [["attachments", "/attachments"], ["backgrounds", "/backgrounds/bg_x"], ["debug", "/debug/overview"]];

  for (const [name, path] of routes) {
    test(`${name}: an allowed origin is echoed, never a wildcard`, async () => {
      harness = await startHarness();
      const origin = `http://127.0.0.1:${harness.server.port}`;
      const preflight = await fetch(`${harness.base}${path}`, { method: "OPTIONS", headers: { origin, "access-control-request-method": "GET" } });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe(origin);
      const actual = await fetch(`${harness.base}${path}`, { headers: { origin, authorization: `Bearer ${harness.token}` } });
      expect(actual.headers.get("access-control-allow-origin")).toBe(origin);
    });

    test(`${name}: a foreign origin is refused outright, with or without a token`, async () => {
      harness = await startHarness();
      const origin = "https://evil.example";
      const preflight = await fetch(`${harness.base}${path}`, { method: "OPTIONS", headers: { origin, "access-control-request-method": "GET" } });
      expect(preflight.status).toBe(403);
      expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
      const actual = await fetch(`${harness.base}${path}`, { headers: { origin, authorization: `Bearer ${harness.token}` } });
      expect(actual.status).toBe(403);
      expect(actual.headers.get("access-control-allow-origin")).toBeNull();
    });

    test(`${name}: a native client with no Origin still works`, async () => {
      harness = await startHarness();
      const response = await fetch(`${harness.base}${path}`, { headers: { authorization: `Bearer ${harness.token}` } });
      expect(response.status).not.toBe(401);
      expect(response.status).not.toBe(403);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    });
  }
});
