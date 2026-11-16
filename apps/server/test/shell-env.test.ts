/**
 * The bash tool's child processes must not inherit the server's secrets.
 * Provider keys sit in the daemon's environment (loaded from config.env), and
 * a model-written command such as `env` or `echo $OPENROUTER_API_KEY` would
 * read them. The allowlist itself (names, PATH) is tested in
 * child-env.test.ts; these tests run real commands. Every value is made up.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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

describe("runBash child environment", () => {
  test("a provider key in the server's environment is not visible to the command", async () => {
    setEnv("OPENROUTER_API_KEY", FAKE);
    const result = await bash.runBash({ command: 'echo "[${OPENROUTER_API_KEY}]"' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("[]");
  });

  test("the key is absent from the whole environment dump, and an unlisted variable is absent too", async () => {
    setEnv("OPENROUTER_API_KEY", FAKE);
    setEnv("GROQ_API_KEY", `${FAKE}-groq`);
    setEnv("AGNI_CUSTOM_KEY_1", `${FAKE}-custom`);
    setEnv("AGNI_TEST_HIDDEN", "hidden");
    const result = await bash.runBash({ command: "env" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(FAKE);
    expect(result.stdout).not.toMatch(/OPENROUTER_API_KEY|GROQ_API_KEY|AGNI_CUSTOM_KEY_1/);
    // An allowlist: a variable that is not named in child-env.ts is not passed, secret or not.
    expect(result.stdout).not.toContain("AGNI_TEST_HIDDEN");
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
