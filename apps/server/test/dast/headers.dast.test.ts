import { afterEach, describe, expect, test } from "bun:test";
import { publishShare } from "../../src/share/document";
import type { ShareDocument } from "../../src/share/render";
import { startDast, type Dast } from "./dast-harness";

/**
 * S3-12 / S3-05: the security headers on what the server serves as a page:
 * the app shell (every GET that falls through to the web app), share pages,
 * the OAuth callback page, and `/health`.
 */

let dast: Dast | undefined;
afterEach(async () => {
  await dast?.stop();
  dast = undefined;
});

function sampleDoc(): ShareDocument {
  return {
    title: "Header check",
    agentName: "Agni",
    agentID: "ea",
    conversationID: "cnv_headers",
    createdAt: new Date().toISOString(),
    records: [{ id: "u1", kind: "user", at: new Date().toISOString(), text: "hello" }],
  };
}

/** Policies that leak the full URL (path and query) to other sites. */
const LEAKY_REFERRER = new Set(["unsafe-url", "no-referrer-when-downgrade", "origin-when-cross-origin", ""]);

function directive(csp: string, name: string): string | undefined {
  return csp.split(";").map((part) => part.trim()).find((part) => part === name || part.startsWith(`${name} `));
}

/** What is wrong with a page's hardening headers: an empty list when nothing is. Reported whole, so one run names every gap. */
function hardeningProblems(response: Response): string[] {
  const headers = response.headers;
  const problems: string[] = [];
  if (headers.get("x-content-type-options") !== "nosniff") problems.push("x-content-type-options is not nosniff");
  const referrer = headers.get("referrer-policy");
  if (referrer === null) problems.push("referrer-policy missing");
  else if (LEAKY_REFERRER.has(referrer.toLowerCase())) problems.push(`referrer-policy leaks: ${referrer}`);
  const permissions = headers.get("permissions-policy");
  if (!permissions) problems.push("permissions-policy missing");
  // No powerful feature handed to every origin.
  else if (/=\s*\*/.test(permissions)) problems.push(`permissions-policy grants a feature to every origin: ${permissions}`);
  const csp = headers.get("content-security-policy") ?? "";
  if (directive(csp, "frame-ancestors") !== "frame-ancestors 'none'") problems.push("csp frame-ancestors is not 'none'");
  if (directive(csp, "base-uri") !== "base-uri 'none'") problems.push("csp base-uri is not 'none'");
  return problems;
}

function expectPageHardening(response: Response, label: string): void {
  expect({ label, problems: hardeningProblems(response) }).toEqual({ label, problems: [] });
}

