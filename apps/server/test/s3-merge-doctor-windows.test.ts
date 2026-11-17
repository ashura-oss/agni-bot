/**
 * Sprint 3 merge fix round 1, item 6: `agni doctor` on Windows (and macOS) does not tell the owner to use a systemd credential.
 * The passphrase keystore says how to give the passphrase; that is `LoadCredential=` in a service unit only on Linux. Elsewhere it is
 * a file named by `AGNI_VAULT_PASSPHRASE_FILE`. Throwaway home, no real credential store.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor } from "../src/cli/s3-doctor";
import { lockVault, setKeyStoreOverride } from "../src/secrets";

let home = "";
beforeEach(() => {
  lockVault();
  setKeyStoreOverride(null); // the passphrase keystore is real here; nothing reaches the OS store (AGNI_KEYSTORE=passphrase)
  home = mkdtempSync(join(tmpdir(), "agni-doctorwin-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const keystoreLine = (lines: string[]): string => lines.find((line) => line.startsWith("keystore:")) ?? "";

describe("the keystore line of agni doctor, with a passphrase keystore and no passphrase given", () => {
  for (const platform of ["win32", "darwin"] as const) {
    test(`${platform}: says to set AGNI_VAULT_PASSPHRASE_FILE and does not mention systemd`, async () => {
      const report = await runDoctor({ home, env: { AGNI_KEYSTORE: "passphrase" }, platform });
      const line = keystoreLine(report.lines);
      expect(line).toContain("PASSPHRASE_FILE");
      expect(line).not.toMatch(/systemd|LoadCredential/i);
    });
  }

  test("linux: still says to give it as a systemd credential", async () => {
    const report = await runDoctor({ home, env: { AGNI_KEYSTORE: "passphrase" }, platform: "linux" });
    expect(keystoreLine(report.lines)).toContain("LoadCredential=agni-vault-passphrase:");
  });

  test("the name of the passphrase backend does not mention systemd off Linux", async () => {
    const { backendLabel } = await import("../src/secrets/probe");
    expect(backendLabel("passphrase", "win32")).not.toMatch(/systemd/i);
    expect(backendLabel("passphrase", "darwin")).not.toMatch(/systemd/i);
    expect(backendLabel("passphrase", "linux")).toMatch(/systemd/i);
  });
});
