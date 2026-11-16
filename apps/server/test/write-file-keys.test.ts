/**
 * write_file means a path the way a refusal does (policy/path-key.ts): the native real path of the longest part that
 * exists, so a different case on disk or an 8.3 short name ends at one spelling, and the scratch boundary is judged on
 * those same keys. The file is still written under the on-disk spelling, never a folded one.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { canonicalPathKey } from "../src/policy/path-key";
import { isOutsideScratch, resolveWritePath } from "../src/tools/write-file";

const WINDOWS = process.platform === "win32";
let root = "";
let scratch = "";
let saved: string | undefined;

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "agni-wf-keys-")));
  scratch = join(root, "scratch");
  mkdirSync(scratch, { recursive: true });
  saved = process.env.AGNI_SCRATCH_DIR;
  process.env.AGNI_SCRATCH_DIR = scratch;
});
afterEach(() => {
  if (saved === undefined) delete process.env.AGNI_SCRATCH_DIR; else process.env.AGNI_SCRATCH_DIR = saved;
  rmSync(root, { recursive: true, force: true });
});

/** The 8.3 name of a folder, or null when this volume has none. */
function shortNameOf(folder: string): string | null {
  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${folder.replaceAll("'", "''")}').ShortPath`], { encoding: "utf8", timeout: 20_000 }).trim();
    return out && out.toLowerCase() !== folder.toLowerCase() ? out : null;
  } catch {
    return null;
  }
}

describe("write_file's path is the refusal's key, kept in the on-disk spelling", () => {
  test.skipIf(!WINDOWS)("a different case names the on-disk spelling, not the spelling the model typed", () => {
    mkdirSync(join(scratch, "MixedDir"));
    writeFileSync(join(scratch, "MixedDir", "File.txt"), "x");
    expect(resolveWritePath("mixeddir/FILE.TXT")).toBe(join(scratch, "MixedDir", "File.txt"));
  });

  test("it agrees with the key a refusal is recorded under, once case is folded", () => {
    mkdirSync(join(scratch, "sub"));
    writeFileSync(join(scratch, "sub", "a.txt"), "x");
    for (const path of ["sub/a.txt", "sub/../sub/a.txt", "sub/new.txt", "SUB/A.TXT", "deep/er/new.txt"]) {
      const real = resolveWritePath(path)!;
      expect({ path, same: (WINDOWS ? real.toLowerCase() : real) === canonicalPathKey(path, scratch) }).toEqual({ path, same: true });
    }
  });

  test.skipIf(!WINDOWS)("a short-name spelling of a folder inside scratch is inside scratch, and is the same file", () => {
    const long = join(scratch, "a-folder-with-a-long-name");
    mkdirSync(long);
    writeFileSync(join(long, "f.txt"), "x");
    const short = shortNameOf(long);
    if (!short) return; // this volume makes no 8.3 names
    expect(resolveWritePath(join(short, "f.txt"))).toBe(join(long, "f.txt"));
    expect(isOutsideScratch(join(short, "f.txt"), scratch)).toBe(false);
  });

  test("a path outside scratch is outside, however it is spelled", () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    expect(isOutsideScratch(outside, scratch)).toBe(true);
    expect(isOutsideScratch(join(scratch, "..", "outside", "x"), scratch)).toBe(true);
    expect(isOutsideScratch(join(scratch, "sub", "x"), scratch)).toBe(false);
  });
});
