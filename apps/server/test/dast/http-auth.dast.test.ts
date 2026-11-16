import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mintToken, revokeDevice } from "../../src/auth/tokens";
import { publishShare } from "../../src/share/document";
import type { ShareDocument } from "../../src/share/render";
import { rawHttp, startDast, type Dast } from "./dast-harness";

/**
 * S3-12 / S3-05: authentication on the HTTP routes. Everything except the app
 * shell, pairing, the OAuth landing page, the liveness `/health` and a share
 * link (which is its own capability) needs a paired device, and a path cannot
 * be walked out of the folders the server serves from.
 */

let dast: Dast | undefined;
afterEach(async () => {
  await dast?.stop();
  dast = undefined;
});

function sampleDoc(): ShareDocument {
  return {
    title: "Auth check",
    agentName: "Agni",
    agentID: "ea",
    conversationID: "cnv_auth",
    createdAt: new Date().toISOString(),
    records: [{ id: "u1", kind: "user", at: new Date().toISOString(), text: "hello" }],
  };
}

const AUTHENTICATED_ROUTES: Array<[string, string, string]> = [
  ["attachment limits", "GET", "/attachments"],
  ["attachment upload", "POST", "/attachments"],
  ["attachment validate", "POST", "/attachments/validate"],
  ["attachment read", "GET", "/attachments/att_x"],
  ["attachment delete", "DELETE", "/attachments/att_x"],
  ["background upload", "POST", "/backgrounds"],
  ["background read", "GET", "/backgrounds/bg_x"],
  ["background delete", "DELETE", "/backgrounds/bg_x"],
  ["debug overview", "GET", "/debug/overview"],
  ["debug turn", "GET", "/debug/turns/trn_x"],
];

describe("routes that need a paired device", () => {
  test("refuse a request with no credential, a wrong token, a revoked token, or a token in the wrong place", async () => {
    dast = await startDast();
    const { token: revokedToken } = await mintToken(dast.harness.db, "revoked-device");
    revokeDevice(dast.harness.db, dast.harness.db.query<{ id: string }, []>("SELECT id FROM devices WHERE name = 'revoked-device'").get()!.id);
    const real = dast.harness.token;
    const attempts: Array<[string, Record<string, string>, string]> = [
      ["no credential", {}, ""],
      ["wrong bearer", { authorization: "Bearer agni_nope" }, ""],
      ["revoked bearer", { authorization: `Bearer ${revokedToken}` }, ""],
      ["revoked cookie", { cookie: `agni_session=${revokedToken}` }, ""],
      ["Basic scheme", { authorization: `Basic ${btoa(`x:${real}`)}` }, ""],
      ["token in a custom header", { "x-agni-token": real, "x-api-key": real }, ""],
      ["token in the query string", {}, `?token=${real}&access_token=${real}`],
      ["cookie under another name", { cookie: `session=${real}; token=${real}` }, ""],
    ];
    for (const [label, headers, query] of attempts) {
      for (const [route, method, path] of AUTHENTICATED_ROUTES) {
        const response = await fetch(`${dast.base}${path}${query}`, { method, headers, ...(method === "POST" ? { body: "{}" } : {}) });
        expect({ attempt: label, route, status: response.status }).toEqual({ attempt: label, route, status: 401 });
      }
    }
  });

  test("accept the same routes for a paired device, so the refusals above are about the credential", async () => {
    dast = await startDast();
    for (const [route, method, path] of AUTHENTICATED_ROUTES.filter(([, method]) => method === "GET")) {
      const bearer = await fetch(`${dast.base}${path}`, { method, headers: { authorization: `Bearer ${dast.harness.token}` } });
      const cookie = await fetch(`${dast.base}${path}`, { method, headers: { cookie: `agni_session=${dast.harness.token}` } });
      expect({ route, bearer: bearer.status === 401 || bearer.status === 403, cookie: cookie.status === 401 || cookie.status === 403 }).toEqual({ route, bearer: false, cookie: false });
    }
  });

  test("a share link is revoked only by a paired device, and an unpaired DELETE leaves it readable", async () => {
    dast = await startDast();
    const published = publishShare(sampleDoc(), { baseURL: dast.base });
    const url = `${dast.base}/share/${published.token}`;
    expect((await fetch(url, { method: "DELETE" })).status).toBe(401);
    expect((await fetch(url, { method: "DELETE", headers: { authorization: "Bearer agni_nope" } })).status).toBe(401);
    expect((await fetch(url)).status).toBe(200);
  });

  test("methods the app does not use are not routed to anything", async () => {
    dast = await startDast();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await fetch(`${dast.base}/`, { method, body: "x" });
      expect({ method, status: response.status }).toEqual({ method, status: 404 });
    }
    expect((await fetch(`${dast.base}/share/${"a".repeat(32)}`, { method: "POST", body: "x" })).status).toBe(405);
  });
});

describe("paths cannot leave the folders the server serves", () => {
  test("encoded and raw dot-dot segments never return a file outside the web folder", async () => {
    dast = await startDast();
    const variants = [
      "/../secret.txt",
      "/%2e%2e/secret.txt",
      "/%2e%2e%2fsecret.txt",
      "/..%2fsecret.txt",
      "/..%5csecret.txt",
      "/%2e%2e%5csecret.txt",
      "/assets/../../secret.txt",
      "/assets/%2e%2e/%2e%2e/secret.txt",
      "//secret.txt",
      "/%252e%252e/secret.txt",
      "/....//secret.txt",
      "/..;/secret.txt",
      `/..\\secret.txt`,
      "/%00../secret.txt",
    ];
    for (const path of variants) {
      const { status, body } = await rawHttp(dast.port, `GET ${path} HTTP/1.1`);
      expect({ path, leaked: body.includes(dast.secretText) }).toEqual({ path, leaked: false });
      expect({ path, ok: status === 200 || status === 400 || status === 404 }).toEqual({ path, ok: true });
    }
  });

  test("a share, debug or attachment path cannot be walked either, even for a paired device", async () => {
    dast = await startDast();
    const auth = { authorization: `Bearer ${dast.harness.token}` };
    const variants = [
      "/share/../secret.txt",
      "/share/%2e%2e/secret.txt",
      `/share/${"a".repeat(32)}/../../secret.txt`,
      "/share/..%2f..%2fsecret",
      "/attachments/..%2fsecret.txt",
      "/attachments/att_../../secret.txt",
      "/backgrounds/%2e%2e/secret.txt",
      "/debug/%2e%2e/secret.txt",
      `/debug/turns/..%2f${join("..", "secret.txt").replaceAll("\\", "%5c")}`,
    ];
    for (const path of variants) {
      const { body } = await rawHttp(dast.port, `GET ${path} HTTP/1.1`, auth);
      expect({ path, leaked: body.includes(dast.secretText) }).toEqual({ path, leaked: false });
    }
  });

  test("an overlong path or header is refused or ignored, never crashes the server", async () => {
    dast = await startDast();
    const long = "a".repeat(70_000);
    const first = await rawHttp(dast.port, `GET /${long} HTTP/1.1`);
    expect(first.status === 0 || first.status === 400 || first.status === 404 || first.status === 414 || first.status === 431 || first.status === 200).toBe(true);
    const second = await rawHttp(dast.port, "GET / HTTP/1.1", { "x-big": long });
    expect(second.status === 0 || second.status === 400 || second.status === 431 || second.status === 200).toBe(true);
    // Still serving.
    expect((await fetch(`${dast.base}/health`)).status).toBe(200);
  });
});
