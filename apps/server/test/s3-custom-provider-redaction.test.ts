/**
 * S3-9 item 4: at start the server registers every secret setting for
 * redaction, including the key variable of each custom provider, whatever the
 * owner named it (`MY_LAN_MODEL_PASSWD` has no `_KEY` or `_TOKEN` in it).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redact, unregisterSecret } from "../src/util/redact";
import { registerEnvSecrets } from "../src/ws/server";

const values: string[] = [];
let roots: string[] = [];
afterEach(() => {
  for (const value of values.splice(0)) unregisterSecret(value);
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  roots = [];
});

function providersFile(custom: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "agni-cp-"));
  roots.push(dir);
  const path = join(dir, "providers.json");
  writeFileSync(path, JSON.stringify({ version: 1, custom }));
  return path;
}

describe("registerEnvSecrets", () => {
  test("a custom provider's key is masked even when its variable name does not look like a secret", () => {
    const secret = "lan-model-credential-4f8a2c91";
    values.push(secret);
    const env = {
      AGNI_PROVIDER_CONFIG_PATH: providersFile([{ id: "custom", label: "LAN", baseUrl: "http://localhost:1234/v1", model: "m", envKey: "MY_LAN_MODEL_PASSWD", local: true }]),
      MY_LAN_MODEL_PASSWD: secret,
    };
    registerEnvSecrets(env);
    expect(redact(`Authorization: Bearer ${secret}`)).not.toContain(secret);
  });

  test("a value in an unrelated variable is not registered (the whole environment is not a secret)", () => {
    const harmless = "just-a-harmless-setting-value-123";
    values.push(harmless);
    registerEnvSecrets({ AGNI_PROVIDER_CONFIG_PATH: providersFile([]), SOME_HARMLESS_SETTING: harmless });
    expect(redact(`x ${harmless} y`)).toBe(`x ${harmless} y`);
  });

  test("provider keys and secret-shaped variables are still registered", () => {
    const groq = "gsk_startup_registered_0123456789";
    const shaped = "shaped-token-value-0123456789";
    values.push(groq, shaped);
    registerEnvSecrets({ AGNI_PROVIDER_CONFIG_PATH: providersFile([]), GROQ_API_KEY: groq, MY_SERVICE_TOKEN: shaped });
    expect(redact(`${groq} ${shaped}`)).not.toContain("gsk_");
    expect(redact(shaped)).not.toContain(shaped);
  });

  test("a missing or broken providers.json does not stop the server from starting", () => {
    const dir = mkdtempSync(join(tmpdir(), "agni-cp-"));
    roots.push(dir);
    expect(() => registerEnvSecrets({ AGNI_PROVIDER_CONFIG_PATH: join(dir, "nope.json") })).not.toThrow();
  });
});
