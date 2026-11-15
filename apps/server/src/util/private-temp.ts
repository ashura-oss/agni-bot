import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restrictToOwnerOnWindows } from "./windows-acl";

/** Secure the directory before writing credentials or privileged scripts. */
export function privateTempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  try {
    if (process.platform === "win32") {
      restrictToOwnerOnWindows(directory, true);
    } else {
      chmodSync(directory, 0o700);
    }
    return directory;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
