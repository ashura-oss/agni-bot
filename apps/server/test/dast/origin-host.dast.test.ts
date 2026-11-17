import { afterEach, describe, expect, test } from "bun:test";
import { publishShare } from "../../src/share/document";
import type { ShareDocument } from "../../src/share/render";
import { startDast, upgrade, type Dast } from "./dast-harness";

/**
 * S3-12: a foreign Origin or Host is refused, over HTTP and over the socket.
 * Every refusal of a WebSocket handshake here is asserted as a plain HTTP
 * upgrade request (status 403), or in a child process: a failed handshake
 * inside the shared test process has crashed Bun before (Sprint 1).
 */

let dast: Dast | undefined;
let evilPage: ReturnType<typeof Bun.serve> | undefined;

afterEach(async () => {
  evilPage?.stop(true);
  evilPage = undefined;
  await dast?.stop();
  dast = undefined;
});

function sampleDoc(): ShareDocument {
  return {
    title: "DAST export",
    agentName: "Agni",
    agentID: "ea",
    conversationID: "cnv_dast",
    createdAt: new Date().toISOString(),
    records: [{ id: "u1", kind: "user", at: new Date().toISOString(), text: "hello" }],
  };
}

/** Every route a browser can be pointed at, as [label, path, method]. */
function routes(shareToken: string): Array<[string, string, string]> {
  return [
    ["health", "/health", "GET"],
    ["app shell", "/", "GET"],
    ["app shell deep link", "/agent/ea", "GET"],
    ["auth session", "/auth/session", "GET"],
    ["auth pair", "/auth/pair", "POST"],
    ["auth logout", "/auth/logout", "POST"],
    ["share page", `/share/${shareToken}`, "GET"],
    ["share revoke", `/share/${shareToken}`, "DELETE"],
    ["oauth callback", "/oauth/callback", "GET"],
    ["attachments", "/attachments", "GET"],
    ["backgrounds", "/backgrounds/bg_x", "GET"],
    ["debug", "/debug/overview", "GET"],
  ];
}

describe("foreign Host header (DNS rebinding)", () => {
  test("is refused with 403 on every route and on the socket upgrade, even with a valid device token", async () => {
    dast = await startDast();
    const published = publishShare(sampleDoc(), { baseURL: dast.base });
    const hosts = [
      "evil.example",
      "localhost.evil.example",
      `127.0.0.1.evil.example:${dast.port}`,
      `evil.example:${dast.port}`,
      // The right name on a port this server is not on.
      "127.0.0.1:1",
      "localhost:1",
      // A userinfo trick: the URL parser would read the part after @ as the host.
      `127.0.0.1:${dast.port}@evil.example`,
    ];
    for (const host of hosts) {
      for (const [label, path, method] of routes(published.token)) {
        const response = await fetch(`${dast.base}${path}`, {
          method,
          headers: { host, authorization: `Bearer ${dast.harness.token}`, ...(method === "POST" ? { "content-type": "application/json" } : {}) },
          ...(method === "POST" ? { body: "{}" } : {}),
        });
        expect({ host, label, status: response.status }).toEqual({ host, label, status: 403 });
      }
      expect({ host, status: (await upgrade(dast.base, { host })).status }).toEqual({ host, status: 403 });
    }
  });

  test("a request with no Host header at all gets no answer from any route", async () => {
    dast = await startDast();
    for (const path of ["/health", "/auth/session", "/"]) {
      const text = await new Promise<string>((resolve) => {
        let received = "";
        const timer = setTimeout(() => resolve(received), 2000);
        void Bun.connect({
          hostname: "127.0.0.1",
          port: dast!.port,
          socket: {
            open(socket) { socket.write(`GET ${path} HTTP/1.0

`); },
            data(_s, data) { received += new TextDecoder().decode(data); },
            close() { clearTimeout(timer); resolve(received); },
            error() { clearTimeout(timer); resolve(received); },
          },
        });
      });
      expect({ path, served: /^HTTP\/1\.[01] 200/.test(text) }).toEqual({ path, served: false });
    }
  });

  test("the server's own names are still accepted (the refusal is not blanket)", async () => {
    dast = await startDast();
    for (const host of [`127.0.0.1:${dast.port}`, `localhost:${dast.port}`, `LOCALHOST:${dast.port}`]) {
      expect((await fetch(`${dast.base}/health`, { headers: { host } })).status).toBe(200);
    }
  });

  test("a spoofed X-Forwarded-Host or Forwarded header does not make a foreign name acceptable", async () => {
    dast = await startDast();
    const response = await fetch(`${dast.base}/health`, {
      headers: { host: "evil.example", "x-forwarded-host": `127.0.0.1:${dast.port}`, forwarded: `host=127.0.0.1:${dast.port}` },
    });
    expect(response.status).toBe(403);
  });
});

