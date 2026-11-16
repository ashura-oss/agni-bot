/**
 * S3-9 item 2: the vault passphrase file must be readable by its owner only.
 * A file open to other accounts is closed if it can be, and otherwise the vault
 * does not unlock (the server then refuses to start); it is never just used.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPassphraseFile } from "../src/secrets/passphrase";
import { VaultError } from "../src/secrets";
import { isOwnerOnlyFile, type PosixFs } from "../src/util/private-file";
import { withFailingAcl } from "./acl-helper";

let roots: string[] = [];
const fresh = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "agni-pp-"));
  roots.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  roots = [];
});

const PASSPHRASE = "correct horse battery staple";

/** A POSIX file system that reports `mode` for the file and lets `chmod` succeed (the mode then becomes 600) or fail. */
function posix(mode: number, chmodWorks: boolean): PosixFs & { chmods: number[] } {
  let current = mode;
  const chmods: number[] = [];
  return {
    chmods,
    getuid: () => 1000,
    statSync: () => ({ mode: 0o100000 | current, uid: 1000, isDirectory: () => false }),
    chmodSync: (_path, wanted) => {
      chmods.push(wanted);
      if (!chmodWorks) throw new Error("operation not permitted");
      current = wanted;
    },
  };
}

describe("macOS and Linux (file system injected)", () => {
  test("a passphrase file open to the group or others that cannot be closed is refused, and the passphrase is not returned", () => {
    const dir = fresh();
    const file = join(dir, "pp");
    writeFileSync(file, `${PASSPHRASE}\n`);
    const env = { AGNI_VAULT_PASSPHRASE_FILE: file };
    let error: unknown;
    try {
      readPassphraseFile(env, { platform: "linux", fs: posix(0o644, false) });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(VaultError);
    expect((error as VaultError).code).toBe("PASSPHRASE_REJECTED");
    expect((error as VaultError).message).toContain("passphrase file");
    expect((error as VaultError).message).not.toContain(PASSPHRASE);
  });

  test("a passphrase file open to others that can be closed is closed to mode 600 and then read", () => {
    const dir = fresh();
    const file = join(dir, "pp");
    writeFileSync(file, `${PASSPHRASE}\n`);
    const fs = posix(0o640, true);
    expect(readPassphraseFile({ AGNI_VAULT_PASSPHRASE_FILE: file }, { platform: "linux", fs })).toBe(PASSPHRASE);
    expect(fs.chmods).toEqual([0o600]);
  });

  test("an owner-only file (0600, or the 0400 systemd gives a credential) is read as before, with no chmod", () => {
    const dir = fresh();
    const file = join(dir, "pp");
    writeFileSync(file, `${PASSPHRASE}\n`);
    for (const mode of [0o600, 0o400]) {
      const fs = posix(mode, false);
      expect(readPassphraseFile({ AGNI_VAULT_PASSPHRASE_FILE: file }, { platform: "linux", fs })).toBe(PASSPHRASE);
      expect(fs.chmods).toEqual([]);
    }
  });

  test("a file that is not there is still 'no passphrase', not a permission error", () => {
    expect(readPassphraseFile({ AGNI_VAULT_PASSPHRASE_FILE: join(fresh(), "missing") }, { platform: "linux", fs: posix(0o644, false) })).toBeUndefined();
  });
});

describe("Windows (real ACLs)", () => {
  test.skipIf(process.platform !== "win32")("a passphrase file that inherits access for other accounts is made owner-only, then read", () => {
    const dir = fresh();
    const file = join(dir, "pp");
    writeFileSync(file, `${PASSPHRASE}\n`);
    expect(isOwnerOnlyFile(file)).toBe(false);
    expect(readPassphraseFile({ AGNI_VAULT_PASSPHRASE_FILE: file })).toBe(PASSPHRASE);
    expect(isOwnerOnlyFile(file)).toBe(true);
    expect(readFileSync(file, "utf8").trim()).toBe(PASSPHRASE);
  });

  test.skipIf(process.platform !== "win32")("when the access rules cannot be set or read, the vault is not unlocked with that file", () => {
    const dir = fresh();
    const file = join(dir, "pp");
    writeFileSync(file, `${PASSPHRASE}\n`);
    const result = withFailingAcl(() => {
      try {
        return readPassphraseFile({ AGNI_VAULT_PASSPHRASE_FILE: file });
      } catch (error) {
        return error;
      }
    });
    expect(result).toBeInstanceOf(VaultError);
    expect((result as VaultError).code).toBe("PASSPHRASE_REJECTED");
  });
});
