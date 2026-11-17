/**
 * `eraseFile` zero-fills a plaintext file that held secrets and deletes it. It must never write through something that
 * is not that file: a symlink would zero its target, a hard link would zero the other name's bytes too, a directory has
 * no bytes to zero. Those are left alone and refused (the callers report a refusal as "could not erase").
 */
import { afterEach, describe, expect, test } from "bun:test";
import { closeSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eraseFile } from "../src/credentials/vault-mode";

/** Whether this machine lets the test make a symlink (Windows needs developer mode or elevation). Decided once, at load. */
const canSymlink = ((): boolean => {
  const dir = mkdtempSync(join(tmpdir(), "agni-erase-probe-"));
  try {
    writeFileSync(join(dir, "target"), "x");
    symlinkSync(join(dir, "target"), join(dir, "link"), "file");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

let roots: string[] = [];
const fresh = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "agni-erase-"));
  roots.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  roots = [];
});

describe("eraseFile", () => {
  test("a regular file is zero-filled and removed", () => {
    const path = join(fresh(), "plugins.json.corrupt");
    writeFileSync(path, "secret-bytes");
    expect(eraseFile(path)).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  test("a file that is not there is not an error", () => {
    expect(eraseFile(join(fresh(), "none"))).toBe(false);
  });

  test("a file with another hard link is refused, and both names keep their bytes", () => {
    const dir = fresh();
    const path = join(dir, "plugins.json.corrupt");
    const other = join(dir, "other-name");
    writeFileSync(path, "secret-bytes");
    linkSync(path, other);
    expect(() => eraseFile(path)).toThrow(/hard link|other names|links/i);
    expect(readFileSync(path, "utf8")).toBe("secret-bytes");
    expect(readFileSync(other, "utf8")).toBe("secret-bytes");
  });

  test("the refusal for a file with another hard link says a plaintext copy may remain at the other name", () => {
    const dir = fresh();
    const path = join(dir, "plugins.json.corrupt");
    writeFileSync(path, "secret-bytes");
    linkSync(path, join(dir, "other-name"));
    expect(() => eraseFile(path)).toThrow(/plaintext copy[^.]*may (still )?remain[^.]*another (hard )?link/i);
  });

  test("a file that is held open elsewhere is overwritten in place: the open handle reads zeros afterwards", () => {
    const path = join(fresh(), "plugins.json.corrupt");
    writeFileSync(path, "secret-bytes");
    const fd = openSync(path, "r");
    try {
      try {
        eraseFile(path);
      } catch {
        // Some platforms refuse to delete a file that is open: the overwrite is what is checked here.
      }
      const seen = Buffer.alloc(12);
      readSync(fd, seen, 0, 12, 0);
      expect(seen.every((byte) => byte === 0)).toBe(true);
    } finally {
      closeSync(fd);
    }
  });

  test("a directory is refused and left in place", () => {
    const path = join(fresh(), "plugins.json.corrupt");
    mkdirSync(path);
    writeFileSync(join(path, "inside"), "x");
    expect(() => eraseFile(path)).toThrow(/regular file/i);
    expect(existsSync(join(path, "inside"))).toBe(true);
  });

  test.skipIf(!canSymlink)("a symlink is refused, and what it points to is not written to", () => {
    const dir = fresh();
    const target = join(dir, "precious");
    const link = join(dir, "plugins.json.corrupt");
    writeFileSync(target, "precious-bytes");
    symlinkSync(target, link, "file");
    expect(() => eraseFile(link)).toThrow(/regular file/i);
    expect(readFileSync(target, "utf8")).toBe("precious-bytes");
  });
});
