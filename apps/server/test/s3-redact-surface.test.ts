/**
 * The redaction module's production surface (Sprint 3 fix round). Two functions exist only for tests: one
 * empties the registry, one lets go of the anonymous hold. Production code imports `util/redact`, which does not
 * export them; tests import `util/redact-core`, where they live. No production file may import the core.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import * as surface from "../src/util/redact";

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
