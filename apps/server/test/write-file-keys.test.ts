/**
 * write_file means a path the way a refusal does (policy/path-key.ts): the native real path of the longest part that
 * exists, so a different case on disk or an 8.3 short name ends at one spelling, and the scratch boundary is judged on
 * those same keys. The file is still written under the on-disk spelling, never a folded one.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { canonicalPathKey } from "../src/policy/path-key";
import { isOutsideScratch, namesStream, resolveWritePath, writeFile } from "../src/tools/write-file";

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

/** Does the volume the tests write on make 8.3 names? Asked once, with a throwaway folder, so a test that needs them can say it was skipped for want of them. */
const SHORT_NAMES = (() => {
  if (!WINDOWS) return false;
  const probe = mkdtempSync(join(tmpdir(), "agni-wf-short-probe-"));
  try {
    const long = join(probe, "a-folder-with-a-long-name");
    mkdirSync(long);
    return shortNameOf(long) !== null;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

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

  // Skipped, and said so in its name, on a system that is not Windows or whose volume makes no 8.3 names.
  test.skipIf(!SHORT_NAMES)("a short-name spelling of a folder inside scratch is inside scratch, and is the same file (needs a Windows volume with 8.3 names)", () => {
    const long = join(scratch, "a-folder-with-a-long-name");
    mkdirSync(long);
    writeFileSync(join(long, "f.txt"), "x");
    const short = shortNameOf(long);
    expect(short, "the probe found 8.3 names on this volume, but this folder has none").not.toBeNull();
    expect(resolveWritePath(join(short!, "f.txt"))).toBe(join(long, "f.txt"));
    expect(isOutsideScratch(join(short!, "f.txt"), scratch)).toBe(false);
  });

  test("a path outside scratch is outside, however it is spelled", () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    expect(isOutsideScratch(outside, scratch)).toBe(true);
    expect(isOutsideScratch(join(scratch, "..", "outside", "x"), scratch)).toBe(true);
    expect(isOutsideScratch(join(scratch, "sub", "x"), scratch)).toBe(false);
  });
});

describe("a colon after the drive names a hidden stream, not a file", () => {
  test("the words for it: a colon after the drive on Windows, never on another system", () => {
    const streams = [String.raw`C:\scratch\notes.txt:hidden`, "notes.txt:hidden", String.raw`C:\scratch\a\b.txt::$DATA`, String.raw`\\?\C:\scratch\notes.txt:hidden`, String.raw`\\host\share\notes.txt:hidden`];
    for (const path of streams) {
      expect({ path, stream: namesStream(path, "win32") }).toEqual({ path, stream: true });
    }
    const files = [String.raw`C:\scratch\notes.txt`, "notes.txt", String.raw`\\?\C:\scratch\notes.txt`, String.raw`\\host\share\notes.txt`, "C:notes.txt", String.raw`sub\a b.txt`];
    for (const path of files) {
      expect({ path, stream: namesStream(path, "win32") }).toEqual({ path, stream: false });
    }
    // A colon is an ordinary character in a file name there.
    expect(namesStream("/home/me/scratch/a:b.txt", "linux")).toBe(false);
  });

  test.skipIf(!WINDOWS)("a path with a stream is not a path write_file resolves, and is outside scratch (so it asks)", () => {
    expect(resolveWritePath("notes.txt:hidden")).toBeNull();
    expect(resolveWritePath(join(scratch, "notes.txt:hidden"))).toBeNull();
    expect(isOutsideScratch("notes.txt:hidden", scratch)).toBe(true);
    expect(resolveWritePath(join(scratch, "notes.txt"))).not.toBeNull();
  });

  test.skipIf(!WINDOWS)("write_file refuses it, says why, and writes nothing", () => {
    expect(() => writeFile({ path: "notes.txt:hidden", content: "secret" })).toThrow(/stream|colon/i);
    expect(existsSync(join(scratch, "notes.txt"))).toBe(false);
    writeFileSync(join(scratch, "notes.txt"), "visible");
    expect(() => writeFile({ path: "notes.txt:hidden", content: "secret", append: true })).toThrow(/stream|colon/i);
    expect(readFileSync(join(scratch, "notes.txt"), "utf8")).toBe("visible");
  });
});
