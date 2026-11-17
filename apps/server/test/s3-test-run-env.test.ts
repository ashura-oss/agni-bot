/**
 * `AGNI_TEST_RUN` marks a test run (the OS credential store is then off limits). Only the test preload may set it: a
 * `config.env` that carries it must not make the daemon believe it is a test run, nor (set by accident) switch the
 * guard on for the owner's real server.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHomeEnv } from "../src/home";

let roots: string[] = [];
afterEach(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  roots = [];
});

test("loadHomeEnv ignores AGNI_TEST_RUN in config.env and still loads the other settings", () => {
  const home = mkdtempSync(join(tmpdir(), "agni-testrun-"));
  roots.push(home);
  writeFileSync(join(home, "config.env"), "AGNI_TEST_RUN=1\nAGNI_PORT=4321\n");
  const env: Record<string, string | undefined> = { AGNI_HOME: home };
  loadHomeEnv(env);
  expect(env.AGNI_TEST_RUN).toBeUndefined();
  expect(env.AGNI_PORT).toBe("4321");
});
