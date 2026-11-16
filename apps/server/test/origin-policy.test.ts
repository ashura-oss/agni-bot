import { describe, expect, test } from "bun:test";
import { createOriginPolicy, originConfigProblem, parseOriginList } from "../src/auth/origin";

/** Local-server security (a), (b), (f): exact Origin allowlist, Host check, CORS that echoes only allowed origins. */

const local = (extra: Partial<Parameters<typeof createOriginPolicy>[0]> = {}) =>
  createOriginPolicy({ host: "127.0.0.1", port: () => 8787, ...extra });

describe("origin allowlist", () => {
  test("allows the server's own origin on its own port, under every loopback name", () => {
    const policy = local();
    for (const origin of ["http://127.0.0.1:8787", "http://localhost:8787", "http://[::1]:8787"]) {
      expect(policy.originAllowed(origin)).toBe(true);
    }
  });

  test("refuses other loopback ports, other hosts, and look-alikes", () => {
    const policy = local();
    for (const origin of [
      "http://127.0.0.1:5174", // some other local port nobody configured
      "http://[::1]:5173", // Vite binds 127.0.0.1, not ::1
      "http://localhost:9999",
      "http://127.0.0.1", // default port is not 8787
      "https://127.0.0.1:8787", // wrong scheme
      "http://localhost.evil.example:8787",
      "http://evil.example",
      "https://evil.example",
      "null",
      "",
      "not a url",
      "file://",
    ]) {
      expect(policy.originAllowed(origin)).toBe(false);
    }
  });

  test("allows exactly the configured web origins and the public origin", () => {
    const policy = local({
      publicOrigin: "https://box.tail1.ts.net",
      extraOrigins: parseOriginList("http://127.0.0.1:5199, http://localhost:5199/some/path , ftp://x, nonsense"),
    });
    expect(policy.originAllowed("http://127.0.0.1:5199")).toBe(true);
    expect(policy.originAllowed("http://localhost:5199")).toBe(true);
    expect(policy.originAllowed("http://127.0.0.1:5198")).toBe(false);
    expect(policy.originAllowed("https://box.tail1.ts.net")).toBe(true);
    expect(policy.originAllowed("https://other.ts.net")).toBe(false);
    expect(policy.originAllowed("http://box.tail1.ts.net")).toBe(false);
  });

  test("a server bound to a Tailscale address allows its own address, not loopback", () => {
    const policy = createOriginPolicy({ host: "100.64.0.5", port: () => 8787 });
    expect(policy.originAllowed("http://100.64.0.5:8787")).toBe(true);
    expect(policy.originAllowed("http://127.0.0.1:8787")).toBe(false);
    expect(policy.originAllowed("http://100.64.0.5:9999")).toBe(false);
  });

  test("the port is read when asked, so a server bound to port 0 learns its real port", () => {
    let port = 0;
    const policy = createOriginPolicy({ host: "127.0.0.1", port: () => port });
    port = 40123;
    expect(policy.originAllowed("http://127.0.0.1:40123")).toBe(true);
    expect(policy.originAllowed("http://127.0.0.1:0")).toBe(false);
  });
});

describe("Vite dev server (AGNI_DEV only)", () => {
  test("a normal loopback run refuses the Vite dev origins and hosts", () => {
    const policy = local();
    for (const origin of ["http://127.0.0.1:5173", "http://localhost:5173"]) expect(policy.originAllowed(origin)).toBe(false);
    for (const host of ["127.0.0.1:5173", "localhost:5173"]) expect(policy.hostAllowed(host)).toBe(false);
  });

  test("a dev run on loopback accepts them", () => {
    const policy = local({ devServer: true });
    for (const origin of ["http://127.0.0.1:5173", "http://localhost:5173"]) expect(policy.originAllowed(origin)).toBe(true);
    for (const host of ["127.0.0.1:5173", "localhost:5173"]) expect(policy.hostAllowed(host)).toBe(true);
    expect(policy.originAllowed("http://127.0.0.1:5174")).toBe(false);
  });

  test("a dev flag does not widen a Tailscale or wildcard bind", () => {
    for (const host of ["100.64.0.5", "0.0.0.0"]) {
      const policy = createOriginPolicy({ host, port: () => 8787, devServer: true });
      expect(policy.originAllowed("http://127.0.0.1:5173")).toBe(false);
      expect(policy.hostAllowed("127.0.0.1:5173")).toBe(false);
    }
  });
});