describe("app shell headers", () => {
  test("every path that falls through to the web app carries the hardening headers", async () => {
    dast = await startDast();
    // The shell, its deep links, and a path that does not exist (the client router handles it).
    for (const path of ["/", "/index.html", "/group", "/task/tsk_1", "/settings", "/agent/ea", "/no/such/page"]) {
      const response = await fetch(`${dast.base}${path}`);
      expect({ path, status: response.status }).toEqual({ path, status: 200 });
      expect(await response.text()).toContain("agni-app-shell");
      expectPageHardening(response, `GET ${path}`);
    }
  });

  test("a HEAD request for the shell carries them too", async () => {
    dast = await startDast();
    const response = await fetch(`${dast.base}/settings`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expectPageHardening(response, "HEAD /settings");
  });

  test("scripts stay same-origin and the shell may not be framed or load plugins", async () => {
    dast = await startDast();
    const csp = (await fetch(`${dast.base}/`)).headers.get("content-security-policy") ?? "";
    expect(directive(csp, "script-src")).toBe("script-src 'self'");
    expect(directive(csp, "object-src")).toBe("object-src 'none'");
    expect(directive(csp, "default-src")).toBe("default-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*(unsafe-inline|unsafe-eval|\*|https?:)/);
  });

  test("the shell is not cached across a deploy", async () => {
    dast = await startDast();
    const cache = (await fetch(`${dast.base}/`)).headers.get("cache-control") ?? "";
    expect(cache).toMatch(/no-cache|no-store/);
  });
});

describe("share page headers", () => {
  test("a published export is served with a policy that runs nothing and loads nothing", async () => {
    dast = await startDast();
    const published = publishShare(sampleDoc(), { baseURL: dast.base });
    const response = await fetch(`${dast.base}/share/${published.token}`);
    expect(response.status).toBe(200);
    expectPageHardening(response, "share page");
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(directive(csp, "default-src")).toBe("default-src 'none'");
    expect(csp).not.toContain("script-src");
    expect(csp).not.toContain("connect-src");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  test("a revoked or unknown link answers with no content and the same headers' discipline", async () => {
    dast = await startDast();
    const response = await fetch(`${dast.base}/share/${"0".repeat(32)}`);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.text()).not.toContain("<script");
  });

  test("HTML in a shared message is inert: the page has no inline script and the text is escaped", async () => {
    dast = await startDast();
    const doc = sampleDoc();
    doc.records = [{ id: "u1", kind: "user", at: new Date().toISOString(), text: "<script>alert(1)</script><img src=x onerror=alert(2)>" }];
    const published = publishShare(doc, { baseURL: dast.base });
    const html = await (await fetch(`${dast.base}/share/${published.token}`)).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toMatch(/<img[^>]+onerror/i);
  });
});

describe("static pages from the server", () => {
  test("the OAuth callback page carries the hardening headers and no-store", async () => {
    dast = await startDast();
    const response = await fetch(`${dast.base}/oauth/callback`);
    expectPageHardening(response, "oauth callback");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  test("an OAuth error message is escaped, not reflected as markup", async () => {
    dast = await startDast();
    const response = await fetch(`${dast.base}/oauth/callback?error=${encodeURIComponent("<script>alert(1)</script>")}`);
    const html = await response.text();
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});

describe("/health", () => {
  test("has no CORS headers at all, for any origin, on GET and on a preflight", async () => {
    dast = await startDast();
    for (const origin of [undefined, "https://evil.example", dast.base]) {
      const headers = origin ? { origin } : undefined;
      const get = await fetch(`${dast.base}/health`, headers ? { headers } : undefined);
      const preflight = await fetch(`${dast.base}/health`, { method: "OPTIONS", headers: { ...(headers ?? {}), "access-control-request-method": "GET" } });
      for (const [label, response] of [["GET", get], ["OPTIONS", preflight]] as const) {
        const cors = [...response.headers.keys()].filter((name) => name.startsWith("access-control-"));
        expect({ origin, label, cors }).toEqual({ origin, label, cors: [] });
      }
    }
  });

  test("a page on a foreign origin cannot read it (no allow-origin means the browser blocks the read)", async () => {
    dast = await startDast();
    const response = await fetch(`${dast.base}/health`, { headers: { origin: "https://evil.example" } });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("an unauthenticated caller learns that the server is up and nothing else", async () => {
    dast = await startDast();
    const response = await fetch(`${dast.base}/health`);
    expect(response.status).toBe(200);
    const text = await response.text();
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    const allowed = new Set(["ok", "v", "serverTime", "uptimeMs"]);
    expect(Object.keys(body).filter((key) => !allowed.has(key))).toEqual([]);
    // Nothing about this machine, its providers, its owner or its paths.
    for (const forbidden of [dast.home, "providers", "usage", "apiKey", "api_key", "token", "device", "model", "capacity", "hostname", "version", "agni-dast"]) {
      expect({ forbidden, found: text.toLowerCase().includes(forbidden.toLowerCase()) }).toEqual({ forbidden, found: false });
    }
  });

  test("the answer is never cached and is not sniffable as anything else", async () => {
    dast = await startDast();
    const response = await fetch(`${dast.base}/health`);
    expect({
      cacheControl: response.headers.get("cache-control")?.includes("no-store") ?? false,
      nosniff: response.headers.get("x-content-type-options"),
      contentType: response.headers.get("content-type")?.startsWith("application/json") ?? false,
    }).toEqual({ cacheControl: true, nosniff: "nosniff", contentType: true });
  });

  test("a wrong, revoked or query-string token earns the same minimal answer", async () => {
    dast = await startDast();
    const minimal = Object.keys((await (await fetch(`${dast.base}/health`)).json()) as object).sort();
    for (const request of [
      fetch(`${dast.base}/health`, { headers: { authorization: "Bearer agni_nope" } }),
      fetch(`${dast.base}/health?token=${dast.harness.token}`),
      fetch(`${dast.base}/health`, { headers: { "x-agni-token": dast.harness.token } }),
    ]) {
      const body = (await (await request).json()) as object;
      expect(Object.keys(body).sort()).toEqual(minimal);
    }
  });

  test("only a request that carries a paired device gets the full report", async () => {
    dast = await startDast();
    const response = await fetch(`${dast.base}/health`, { headers: { authorization: `Bearer ${dast.harness.token}` } });
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.providers).toBeDefined();
  });
});
