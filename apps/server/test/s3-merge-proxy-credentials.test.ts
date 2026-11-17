/**
 * Sprint 3 merge fix round 1, item 3: a proxy address can carry `user:password@`. The shell child (a command the model wrote)
 * gets the proxy so `git` and `curl` can reach the network, but not the password in it: `echo $HTTPS_PROXY` must not print it.
 * The server keeps the full address (it makes its own requests through it) and masks the password wherever it logs or stores text.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db";
import { startupS3 } from "../src/startup/s3";
import { childEnv } from "../src/util/child-env";
import { proxyPasswords, registerProxyPasswords, stripProxyUserinfo } from "../src/util/proxy-env";
import { redact } from "../src/util/redact";

const PASSWORD = "proxy-merge-canary-pass-4471";
const FULL = `http://agni-user:${PASSWORD}@proxy.corp.example:3128`;
const BARE = "http://proxy.corp.example:3128";

describe("a shell child's proxy variables carry no credentials", () => {
  test("HTTP_PROXY and HTTPS_PROXY lose user:password@, in either case, and keep the address", () => {
    const env = childEnv("shell", { source: { HTTP_PROXY: FULL, HTTPS_PROXY: FULL, http_proxy: FULL, https_proxy: FULL, NO_PROXY: "localhost" }, platform: "linux", gitRoot: null });
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) expect({ name, value: env[name] }).toEqual({ name, value: BARE });
    expect(env.NO_PROXY).toBe("localhost");
    expect(JSON.stringify(env)).not.toContain(PASSWORD);
    expect(JSON.stringify(env)).not.toContain("agni-user");
  });

  test("the daemon is still given the whole address: it needs the credentials for its own requests", () => {
    const env = childEnv("daemon", { source: { HTTPS_PROXY: FULL }, platform: "linux" });
    expect(env.HTTPS_PROXY).toBe(FULL);
  });

  test("the forms a proxy address is written in", () => {
    const cases: Array<[string, string]> = [
      [`user:${PASSWORD}@host.example:8080`, "host.example:8080"],
      [`socks5h://user:${PASSWORD}@host.example:1080`, "socks5h://host.example:1080"],
      [`http://user@host.example`, "http://host.example"],
      [`http://user:p%40ss%2Fword-${PASSWORD}@host.example:3128/`, "http://host.example:3128/"],
      // A raw @ in the password: the address starts after the last one before the path.
      [`http://user:pa@ss-${PASSWORD}@host.example:3128`, "http://host.example:3128"],
      [`HTTP://user:${PASSWORD}@host.example`, "HTTP://host.example"],
      [`http://user:${PASSWORD}@[::1]:3128`, "http://[::1]:3128"],
    ];
    for (const [written, expected] of cases) expect({ written, stripped: stripProxyUserinfo(written) }).toEqual({ written, stripped: expected });
  });

  test("an address with no credentials, an empty value and a path that contains an @ are left as they are", () => {
    for (const same of [BARE, "host.example:8080", "", "http://host.example:3128/path@thing", "http://host.example?next=a@b"]) expect(stripProxyUserinfo(same)).toBe(same);
  });
});

describe("the server masks a proxy password wherever it logs or stores text", () => {
  test("proxyPasswords reads every proxy variable, either case, with the encoded and the decoded form of the password", () => {
    const found = proxyPasswords({ HTTP_PROXY: FULL, https_proxy: `http://u:p%40ss-${PASSWORD}@h.example`, ALL_PROXY: `socks5://u:${PASSWORD}-all@h.example:1080`, NO_PROXY: "localhost", PATH: "/usr/bin" });
    expect(found).toContain(PASSWORD);
    expect(found).toContain(`p%40ss-${PASSWORD}`);
    expect(found).toContain(`p@ss-${PASSWORD}`);
    expect(found).toContain(`${PASSWORD}-all`);
  });

  test("registerProxyPasswords makes redact() mask it, and a proxy with no credentials registers nothing", () => {
    const text = `fetch failed: ${FULL} refused`;
    expect(redact(text)).toBe(text);
    registerProxyPasswords({ HTTPS_PROXY: BARE });
    expect(redact(text)).toBe(text);
    registerProxyPasswords({ HTTPS_PROXY: FULL });
    expect(redact(text)).not.toContain(PASSWORD);
  });
});

describe("the start hook", () => {
  const saved = process.env.HTTPS_PROXY;
  afterEach(() => {
    if (saved === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = saved;
  });

  test("masks the password of the server's own proxy setting", async () => {
    process.env.HTTPS_PROXY = FULL;
    const db = openDatabase(":memory:");
    try {
      expect(redact(`via ${FULL}`)).toContain(PASSWORD);
      await startupS3({ db, config: {} as never });
      expect(redact(`via ${FULL}`)).not.toContain(PASSWORD);
    } finally {
      db.close();
    }
  });
});
