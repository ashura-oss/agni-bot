/**
 * Windows system tools (whoami, icacls) are called by absolute path, so the
 * PATH order cannot change what runs. Under Git Bash `whoami` is GNU
 * coreutils, which rejects `/user`; a planted `whoami.exe` earlier on PATH
 * would be run by the server with the owner's rights.
 */
import { describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { privateTempDir } from "../src/util/private-temp";

const systemRoot = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
const hostname = join(systemRoot, "System32", "hostname.exe");

describe("private directories do not depend on PATH order", () => {
  test.skipIf(process.platform !== "win32" || !existsSync(hostname))(
    "a decoy whoami.exe and icacls.exe at the front of PATH are never run",
    () => {
      const decoys = mkdtempSync(join(tmpdir(), "agni-decoy-"));
      const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
      const previous = process.env[pathKey];
      try {
        // hostname.exe prints no SID and exits 0 for any arguments.
        copyFileSync(hostname, join(decoys, "whoami.exe"));
        copyFileSync(hostname, join(decoys, "icacls.exe"));
        process.env[pathKey] = `${decoys}${delimiter}${previous ?? ""}`;
        const dir = privateTempDir("agni-decoy-check-");
        rmSync(dir, { recursive: true, force: true });
      } finally {
        if (previous === undefined) delete process.env[pathKey]; else process.env[pathKey] = previous;
        rmSync(decoys, { recursive: true, force: true });
      }
    },
  );
});
