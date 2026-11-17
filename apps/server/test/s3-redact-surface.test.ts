/**
 * The redaction module's production surface (Sprint 3 fix round). Two functions exist only for tests: one
 * empties the registry, one lets go of the anonymous hold. Production code imports `util/redact`, which does not
 * export them; tests import `util/redact-core`, where they live. No production file may import the core.
 */
import { describe, expect, setSystemTime, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import * as surface from "../src/util/redact";
import { redact, releaseExpiredSecrets, rememberSecretsAt } from "../src/util/redact";

const SRC = resolve(import.meta.dir, "../src");
const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? sourceFiles(join(dir, name)) : name.endsWith(".ts") ? [join(dir, name)] : []));

describe("util/redact", () => {
  test("does not export the test-only functions", () => {
    expect("clearSecretsForTests" in surface).toBe(false);
    expect("unregisterSecret" in surface).toBe(false);
  });

  test("still exports what production code uses", () => {
    for (const name of ["redact", "registerSecret", "registerSecretFor", "releaseSecretFor", "rememberSecretsAt", "stageSecretsAt", "forgetSecretSlots", "holdbackLength", "registerSecretsFromEnv", "secretEnvNames", "REDACTED", "MAX_SECRETS", "RETIRED_MAX", "RETIRED_PER_SLOT", "secretCount", "releaseExpiredSecrets"]) {
      expect(name in surface).toBe(true);
    }
  });

  test("no production file imports redact-core except the module that re-exports it", () => {
    const offenders = sourceFiles(SRC).filter((file) => /redact-core/.test(readFileSync(file, "utf8")) && !file.endsWith(join("util", "redact.ts")));
    expect(offenders).toEqual([]);
  });
});

describe("the release API", () => {
  test("releaseSecretFor is used in production by secrets/vault.ts only (and defined in the redaction module)", () => {
    const allowed = [join("util", "redact.ts"), join("util", "redact-core.ts"), join("secrets", "vault.ts")];
    const offenders = sourceFiles(SRC).filter((file) => readFileSync(file, "utf8").includes("releaseSecretFor") && !allowed.some((suffix) => file.endsWith(suffix)));
    expect(offenders).toEqual([]);
  });

  test("releaseExpiredSecrets reads the clock itself: a caller cannot hand it a future time that unmasks live tokens", () => {
    expect(releaseExpiredSecrets.length).toBe(0);
    const HOUR = 3_600_000;
    rememberSecretsAt("conn", { value: "access-token-one-aaaa", expiresAt: Date.now() + HOUR });
    rememberSecretsAt("conn", "access-token-two-bbbb"); // the first is now retired, still valid for an hour
    (releaseExpiredSecrets as (now?: number) => void)(Date.now() + 2 * HOUR);
    expect(redact("x access-token-one-aaaa y")).toBe("x [redacted] y");
    try {
      setSystemTime(new Date(Date.now() + 2 * HOUR)); // time really passing is the only way it goes
      releaseExpiredSecrets();
      expect(redact("x access-token-one-aaaa y")).toBe("x access-token-one-aaaa y");
    } finally {
      setSystemTime();
    }
  });
});
