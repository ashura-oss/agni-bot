/**
 * Every injection test runs with its own throwaway AGNI_HOME, so nothing a tool
 * or the server writes by default can land in the real `~/.agni`.
 *
 * Not a test file (no `.test.`), so bun does not collect it.
 */
import { afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEYS = ["AGNI_HOME", "AGNI_SHARE_DIR", "AGNI_DB_PATH", "AGNI_PLUGINS_PATH", "AGNI_PROVIDER_CONFIG_PATH", "AGNI_LOG_PATH", "AGNI_PID_PATH"] as const;

/** Call once at the top of a test file. */
export function useThrowawayHome(): void {
  let home = "";
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of KEYS) saved[key] = process.env[key];
    for (const key of KEYS) delete process.env[key];
    home = mkdtempSync(join(tmpdir(), "agni-inj-home-"));
    process.env.AGNI_HOME = home;
    process.env.AGNI_SHARE_DIR = join(home, "share");
  });
  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(home, { recursive: true, force: true });
  });
}
