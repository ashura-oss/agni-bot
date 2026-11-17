/**
 * Sprint 3 merge fix round 3, item 2: some proxy services take the API key as the user name and leave the password empty or
 * out (`http://TOKEN:@host`, `http://TOKEN@host`). Then the user name is the secret, and it is masked like a password. When a
 * real password is there, the user name stays a plain name and is not masked.
 */
import { describe, expect, test } from "bun:test";
import { childEnv } from "../src/util/child-env";
import { proxyPasswords, registerProxyPasswords, stripProxyUserinfo } from "../src/util/proxy-env";
import { redact } from "../src/util/redact";

describe("the user name is registered when the password is empty or missing", () => {
  test("an empty password (`TOKEN:@host`) registers the user name", () => {
    expect(proxyPasswords({ HTTPS_PROXY: "http://tok-empty-pw-8812aa:@proxy.example:3128" })).toContain("tok-empty-pw-8812aa");
  });

  test("no colon at all (`TOKEN@host`) registers the user name", () => {
    expect(proxyPasswords({ HTTP_PROXY: "http://tok-no-colon-7731bb@proxy.example:3128" })).toContain("tok-no-colon-7731bb");
  });

  test("an address written without a scheme is read the same way", () => {
    expect(proxyPasswords({ ALL_PROXY: "tok-no-scheme-5520cc@proxy.example:3128" })).toContain("tok-no-scheme-5520cc");
  });

  test("a percent-encoded user name registers the written and the decoded form", () => {
    const found = proxyPasswords({ HTTPS_PROXY: "http://tok%2Fenc-4419dd@proxy.example:3128" });
    expect(found).toContain("tok%2Fenc-4419dd");
    expect(found).toContain("tok/enc-4419dd");
  });

  test("a user name beside a real password is not registered", () => {
    const found = proxyPasswords({ HTTPS_PROXY: "http://plain-user-name:real-password-3308ee@proxy.example:3128" });
    expect(found).toContain("real-password-3308ee");
    expect(found).not.toContain("plain-user-name");
  });

  test("an address with no credentials registers nothing", () => {
    expect(proxyPasswords({ HTTPS_PROXY: "http://proxy.example:3128", HTTP_PROXY: "http://@proxy.example:3128" })).toEqual([]);
  });
});

describe("the token is masked in text, and still kept out of a shell child", () => {
  test("registerProxyPasswords makes redact() mask a user-name token", () => {
    const text = "proxy http://tok-redact-6602ff@proxy.example:3128 refused";
    expect(redact(text)).toBe(text);
    registerProxyPasswords({ HTTPS_PROXY: "http://tok-redact-6602ff:@proxy.example:3128" });
    expect(redact(text)).not.toContain("tok-redact-6602ff");
  });

  test("a shell child's proxy variable has no token", () => {
    expect(stripProxyUserinfo("http://tok-child-1190ab@proxy.example:3128")).toBe("http://proxy.example:3128");
    expect(stripProxyUserinfo("http://tok-child-1190ab:@proxy.example:3128")).toBe("http://proxy.example:3128");
    const env = childEnv("shell", { source: { HTTPS_PROXY: "http://tok-child-1190ab@proxy.example:3128" }, platform: "linux", gitRoot: null });
    expect(JSON.stringify(env)).not.toContain("tok-child-1190ab");
  });
});
