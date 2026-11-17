/**
 * S3-07: a custom provider's endpoint is https, except on this machine; a
 * private-network, link-local or metadata host needs `"local": true` on the
 * entry in providers.json. The rule is enforced when an endpoint is added AND
 * when providers.json is loaded, because the file can be edited by hand.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCustomBaseUrl, loadCustomProviders, loadProviders, validateCustomBaseUrl } from "../src/models/providers";
import { addProviderCredential } from "../src/models/provider-settings";
import { HealthTracker } from "../src/models/health";
import { Router } from "../src/models/router";

describe("validateCustomBaseUrl", () => {
  test.each([
    "https://api.example.com/v1",
    "https://api.example.com",
    "https://gateway.example.com/openai/v1/",
    "https://203.0.113.9/v1",
    "https://[2001:db8::1]/v1",
  ])("accepts the public https endpoint %s", (url) => {
    expect(validateCustomBaseUrl(url)).toBe(url.replace(/\/+$/, ""));
  });

  test.each([
    "http://localhost:1234/v1",
    "http://127.0.0.1:8080/v1",
    "http://127.5.5.5/v1",
    "http://[::1]:11434/v1",
    "http://ollama.localhost:11434/v1",
    "https://localhost:8443/v1",
  ])("accepts %s: loopback may use http", (url) => {
    expect(validateCustomBaseUrl(url)).toBe(url);
  });

  test.each([
    ["http://api.example.com/v1", "scheme"],
    ["http://203.0.113.9/v1", "scheme"],
    ["ftp://api.example.com/v1", "invalid"],
    ["file:///etc/passwd", "invalid"],
    ["javascript:alert(1)", "invalid"],
    ["not a url", "invalid"],
    ["", "invalid"],
    ["https://", "invalid"],
  ])("refuses %s (%s)", (url, reason) => {
    expect(validateCustomBaseUrl(url)).toBeNull();
    const verdict = checkCustomBaseUrl(url);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe(reason as "scheme" | "invalid");
  });

  test.each([
    "https://10.0.0.5/v1",
    "https://192.168.1.20:8443/v1",
    "https://172.16.0.9/v1",
    "https://172.31.255.1/v1",
    "https://169.254.169.254/v1",
    "https://169.254.169.254/latest/meta-data",
    "https://100.64.0.7/v1",
    "https://0.0.0.0/v1",
    "https://[fd00::1]/v1",
    "https://[fe80::1]/v1",
    "https://[::ffff:10.0.0.1]/v1",
    "https://metadata.google.internal/v1",
    "https://printer.local/v1",
    "https://llm.lan/v1",
    "https://intranet/v1",
    "https://gpu-box.home.arpa/v1",
  ])("a private or metadata host needs the local flag: %s", (url) => {
    const verdict = checkCustomBaseUrl(url);
    expect(verdict).toMatchObject({ ok: false, reason: "private" });
    expect(validateCustomBaseUrl(url)).toBeNull();
    // The explicit flag lifts only this check.
    expect(checkCustomBaseUrl(url, { local: true }).ok).toBe(true);
    expect(validateCustomBaseUrl(url, { local: true })).toBe(url.replace(/\/+$/, ""));
  });

  test("other spellings of the loopback address are loopback too", () => {
    for (const url of ["http://localhost./v1", "http://2130706433/v1", "http://0x7f.1/v1", "http://127.1/v1"]) {
      expect(checkCustomBaseUrl(url).ok).toBe(true);
    }
  });

  test("the local flag allows http to a private host but never to a public one", () => {
    expect(checkCustomBaseUrl("http://192.168.1.20:1234/v1", { local: true }).ok).toBe(true);
    expect(checkCustomBaseUrl("http://192.168.1.20:1234/v1")).toMatchObject({ ok: false, reason: "private" });
    expect(checkCustomBaseUrl("http://api.example.com/v1", { local: true })).toMatchObject({ ok: false, reason: "scheme" });
  });

  test("the local flag does not make an unparseable or non-http URL acceptable", () => {
    expect(checkCustomBaseUrl("ftp://10.0.0.1/v1", { local: true })).toMatchObject({ ok: false, reason: "invalid" });
  });
});

// --- enforcement at load time -----------------------------------------------

let roots: string[] = [];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const name of ["AGNI_HOME", "AGNI_PROVIDER_CONFIG_PATH", "AGNI_SECRETS_MODE", "AGNI_CUSTOM_KEY_1", "AGNI_CUSTOM_KEY_2", "AGNI_CUSTOM_KEY_3"]) saved[name] = process.env[name];
  delete process.env.AGNI_SECRETS_MODE;
});
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  roots = [];
});

function homeWith(custom: unknown[]): string {
  const home = mkdtempSync(join(tmpdir(), "agni-urls-"));
  roots.push(home);
  process.env.AGNI_HOME = home;
  delete process.env.AGNI_PROVIDER_CONFIG_PATH;
  writeFileSync(join(home, "providers.json"), JSON.stringify({ version: 1, models: {}, custom }));
  return home;
}

describe("providers.json is enforced when it is loaded", () => {
  const entry = (id: string, baseUrl: string, extra: object = {}) => ({ id, label: id, baseUrl, model: "m", envKey: `KEY_${id.toUpperCase().replace(/-/g, "_")}`, ...extra });

  test("a hand-edited cleartext or private endpoint does not become a provider, and its key is not sent there", () => {
    homeWith([
      entry("custom", "http://api.example.com/v1"),
      entry("custom-2", "https://169.254.169.254/v1"),
      entry("custom-3", "https://api.example.com/v1"),
    ]);
    const env = { AGNI_HOME: process.env.AGNI_HOME, KEY_CUSTOM: "k1", KEY_CUSTOM_2: "k2", KEY_CUSTOM_3: "k3" };
    const providers = loadProviders(env);
    expect(providers.map((provider) => provider.id)).toEqual(["custom-3"]);
  });

  test("local: true opts a private endpoint in; only the literal true counts", () => {
    homeWith([
      entry("custom", "http://192.168.1.20:1234/v1", { local: true }),
      entry("custom-2", "http://192.168.1.21:1234/v1", { local: "yes" }),
      entry("custom-3", "http://192.168.1.22:1234/v1", { local: 1 }),
    ]);
    const env = { AGNI_HOME: process.env.AGNI_HOME, KEY_CUSTOM: "k1", KEY_CUSTOM_2: "k2", KEY_CUSTOM_3: "k3" };
    expect(loadProviders(env).map((provider) => provider.id)).toEqual(["custom"]);
  });

  test("a refused entry still reports its key variable, so the shell scrub and the vault classifier keep covering it", () => {
    homeWith([entry("custom", "http://api.example.com/v1")]);
    expect(loadCustomProviders({ AGNI_HOME: process.env.AGNI_HOME }).map((item) => item.envKey)).toEqual(["KEY_CUSTOM"]);
  });
});

describe("adding an endpoint from Settings", () => {
  const freshRouter = () => new Router([], new HealthTracker());

  test("an http endpoint on the internet is refused, nothing is written, and the message says why", async () => {
    const home = homeWith([]);
    delete process.env.AGNI_CUSTOM_KEY_1;
    const result = await addProviderCredential(freshRouter(), "custom", "sk-test-key-123456", "m", { baseUrl: "http://api.example.com/v1" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/https/);
    expect(process.env.AGNI_CUSTOM_KEY_1).toBeUndefined();
    expect(loadCustomProviders({ AGNI_HOME: home })).toEqual([]);
  });

  test("a private endpoint is refused with a message that names the local flag; Settings cannot set it", async () => {
    homeWith([]);
    const result = await addProviderCredential(freshRouter(), "custom", "sk-test-key-123456", "m", { baseUrl: "https://192.168.1.20/v1" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/local/);
  });
});
