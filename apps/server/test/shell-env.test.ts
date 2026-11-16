/**
 * The bash tool's child processes must not inherit the server's secrets.
 * Provider keys sit in the daemon's environment (loaded from config.env), and
 * a model-written command such as `env` or `echo $OPENROUTER_API_KEY` would
 * read them. Every value in these tests is a made-up string.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as bash from "../src/tools/bash";

const FAKE = "fake-key-value-do-not-use-0123456789";
const created: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function setEnv(name: string, value: string): void {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name];
  process.env[name] = value;
}

// Never read the owner's real ~/.agni/providers.json: point AGNI_HOME at an empty directory.
beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), "agni-shell-env-home-")); created.push(home);
  setEnv("AGNI_HOME", home);
  if (!("AGNI_PROVIDER_CONFIG_PATH" in savedEnv)) savedEnv.AGNI_PROVIDER_CONFIG_PATH = process.env.AGNI_PROVIDER_CONFIG_PATH;
  delete process.env.AGNI_PROVIDER_CONFIG_PATH;
});

afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete savedEnv[name];
  }
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** Every provider key variable named in providers.json's catalog, read from the source so a new provider cannot drift out of the scrub. */
function catalogKeyNames(): string[] {
  const source = readFileSync(join(import.meta.dir, "..", "src", "models", "providers.ts"), "utf8");
  return [...source.matchAll(/envKey:\s*"([A-Z0-9_]+)"/g)].map((match) => match[1]!);
}

describe("scrubbedShellEnv", () => {
  test("removes every provider key variable named in the provider catalog", () => {
    const names = catalogKeyNames();
    expect(names.length).toBeGreaterThanOrEqual(5);
    const env = Object.fromEntries(names.map((name) => [name, FAKE]));
    expect(bash.scrubbedShellEnv({ ...env, PATH: "/bin" })).toEqual({ PATH: "/bin" });
  });

  test("removes names ending in _API_KEY, _TOKEN, _SECRET or _PASSWORD in any case, and the AGNI and mail secrets", () => {
    const secrets = [
      "ANYTHING_API_KEY", "openrouter_api_key", "GITHUB_TOKEN", "NPM_TOKEN", "AWS_SESSION_TOKEN", "GOOGLE_OAUTH_CLIENT_SECRET",
      "DB_PASSWORD", "GMAIL_APP_PASSWORD", "GMAIL_OWNER_APP_PASSWORD", "AGNI_FIRECRAWL_API_KEY", "AGNI_CUSTOM_KEY_1", "AGNI_CUSTOM_KEY_17",
      "API_KEY", "TOKEN", "AWS_SECRET_ACCESS_KEY", "SIGNING_PRIVATE_KEY",
    ];
    const kept = bash.scrubbedShellEnv({ ...Object.fromEntries(secrets.map((name) => [name, FAKE])), PATH: "/bin" });
    expect(kept).toEqual({ PATH: "/bin" });
  });

  test("keeps ordinary variables, including ones that merely contain a secret-sounding word", () => {
    const ordinary = {
      PATH: "/usr/bin", Path: "C:\\Windows", HOME: "/home/o", USERPROFILE: "C:\\Users\\o", SystemRoot: "C:\\Windows", TEMP: "C:\\Temp", TMP: "C:\\Temp",
      LANG: "en_US.UTF-8", SHELL: "/bin/bash", AGNI_HOME: "/h", AGNI_PORT: "8787", AGNI_HOST: "127.0.0.1", GMAIL_USER: "o@example.com",
      GOOGLE_OAUTH_CLIENT_ID: "id", TOKENIZERS_PARALLELISM: "false", KEYBOARD_LAYOUT: "us", MONKEY: "1", AGNI_FIRST_TOKEN_TIMEOUT_MS: "30000",
    };
    expect(bash.scrubbedShellEnv(ordinary)).toEqual(ordinary);
  });

  test("removes the variable a custom endpoint names, whatever it is called", () => {
    const dir = mkdtempSync(join(tmpdir(), "agni-shell-env-")); created.push(dir);
    const config = join(dir, "providers.json");
    writeFileSync(config, JSON.stringify({ version: 1, models: {}, custom: [{ id: "custom", label: "Mine", baseUrl: "https://gw.example/v1", model: "m", envKey: "MY_GATEWAY_CRED" }] }));
    const env = { AGNI_PROVIDER_CONFIG_PATH: config, MY_GATEWAY_CRED: FAKE, PATH: "/bin" };
    expect(bash.scrubbedShellEnv(env)).toEqual({ AGNI_PROVIDER_CONFIG_PATH: config, PATH: "/bin" });
  });

  test("removes a copy of a loaded provider key held under an unrelated name", () => {
    const env = { OPENROUTER_API_KEY: FAKE, COPY_OF_THE_KEY: FAKE, SHORT: "abc", PATH: "/bin" };
    expect(bash.scrubbedShellEnv(env)).toEqual({ SHORT: "abc", PATH: "/bin" });
  });

  test("still scrubs by name when the provider config cannot be read", () => {
    const dir = mkdtempSync(join(tmpdir(), "agni-shell-env-")); created.push(dir);
    const config = join(dir, "providers.json");
    writeFileSync(config, "{ not json");
    const env = { AGNI_PROVIDER_CONFIG_PATH: config, GROQ_API_KEY: FAKE, PATH: "/bin" };
    expect(bash.scrubbedShellEnv(env)).toEqual({ AGNI_PROVIDER_CONFIG_PATH: config, PATH: "/bin" });
  });

  test("does not change the environment it was given", () => {
    const env = { GROQ_API_KEY: FAKE, PATH: "/bin" };
    bash.scrubbedShellEnv(env);
    expect(env).toEqual({ GROQ_API_KEY: FAKE, PATH: "/bin" });
  });
});