describe("foreign Origin", () => {
  const FOREIGN = ["https://evil.example", "http://localhost.evil.example", "null", "http://127.0.0.1.evil.example", "file://", "http://[::1]:1"];

  test("is refused on the socket upgrade", async () => {
    dast = await startDast();
    for (const origin of FOREIGN) {
      expect({ origin, status: (await upgrade(dast.base, { origin })).status }).toEqual({ origin, status: 403 });
    }
  });

  test("is refused on every state-changing or authenticated route, with or without credentials", async () => {
    dast = await startDast();
    const published = publishShare(sampleDoc(), { baseURL: dast.base });
    const guarded: Array<[string, string, string]> = [
      ["auth pair", "/auth/pair", "POST"],
      ["auth logout", "/auth/logout", "POST"],
      ["share revoke", `/share/${published.token}`, "DELETE"],
      ["attachments", "/attachments", "GET"],
      ["backgrounds", "/backgrounds/bg_x", "GET"],
      ["debug", "/debug/overview", "GET"],
    ];
    for (const origin of FOREIGN) {
      for (const [label, path, method] of guarded) {
        const credentialSets: Array<Record<string, string>> = [{}, { authorization: `Bearer ${dast.harness.token}` }, { cookie: `agni_session=${dast.harness.token}` }];
        for (const credentials of credentialSets) {
          const response = await fetch(`${dast.base}${path}`, {
            method,
            headers: { origin, ...credentials, ...(method === "POST" ? { "content-type": "application/json" } : {}) },
            ...(method === "POST" ? { body: JSON.stringify({ code: "AAAA-AAAA", name: "x" }) } : {}),
          });
          expect({ origin, label, creds: Object.keys(credentials)[0] ?? "none", status: response.status }).toEqual({ origin, label, creds: Object.keys(credentials)[0] ?? "none", status: 403 });
          // A refusal says nothing a foreign page could read.
          expect(response.headers.get("access-control-allow-origin")).toBeNull();
        }
      }
    }
    // The share link was not revoked by any of those.
    expect((await fetch(`${dast.base}/share/${published.token}`)).status).toBe(200);
  });

  test("a CORS preflight from a foreign origin gets no allow headers on any guarded route", async () => {
    dast = await startDast();
    for (const path of ["/attachments", "/backgrounds/bg_x", "/debug/overview", "/auth/pair", "/auth/logout", "/ws"]) {
      const response = await fetch(`${dast.base}${path}`, {
        method: "OPTIONS",
        headers: { origin: "https://evil.example", "access-control-request-method": "POST", "access-control-request-headers": "authorization" },
      });
      expect({ path, allow: response.headers.get("access-control-allow-origin") }).toEqual({ path, allow: null });
      expect({ path, ok: response.status < 300 }).toEqual({ path, ok: false });
    }
  });
});

describe("a page on another localhost port", () => {
  /** A real second server standing in for any local program a browser can be pointed at. */
  function startEvilPage(): string {
    evilPage = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<!doctype html><title>evil</title>", { headers: { "content-type": "text/html" } }) });
    return `http://127.0.0.1:${evilPage.port}`;
  }

  test("cannot open the socket, even riding the owner's session cookie (SameSite does not separate ports)", async () => {
    dast = await startDast();
    const evilOrigin = startEvilPage();
    const sessions: Array<Record<string, string>> = [{}, { cookie: `agni_session=${dast.harness.token}` }];
    for (const credentials of sessions) {
      const response = await upgrade(dast.base, { origin: evilOrigin, ...credentials });
      expect(response.status).toBe(403);
    }
    // And the same page by its other loopback name.
    const byName = `http://localhost:${evilPage!.port}`;
    expect((await upgrade(dast.base, { origin: byName, cookie: `agni_session=${dast.harness.token}` })).status).toBe(403);
  });

  test("a real WebSocket client sending that Origin fails the handshake (child process)", async () => {
    dast = await startDast();
    const evilOrigin = startEvilPage();
    const script = `
      const ws = new WebSocket(process.argv[1], { headers: { origin: process.argv[2], cookie: "agni_session=" + process.argv[3] } });
      ws.addEventListener("open", () => { console.log("OPEN"); process.exit(1); });
      ws.addEventListener("error", () => { console.log("REFUSED"); process.exit(0); });
      setTimeout(() => { console.log("TIMEOUT"); process.exit(2); }, 4000);
    `;
    const child = Bun.spawn([process.execPath, "-e", script, dast.harness.url, evilOrigin, dast.harness.token], { stdout: "pipe", stderr: "pipe" });
    const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect({ code, out: out.trim() }).toEqual({ code: 0, out: "REFUSED" });
  });

  test("the owner's own page still opens the socket (the refusal is not blanket)", async () => {
    dast = await startDast();
    const script = `
      const ws = new WebSocket(process.argv[1], { headers: { origin: process.argv[2] } });
      ws.addEventListener("open", () => { console.log("OPEN"); ws.close(); process.exit(0); });
      ws.addEventListener("error", () => { console.log("REFUSED"); process.exit(1); });
      setTimeout(() => { console.log("TIMEOUT"); process.exit(2); }, 4000);
    `;
    const child = Bun.spawn([process.execPath, "-e", script, dast.harness.url, dast.base], { stdout: "pipe", stderr: "pipe" });
    const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect({ code, out: out.trim() }).toEqual({ code: 0, out: "OPEN" });
  });

  test("is refused on the HTTP routes too, so it cannot read attachments or the debug data", async () => {
    dast = await startDast();
    const evilOrigin = startEvilPage();
    for (const path of ["/attachments", "/backgrounds/bg_x", "/debug/overview"]) {
      const response = await fetch(`${dast.base}${path}`, { headers: { origin: evilOrigin, authorization: `Bearer ${dast.harness.token}` } });
      expect({ path, status: response.status }).toEqual({ path, status: 403 });
    }
  });
});
