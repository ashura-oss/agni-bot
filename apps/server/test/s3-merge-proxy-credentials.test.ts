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

  test("an address with no credentials and an empty value are left as they are", () => {
    for (const same of [BARE, "host.example:8080", "", "socks5h://host.example:1080", "http://host.example:3128/", "http://[::1]:3128"]) expect(stripProxyUserinfo(same)).toBe(same);
  });
});

/**
 * Fix round 2, item 1. A plain split of the authority at the first `/`, `?` or `#` finds no `@` in `http://user:pa/ss@host:3128`,
 * so the address went through with its password. Now the address is parsed as a URL; an `@` anywhere that the parse cannot account for
 * leaves the variable out of the shell's environment altogether.
 */
describe("an address whose password a plain split would miss (fix round 2)", () => {
  const SECRET = "pw-canary-9931-xyz";
  /** The proxy variables a shell child is given (`child-env.ts` passes these two, in either case). */
  const NAMES = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"];
  const shellEnv = (name: string, value: string) => childEnv("shell", { source: { [name]: value, NO_PROXY: "localhost" }, platform: "linux", gitRoot: null });

  const DROPPED: Array<[string, string]> = [
    ["a / in the password", `http://user:pa/${SECRET}@host.example:3128`],
    ["a ? in the password", `http://user:pa?${SECRET}@host.example:3128`],
    ["a # in the password", `http://user:pa#${SECRET}@host.example:3128`],
    ["a number before the /", `http://user:1234/${SECRET}@host.example:3128`],
    ["a backslash", `http://user:12\\${SECRET}@host.example:3128`],
    ["no scheme and a /", `user:pa/${SECRET}@host.example:3128`],
    ["a scheme that is not http", `socks5h://user:pa/${SECRET}@host.example:1080`],
    ["a port that is not a number", `http://user:${SECRET}@host.example:notaport`],
    ["a space in the host", `http://user:${SECRET}@host example:3128`],
    ["an @ after the address (no way to tell it from a password)", `http://host.example:3128/path@${SECRET}`],
    ["an @ in the query", `http://host.example:3128?next=a@${SECRET}`],
  ];
  for (const [what, value] of DROPPED) {
    test(`left out of the shell's environment entirely: ${what}`, () => {
      for (const name of NAMES) {
        const env = shellEnv(name, value);
        expect({ name, present: name in env }).toEqual({ name, present: false });
        expect(JSON.stringify(env)).not.toContain(SECRET);
        expect(env.NO_PROXY).toBe("localhost");
      }
      expect(stripProxyUserinfo(value)).toBeNull();
    });
  }

  const STRIPPED: Array<[string, string, string]> = [
    ["an encoded / ? # and @", `http://user:a%2Fb%3Fc%23d%40${SECRET}@host.example:3128`, "http://host.example:3128"],
    ["an unencoded @", `http://user:pa@ss-${SECRET}@host.example:3128`, "http://host.example:3128"],
    ["two unencoded @", `http://user:p@a@${SECRET}@host.example:3128/`, "http://host.example:3128/"],
    ["an encoded @ and no scheme", `user:p%40ss-${SECRET}@host.example:3128`, "host.example:3128"],
    ["an unencoded : in the password", `http://user:a:b:${SECRET}@host.example:3128`, "http://host.example:3128"],
    ["a user and no password", `http://user-${SECRET}@host.example:3128`, "http://host.example:3128"],
  ];
  for (const [what, value, expected] of STRIPPED) {
    test(`the address survives and the credentials do not: ${what}`, () => {
      for (const name of NAMES) {
        const env = shellEnv(name, value);
        expect({ name, value: env[name] }).toEqual({ name, value: expected });
        expect(JSON.stringify(env)).not.toContain(SECRET);
      }
    });
  }

  test("an address with no @ anywhere is unchanged, whatever its name's case", () => {
    for (const name of NAMES) for (const same of [BARE, "host.example:8080", "socks5h://host.example:1080/"]) expect(shellEnv(name, same)[name]).toBe(same);
  });

  test("the daemon still gets every one of them whole", () => {
    for (const [, value] of DROPPED) expect(childEnv("daemon", { source: { HTTPS_PROXY: value }, platform: "linux" }).HTTPS_PROXY).toBe(value);
  });
});

describe("the server masks every form of a password it could not split cleanly (fix round 2)", () => {
  test("proxyPasswords finds the written and the decoded password, whatever hid the userinfo", () => {
    const found = (value: string) => proxyPasswords({ HTTPS_PROXY: value });
    expect(found("http://user:pa/slash-canary-0001@host.example:3128")).toContain("pa/slash-canary-0001");
    expect(found("http://user:pa?query-canary-0002@host.example:3128")).toContain("pa?query-canary-0002");
    expect(found("http://user:pa#hash-canary-0003@host.example:3128")).toContain("pa#hash-canary-0003");
    expect(found("http://user:12/num-canary-0004@host.example:3128")).toContain("12/num-canary-0004");
    const both = found("http://user:pa@at-canary-0005@host.example:3128");
    expect(both).toContain("pa@at-canary-0005");
    expect(both).toContain("pa%40at-canary-0005");
    const encoded = found("http://user:a%2Fb%40enc-canary-0006@host.example:3128");
    expect(encoded).toContain("a%2Fb%40enc-canary-0006");
    expect(encoded).toContain("a/b@enc-canary-0006");
  });

  test("registerProxyPasswords makes redact() mask both the written and the decoded form", () => {
    const written = "http://user:pa/reg-canary-0007@host.example:3128";
    const mixed = "http://user:pa@reg-canary-0008@host.example:3128";
    const text = "written pa/reg-canary-0007 raw pa@reg-canary-0008 encoded pa%40reg-canary-0008";
    expect(redact(text)).toBe(text);
    registerProxyPasswords({ HTTPS_PROXY: written, http_proxy: mixed });
    const masked = redact(text);
    expect(masked).not.toContain("reg-canary-0007");
    expect(masked).not.toContain("reg-canary-0008");
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

  test("masks the written and the decoded password of an address a plain split cannot read (fix round 2)", async () => {
    process.env.HTTPS_PROXY = "http://user:pa/start-canary-0009%40x@host.example:3128";
    const db = openDatabase(":memory:");
    try {
      const text = "via pa/start-canary-0009%40x and pa/start-canary-0009@x";
      expect(redact(text)).toBe(text);
      await startupS3({ db, config: {} as never });
      expect(redact(text)).not.toContain("start-canary-0009");
    } finally {
      db.close();
    }
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