describe("runBash child environment", () => {
  test("a provider key in the server's environment is not visible to the command", async () => {
    setEnv("OPENROUTER_API_KEY", FAKE);
    const result = await bash.runBash({ command: 'echo "[${OPENROUTER_API_KEY}]"' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("[]");
  });

  test("the key is absent from the whole environment dump, and non-secret variables survive", async () => {
    setEnv("OPENROUTER_API_KEY", FAKE);
    setEnv("GROQ_API_KEY", `${FAKE}-groq`);
    setEnv("AGNI_CUSTOM_KEY_1", `${FAKE}-custom`);
    setEnv("AGNI_TEST_VISIBLE", "visible");
    const result = await bash.runBash({ command: "env" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(FAKE);
    expect(result.stdout).not.toMatch(/OPENROUTER_API_KEY|GROQ_API_KEY|AGNI_CUSTOM_KEY_1/);
    expect(result.stdout).toContain("AGNI_TEST_VISIBLE=visible");
    expect(result.stdout).toMatch(/^(PATH|Path)=/m);
  });

  test.skipIf(process.platform !== "win32")("the Windows spelling of the lookup prints nothing either", async () => {
    setEnv("OPENROUTER_API_KEY", FAKE);
    const result = await bash.runBash({ command: 'cmd.exe //c "echo [%OPENROUTER_API_KEY%]"' });
    expect(result.stdout).not.toContain(FAKE);
    // cmd leaves an unset variable as literal text; a set one would have been replaced.
    expect(result.stdout).toContain("[%OPENROUTER_API_KEY%]");
  });

  test("the privileged path (a secret is supplied) is scrubbed as well, and still gets its askpass helpers", async () => {
    setEnv("OPENROUTER_API_KEY", FAKE);
    setEnv("GMAIL_APP_PASSWORD", `${FAKE}-mail`);
    const result = await bash.runBash({ command: 'echo "[${OPENROUTER_API_KEY}][${GMAIL_APP_PASSWORD}]"; echo "askpass=${SUDO_ASKPASS}"', secret: "pw-for-test" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[][]");
    expect(result.stdout).not.toContain(FAKE);
    expect(result.stdout).toMatch(/askpass=\S+askpass\.sh/);
  });
});
