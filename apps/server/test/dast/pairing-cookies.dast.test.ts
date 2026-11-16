import { afterEach, describe, expect, test } from "bun:test";
import { mintPairCode } from "../../src/auth/tokens";
import { cookieAttributes, maxAgeSeconds, startDast, type Dast } from "./dast-harness";

/**
 * S3-12 / S3-05: pairing (one-time code, rate limit) and the session cookie
 * it sets (HttpOnly, SameSite=Strict, Path=/, at most 30 days, Secure on https).
 */

let dast: Dast | undefined;
afterEach(async () => {
  await dast?.stop();
  dast = undefined;
});

const THIRTY_DAYS_S = 30 * 24 * 60 * 60;

function pair(server: Dast, code: string, extra: Record<string, string> = {}, origin = server.base): Promise<Response> {
  return fetch(`${server.base}/auth/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, ...extra },
    body: JSON.stringify({ code, name: "DAST browser" }),
  });
}

describe("pairing", () => {
  test("a one-time code pairs once and never again", async () => {
    dast = await startDast();
    const code = await mintPairCode(dast.harness.db);
    const first = await pair(dast, code);
    expect(first.status).toBe(200);
    expect((await pair(dast, code)).status).toBe(401);
    // Case and the dash do not matter, a wrong code does.
    const second = await mintPairCode(dast.harness.db);
    expect((await pair(dast, second.toLowerCase().replace("-", ""))).status).toBe(200);
  });

  test("an expired code is refused", async () => {
    dast = await startDast();
    const code = await mintPairCode(dast.harness.db, -1000);
    expect((await pair(dast, code)).status).toBe(401);
  });

  test("the answer carries no token: the browser never sees one", async () => {
    dast = await startDast();
    const code = await mintPairCode(dast.harness.db);
    const response = await pair(dast, code);
    const cookie = cookieAttributes(response)!;
    const body = await response.text();
    expect(body).not.toContain(cookie.value);
    expect(Object.keys(JSON.parse(body) as object).sort()).toEqual(["deviceName", "paired"]);
  });

  test("garbage bodies are a clean 4xx, not a crash", async () => {
    dast = await startDast();
    // Five attempts at most: the limiter allows five a minute per address.
    for (const body of ["", "not json", "[]", '{"code":["AAAA-AAAA"]}', '{"code":"' + "A".repeat(200_000) + '"}']) {
      const response = await fetch(`${dast.base}/auth/pair`, { method: "POST", headers: { "content-type": "application/json", origin: dast.base }, body });
      expect({ size: body.length, status: response.status }).toEqual({ size: body.length, status: 401 });
    }
    expect((await fetch(`${dast.base}/health`)).status).toBe(200);
  });

  test("a paired cookie opens the session check, and logout ends it", async () => {
    dast = await startDast();
    const paired = await pair(dast, await mintPairCode(dast.harness.db));
    const cookie = cookieAttributes(paired)!;
    const header = `${cookie.name}=${cookie.value}`;
    const session = await (await fetch(`${dast.base}/auth/session`, { headers: { cookie: header } })).json();
    expect(session).toEqual({ paired: true, deviceName: "DAST browser" });
    const out = await fetch(`${dast.base}/auth/logout`, { method: "POST", headers: { origin: dast.base, cookie: header } });
    expect(out.status).toBe(200);
    expect(await (await fetch(`${dast.base}/auth/session`, { headers: { cookie: header } })).json()).toEqual({ paired: false });
  });
});

describe("pairing rate limit (5 attempts a minute per address)", () => {
  test("the sixth attempt inside a minute is answered 429 with a Retry-After", async () => {
    dast = await startDast();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt++) statuses.push((await pair(dast, "AAAA-AAAA")).status);
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
    const limited = await pair(dast, "AAAA-AAAA");
    expect(limited.status).toBe(429);
    const wait = Number(limited.headers.get("retry-after"));
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(60);
  });

  test("a correct code does not get past the limit: otherwise the answers become a guessing oracle", async () => {
    dast = await startDast();
    for (let attempt = 0; attempt < 5; attempt++) await pair(dast, "BBBB-BBBB");
    const code = await mintPairCode(dast.harness.db);
    const response = await pair(dast, code);
    expect(response.status).toBe(429);
    expect(cookieAttributes(response)).toBeNull();
    // The code was not spent by the refused attempt, nor was a device created.
    expect(dast.harness.db.query<{ n: number }, []>("SELECT count(*) AS n FROM devices").get()!.n).toBe(1);
  });

  test("a spoofed X-Forwarded-For or Forwarded header does not give an attacker a fresh allowance", async () => {
    dast = await startDast();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 8; attempt++) {
      statuses.push((await pair(dast, "CCCC-CCCC", { "x-forwarded-for": `203.0.113.${attempt}`, forwarded: `for=198.51.100.${attempt}`, "x-real-ip": `192.0.2.${attempt}` })).status);
    }
    expect(statuses.slice(5)).toEqual([429, 429, 429]);
  });

  test("a request the Origin check already refuses does not use up the owner's allowance", async () => {
    dast = await startDast();
    for (let attempt = 0; attempt < 10; attempt++) {
      expect((await pair(dast, "DDDD-DDDD", {}, "https://evil.example")).status).toBe(403);
    }
    // The owner, from the real page, still gets their five tries.
    expect((await pair(dast, "DDDD-DDDD")).status).toBe(401);
  });
});

describe("session cookie", () => {
  test("is HttpOnly, SameSite=Strict, scoped to / with no Domain, and lasts at most 30 days", async () => {
    dast = await startDast();
    const response = await pair(dast, await mintPairCode(dast.harness.db));
    expect(response.status).toBe(200);
    const cookie = cookieAttributes(response)!;
    expect(cookie.name).toBe("agni_session");
    expect(cookie.attrs).toContain("httponly");
    expect(cookie.attrs).toContain("samesite=strict");
    expect(cookie.attrs).toContain("path=/");
    expect(cookie.attrs.some((attr) => attr.startsWith("domain="))).toBe(false);
    const maxAge = maxAgeSeconds(cookie.attrs);
    expect(maxAge).not.toBeNull();
    expect(maxAge!).toBeGreaterThan(0);
    // S3-05: shorter than the year it lasts today.
    expect(maxAge!).toBeLessThanOrEqual(THIRTY_DAYS_S);
    expect(cookie.attrs.some((attr) => attr.startsWith("expires="))).toBe(false);
  });

  test("is Secure when the page is served over https (a published origin)", async () => {
    dast = await startDast({ config: { publicOrigin: "https://box.tail1.ts.net" } });
    const code = await mintPairCode(dast.harness.db);
    const response = await fetch(`${dast.base}/auth/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://box.tail1.ts.net", host: "box.tail1.ts.net" },
      body: JSON.stringify({ code, name: "tailnet browser" }),
    });
    expect(response.status).toBe(200);
    expect(cookieAttributes(response)!.attrs).toContain("secure");
  });

  test("logout clears it with the same scope, so the browser actually drops it", async () => {
    dast = await startDast();
    const paired = await pair(dast, await mintPairCode(dast.harness.db));
    const cookie = cookieAttributes(paired)!;
    const out = await fetch(`${dast.base}/auth/logout`, { method: "POST", headers: { origin: dast.base, cookie: `${cookie.name}=${cookie.value}` } });
    const cleared = cookieAttributes(out)!;
    expect(cleared.name).toBe("agni_session");
    expect(cleared.value).toBe("");
    expect(maxAgeSeconds(cleared.attrs)).toBe(0);
    expect(cleared.attrs).toContain("path=/");
    expect(cleared.attrs).toContain("httponly");
    expect(cleared.attrs).toContain("samesite=strict");
  });

  test("a revoked device's cookie stops working at once", async () => {
    dast = await startDast();
    const paired = await pair(dast, await mintPairCode(dast.harness.db));
    const cookie = cookieAttributes(paired)!;
    const header = `${cookie.name}=${cookie.value}`;
    const device = dast.harness.db.query<{ id: string }, []>("SELECT id FROM devices WHERE name = 'DAST browser'").get()!.id;
    dast.harness.db.run("UPDATE devices SET revoked_at = ? WHERE id = ?", [new Date().toISOString(), device]);
    expect(await (await fetch(`${dast.base}/auth/session`, { headers: { cookie: header } })).json()).toEqual({ paired: false });
    expect((await fetch(`${dast.base}/debug/overview`, { headers: { cookie: header } })).status).toBe(401);
  });
});
