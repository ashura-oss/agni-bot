import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintPairCode } from "../src/auth/tokens";
import { RateLimiter } from "../src/auth/rate-limit";
import { routeAccess } from "../src/auth/route-access";
import { publishShare } from "../src/share/document";
import type { ShareDocument } from "../src/share/render";
import { startHarness, type Harness } from "./ws-harness";

/** S3-05: the local server surface: route gate, /health, pairing limit, cookie, headers, socket limits. */

let harness: Harness | undefined;
const dirs: string[] = [];
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["AGNI_DEV", "AGNI_ALLOWED_ORIGINS", "AGNI_SHARE_DIR", "AGNI_WEB_DIR", "AGNI_TRUST_PROXY"];

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

function webRoot(): string {
  const root = tempDir("agni-web-");
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), "<html>app</html>");
  writeFileSync(join(root, "assets", "a.js"), "console.log(1)");
  process.env.AGNI_WEB_DIR = root;
  return root;
}

describe("routeAccess: which HTTP routes need a paired device", () => {
  test.each([
    ["GET", "/attachments", "device"],
    ["POST", "/attachments/validate", "device"],
    ["GET", "/attachments/att_x", "device"],
    ["POST", "/backgrounds", "device"],
    ["GET", "/backgrounds/bg_x", "device"],
    ["GET", "/debug/overview", "device"],
    ["GET", "/debug/turns/t1", "device"],
    ["DELETE", "/share/0123456789abcdef0123456789abcdef", "device"],
    ["GET", "/share/0123456789abcdef0123456789abcdef", "public"],
    ["HEAD", "/share/0123456789abcdef0123456789abcdef", "public"],
    ["POST", "/auth/pair", "public"],
    ["GET", "/auth/session", "public"],
    ["GET", "/health", "public"],
    ["GET", "/ws", "public"],
    ["GET", "/oauth/callback", "public"],
    ["GET", "/", "public"],
    ["GET", "/group", "public"],
    ["HEAD", "/task/abc", "public"],
    ["GET", "/assets/a.js", "public"],
  ] as const)("%s %s is %s", (method, path, expected) => {
    expect(routeAccess(method, path)).toBe(expected);
  });

  test("a path that only looks like a protected prefix is not skipped", () => {
    expect(routeAccess("GET", "/attachments/../debug/overview")).toBe("device");
    expect(routeAccess("GET", "/attachmentsx")).toBe("public");
    expect(routeAccess("GET", "/debug")).toBe("public"); // not a route; falls to the shell
  });
});