describe("boot warning for a bind that locks browsers out", () => {
  test("a wildcard bind with nothing configured is an error that names the variables", () => {
    const warning = originConfigProblem({ host: "0.0.0.0", port: 8787 });
    expect(warning?.level).toBe("error");
    expect(warning?.message).toContain("AGNI_ALLOWED_ORIGINS");
    expect(warning?.message).toContain("AGNI_PUBLIC_ORIGIN");
  });

  test("a specific non-loopback bind with nothing configured warns that only that address works", () => {
    const warning = originConfigProblem({ host: "100.64.0.5", port: 8787 });
    expect(warning?.level).toBe("warn");
    expect(warning?.message).toContain("100.64.0.5:8787");
  });

  test("nothing to say for loopback, or when an origin is configured", () => {
    expect(originConfigProblem({ host: "127.0.0.1", port: 8787 })).toBeNull();
    expect(originConfigProblem({ host: "0.0.0.0", port: 8787, publicOrigin: "https://box.ts.net" })).toBeNull();
    expect(originConfigProblem({ host: "0.0.0.0", port: 8787, extraOrigins: ["http://192.168.1.9:8787"] })).toBeNull();
  });
});

describe("parseOriginList", () => {
  test("keeps only http(s) origins, strips paths, ignores junk", () => {
    expect(parseOriginList("http://a.test:1, https://b.test/path?x=1,ws://c.test,,garbage")).toEqual(["http://a.test:1", "https://b.test"]);
    expect(parseOriginList(undefined)).toEqual([]);
  });
});

describe("host header check (DNS rebinding)", () => {
  test("allows the bind address and loopback names on the real port", () => {
    const policy = local();
    for (const host of ["127.0.0.1:8787", "localhost:8787", "LOCALHOST:8787", "[::1]:8787"]) {
      expect(policy.hostAllowed(host)).toBe(true);
    }
  });

  test("refuses an attacker's name, even one that resolves to this machine", () => {
    const policy = local();
    for (const host of ["evil.example", "evil.example:8787", "127.0.0.1", "127.0.0.1:5174", "localhost.evil.example:8787", "", null]) {
      expect(policy.hostAllowed(host)).toBe(false);
    }
  });

  test("allows the public origin's host and the hosts of configured web origins", () => {
    const policy = local({ publicOrigin: "https://box.tail1.ts.net", extraOrigins: ["http://127.0.0.1:5199"] });
    expect(policy.hostAllowed("box.tail1.ts.net")).toBe(true);
    expect(policy.hostAllowed("box.tail1.ts.net:443")).toBe(true);
    expect(policy.hostAllowed("127.0.0.1:5199")).toBe(true);
    expect(policy.hostAllowed("box.tail1.ts.net:8787")).toBe(false);
  });

  test("a server bound to a Tailscale address allows that address on its port", () => {
    const policy = createOriginPolicy({ host: "100.64.0.5", port: () => 8787 });
    expect(policy.hostAllowed("100.64.0.5:8787")).toBe(true);
    expect(policy.hostAllowed("100.64.0.5")).toBe(false);
  });

  test("a wildcard bind still allows loopback, and nothing else without configuration", () => {
    const policy = createOriginPolicy({ host: "0.0.0.0", port: () => 8787 });
    expect(policy.hostAllowed("127.0.0.1:8787")).toBe(true);
    expect(policy.hostAllowed("192.168.1.9:8787")).toBe(false);
    const configured = createOriginPolicy({ host: "0.0.0.0", port: () => 8787, extraOrigins: ["http://192.168.1.9:8787"] });
    expect(configured.hostAllowed("192.168.1.9:8787")).toBe(true);
  });
});

describe("CORS", () => {
  const request = (origin?: string) => new Request("http://127.0.0.1:8787/attachments", { headers: origin ? { origin } : {} });

  test("echoes an allowed origin, never a wildcard", () => {
    const headers = local().cors(request("http://localhost:8787"), "GET, POST", "authorization, content-type");
    expect(headers["access-control-allow-origin"]).toBe("http://localhost:8787");
    expect(headers["vary"]).toContain("Origin");
  });

  test("gives a disallowed or absent origin no allow-origin header", () => {
    expect(local().cors(request("https://evil.example"), "GET", "x")["access-control-allow-origin"]).toBeUndefined();
    expect(local().cors(request(), "GET", "x")["access-control-allow-origin"]).toBeUndefined();
  });

  test("rejects a request from a foreign origin with 403", () => {
    expect(local().rejectForeignOrigin(request("https://evil.example"))?.status).toBe(403);
    expect(local().rejectForeignOrigin(request("http://127.0.0.1:8787"))).toBeNull();
    expect(local().rejectForeignOrigin(request())).toBeNull();
  });
});