describe("authenticated routes answer 401 without a device, before any handler runs", () => {
  test.each([
    ["GET", "/attachments"],
    ["POST", "/attachments/validate"],
    ["POST", "/backgrounds"],
    ["GET", "/backgrounds/bg_x"],
    ["GET", "/debug/overview"],
    ["DELETE", "/share/0123456789abcdef0123456789abcdef"],
  ])("%s %s", async (method, path) => {
    harness = await startHarness();
    const response = await fetch(`${harness.base}${path}`, { method });
    expect(response.status).toBe(401);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("a revoked or unknown token is refused the same way", async () => {
    harness = await startHarness();
    const response = await fetch(`${harness.base}/debug/overview`, { headers: { authorization: "Bearer agni_nope" } });
    expect(response.status).toBe(401);
  });

  test("a foreign origin is refused with 403 before the auth check", async () => {
    harness = await startHarness();
    const response = await fetch(`${harness.base}/attachments`, { headers: { origin: "https://evil.example" } });
    expect(response.status).toBe(403);
  });

  test("a paired device still gets through", async () => {
    harness = await startHarness();
    const response = await fetch(`${harness.base}/debug/overview`, { headers: { authorization: `Bearer ${harness.token}` } });
    expect(response.status).toBe(200);
  });
});

describe("/health carries no CORS", () => {
  test("the liveness answer and the full report both omit Access-Control headers", async () => {
    harness = await startHarness();
    const plain = await fetch(`${harness.base}/health`, { headers: { origin: `http://127.0.0.1:${harness.server.port}` } });
    expect(plain.status).toBe(200);
    expect([...plain.headers.keys()].filter((name) => name.startsWith("access-control-"))).toEqual([]);
    const paired = await fetch(`${harness.base}/health`, { headers: { authorization: `Bearer ${harness.token}` } });
    expect([...paired.headers.keys()].filter((name) => name.startsWith("access-control-"))).toEqual([]);
    expect((await paired.json() as Record<string, unknown>).providers).toBeDefined();
  });

  test("a preflight gets no permission, and a foreign page cannot reach it at all", async () => {
    harness = await startHarness();
    const preflight = await fetch(`${harness.base}/health`, { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "GET" } });
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    const foreign = await fetch(`${harness.base}/health`, { headers: { origin: "https://evil.example" } });
    expect(foreign.status).toBe(403);
  });
});

describe("the app shell", () => {
  test.each(["/", "/group", "/task/abc", "/settings", "/agent/ea/deep/link"])("GET %s needs no pairing and carries the hardening headers", async (path) => {
    webRoot();
    harness = await startHarness();
    const response = await fetch(`${harness.base}${path}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<html>app</html>");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    const permissions = response.headers.get("permissions-policy") ?? "";
    for (const feature of ["camera=()", "microphone=()", "geolocation=()"]) expect(permissions).toContain(feature);
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
  });

  test("HEAD falls through to the shell too, and a POST to a shell path is a plain 404", async () => {
    webRoot();
    harness = await startHarness();
    expect((await fetch(`${harness.base}/group`, { method: "HEAD" })).status).toBe(200);
    expect((await fetch(`${harness.base}/group`, { method: "POST" })).status).toBe(404);
  });

  test("a static asset carries nosniff as well", async () => {
    webRoot();
    harness = await startHarness();
    const response = await fetch(`${harness.base}/assets/a.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("share pages", () => {
  test("strict headers beside the CSP", async () => {
    process.env.AGNI_SHARE_DIR = tempDir("agni-share-");
    harness = await startHarness();
    const doc: ShareDocument = {
      title: "t", agentName: "a", agentID: "ea", conversationID: "c", createdAt: new Date().toISOString(),
      records: [{ id: "u1", kind: "user", at: new Date().toISOString(), text: "hi" }],
    };
    const published = publishShare(doc, { baseURL: harness.base });
    const response = await fetch(`${harness.base}/share/${published.token}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("permissions-policy") ?? "").toContain("camera=()");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("RateLimiter", () => {
  test("allows `limit` attempts per window per key, then refuses with a retry time", () => {
    let now = 1_000_000;
    const limiter = new RateLimiter(5, 60_000, () => now);
    for (let i = 0; i < 5; i++) expect(limiter.attempt("a").ok).toBe(true);
    const refused = limiter.attempt("a");
    expect(refused.ok).toBe(false);
    expect(refused.retryAfterMs).toBeGreaterThan(0);
    expect(refused.retryAfterMs).toBeLessThanOrEqual(60_000);
    expect(limiter.attempt("b").ok).toBe(true); // another address is independent
    now += 60_001;
    expect(limiter.attempt("a").ok).toBe(true); // the window slid
  });

  test("a refused attempt does not extend the lockout, and the table stays bounded", () => {
    let now = 0;
    const limiter = new RateLimiter(2, 1_000, () => now, 50);
    limiter.attempt("a"); limiter.attempt("a");
    for (let i = 0; i < 20; i++) { now += 10; limiter.attempt("a"); }
    now += 1_000;
    expect(limiter.attempt("a").ok).toBe(true);
    for (let i = 0; i < 500; i++) limiter.attempt(`k${i}`);
    expect(limiter.size).toBeLessThanOrEqual(50 + 1);
  });
});

describe("pairing rate limit", () => {
  const pairWith = (base: string, headers: Record<string, string> = {}) => fetch(`${base}/auth/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base, ...headers },
    body: JSON.stringify({ code: "AAAA-AAAA", name: "x" }),
  });

  test("the sixth attempt in a minute from one address is 429 with Retry-After", async () => {
    harness = await startHarness();
    for (let i = 0; i < 5; i++) expect((await pairWith(harness.base)).status).toBe(401);
    const sixth = await pairWith(harness.base);
    expect(sixth.status).toBe(429);
    expect(Number(sixth.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  test("a valid code is refused while the address is limited, and still works from another address", async () => {
    // Behind `tailscale serve` the owner sets this so the proxy's entry names the caller.
    process.env.AGNI_TRUST_PROXY = "1";
    harness = await startHarness();
    for (let i = 0; i < 5; i++) await pairWith(harness.base, { "x-forwarded-for": "198.51.100.7" });
    const code = await mintPairCode(harness.db);
    const limited = await fetch(`${harness.base}/auth/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: harness.base, "x-forwarded-for": "198.51.100.7" },
      body: JSON.stringify({ code, name: "x" }),
    });
    expect(limited.status).toBe(429);
    const other = await fetch(`${harness.base}/auth/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: harness.base, "x-forwarded-for": "203.0.113.9" },
      body: JSON.stringify({ code, name: "x" }),
    });
    expect(other.status).toBe(200);
  });

  test("a client that invents its own X-Forwarded-For entries cannot widen its allowance", async () => {
    // Behind `tailscale serve` the owner sets this so the proxy's entry names the caller.
    process.env.AGNI_TRUST_PROXY = "1";
    harness = await startHarness();
    // The proxy appends the real peer last; entries a client put first are ignored.
    for (let i = 0; i < 5; i++) await pairWith(harness.base, { "x-forwarded-for": `10.0.0.${i}, 198.51.100.7` });
    expect((await pairWith(harness.base, { "x-forwarded-for": "10.9.9.9, 198.51.100.7" })).status).toBe(429);
  });

  test("a ceiling across all addresses stops a flood that rotates its address", async () => {
    // Behind `tailscale serve` the owner sets this so the proxy's entry names the caller.
    process.env.AGNI_TRUST_PROXY = "1";
    harness = await startHarness();
    let refused = 0;
    for (let i = 0; i < 40; i++) {
      const response = await pairWith(harness.base, { "x-forwarded-for": `192.0.2.${i}` });
      if (response.status === 429) refused++;
    }
    expect(refused).toBeGreaterThan(0);
  });
});

describe("session cookie", () => {
  async function pairBrowser(h: Harness): Promise<Response> {
    return fetch(`${h.base}/auth/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: h.base },
      body: JSON.stringify({ code: await mintPairCode(h.db), name: "Browser" }),
    });
  }

  test("lasts 30 days", async () => {
    harness = await startHarness();
    const response = await pairBrowser(harness);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=2592000");
  });

  test("a live session renews its cookie when the page checks in, and a stranger gets none", async () => {
    harness = await startHarness();
    const paired = await pairBrowser(harness);
    const cookie = (paired.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const renewed = await fetch(`${harness.base}/auth/session`, { headers: { cookie } });
    expect((await renewed.json() as { paired: boolean }).paired).toBe(true);
    const header = renewed.headers.get("set-cookie") ?? "";
    expect(header.split(";")[0]).toBe(cookie);
    expect(header).toContain("Max-Age=2592000");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Strict");
    const stranger = await fetch(`${harness.base}/auth/session`);
    expect(stranger.headers.get("set-cookie")).toBeNull();
    const bearer = await fetch(`${harness.base}/auth/session`, { headers: { authorization: `Bearer ${harness.token}` } });
    expect(bearer.headers.get("set-cookie")).toBeNull(); // a native client has no cookie to renew
  });

  test("the Secure flag follows the public origin and a forwarded https proxy", async () => {
    harness = await startHarness({ config: { publicOrigin: "https://box.tail1.ts.net" } });
    const paired = await pairBrowser(harness);
    const cookie = (paired.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    // Reached by its public https name: Secure. Reached by the loopback address: not (a Secure cookie on plain http would be dropped).
    const byName = await fetch(`${harness.base}/auth/session`, { headers: { cookie, host: "box.tail1.ts.net" } });
    expect(byName.headers.get("set-cookie")).toContain("Secure");
    const behindProxy = await fetch(`${harness.base}/auth/session`, { headers: { cookie, "x-forwarded-proto": "https" } });
    expect(behindProxy.headers.get("set-cookie")).toContain("Secure");
    const local = await fetch(`${harness.base}/auth/session`, { headers: { cookie } });
    expect(local.headers.get("set-cookie")).not.toContain("Secure");
  });
});

describe("socket limits", () => {
  function open(h: Harness): Promise<{ ws: WebSocket; closed: Promise<{ code: number; reason: string }> }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(h.url);
      const closed = new Promise<{ code: number; reason: string }>((done) => {
        ws.addEventListener("close", (event) => done({ code: event.code, reason: event.reason }));
      });
      ws.addEventListener("open", () => resolve({ ws, closed }), { once: true });
      ws.addEventListener("error", () => reject(new Error("cannot connect")), { once: true });
    });
  }

  test("a frame larger than the payload limit ends the connection (Bun drops it; the client sees 1006, or 1009 where a close frame arrives)", async () => {
    harness = await startHarness();
    const { ws, closed } = await open(harness);
    ws.send("x".repeat(2 * 1024 * 1024));
    expect([1006, 1009]).toContain((await closed).code);
  });

  test("a frame well past the 100,000-character message cap but under the limit is answered, not dropped", async () => {
    harness = await startHarness();
    const client = await harness.connect();
    // 100,000 characters can be 400 KB of UTF-8 (more once JSON-escaped); the limit has to clear that.
    client.sendRaw("z".repeat(600_000) as never);
    await client.next("error");
    expect(client.closed).toBe(false);
  });

  test("a flood of frames on one connection is closed with 4029", async () => {
    harness = await startHarness();
    const { ws, closed } = await open(harness);
    for (let i = 0; i < 400; i++) ws.send("not a frame");
    const result = await closed;
    expect(result.code).toBe(4029);
    expect(result.reason).toBe("rate limited");
  });

  test("normal traffic is not limited", async () => {
    harness = await startHarness();
    const client = await harness.connect();
    for (let i = 0; i < 30; i++) client.send({ type: "approval.rules.list" });
    await Bun.sleep(100);
    expect(client.closed).toBe(false);
  });
});

describe("developer flow (AGNI_DEV=1, the Vite dev server in front)", () => {
  test("the gate, /health and pairing still work for the dev origin, and only for it", async () => {
    process.env.AGNI_DEV = "1";
    harness = await startHarness();
    const vite = { origin: "http://127.0.0.1:5173", host: "127.0.0.1:5173" };
    expect((await fetch(`${harness.base}/health`, { headers: vite })).status).toBe(200);
    expect((await fetch(`${harness.base}/debug/overview`, { headers: { ...vite, authorization: `Bearer ${harness.token}` } })).status).toBe(200);
    expect((await fetch(`${harness.base}/debug/overview`, { headers: vite })).status).toBe(401);
    const paired = await fetch(`${harness.base}/auth/pair`, {
      method: "POST",
      headers: { ...vite, "content-type": "application/json" },
      body: JSON.stringify({ code: await mintPairCode(harness.db), name: "Dev browser" }),
    });
    expect(paired.status).toBe(200);
    expect(paired.headers.get("set-cookie")).toContain("Max-Age=2592000");
    expect((await fetch(`${harness.base}/debug/overview`, { headers: { ...vite, origin: "http://127.0.0.1:5174", host: "127.0.0.1:5173" } })).status).toBe(403);
  });
});
