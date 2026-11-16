/**
 * S3-04: AGNI_HOME is verified private at every start (Windows ACL; modes on
 * macOS and Linux), and a database outside AGNI_HOME is made owner-only.
 *
 * The macOS/Linux rules are tested with an injected file system, because this
 * suite also runs on Windows where POSIX mode bits do not exist. The wiring into
 * the database open is tested by running that code with `process.platform`
 * spoofed to "linux" over the same injected file system.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db";
import {
  PrivateFileError,
  checkPosixPrivate,
  isOwnerOnlyDirectory,
  setPosixFsForTests,
  verifyHomePrivate,
  type PosixFs,
} from "../src/util/private-file";

interface FakeNode { mode: number; uid: number; dir: boolean }
/** A tiny file system of modes. `chmodSticks: false` models a mount that ignores chmod. */
function fakePosix(nodes: Record<string, FakeNode>, options: { uid?: number; chmodSticks?: boolean; chmodThrows?: boolean; unknownExist?: boolean } = {}) {
  const calls: Array<[string, number]> = [];
  const norm = (path: string): string => path.replaceAll("\\", "/");
  const table = new Map(Object.entries(nodes).map(([path, node]) => [norm(path), { ...node }]));
  const fs: PosixFs = {
    statSync(path) {
      const node = table.get(norm(path)) ?? (options.unknownExist ? { mode: 0o100600, uid: options.uid ?? 1000, dir: false } : undefined);
      if (!node) throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
      return { mode: node.mode, uid: node.uid, isDirectory: () => node.dir };
    },
    chmodSync(path, mode) {
      calls.push([norm(path), mode]);
      if (options.chmodThrows) throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
      const node = table.get(norm(path));
      if (node && options.chmodSticks !== false) node.mode = (node.mode & ~0o777) | mode;
    },
    getuid: () => options.uid ?? 1000,
  };
  return { fs, calls, table, norm };
}

let roots: string[] = [];
const fresh = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "agni-homepriv-"));
  roots.push(dir);
  return dir;
};
const saved = { home: process.env.AGNI_HOME, db: process.env.AGNI_DB_PATH, platform: process.platform };
afterEach(() => {
  setPosixFsForTests(null);
  Object.defineProperty(process, "platform", { value: saved.platform });
  if (saved.home === undefined) delete process.env.AGNI_HOME; else process.env.AGNI_HOME = saved.home;
  if (saved.db === undefined) delete process.env.AGNI_DB_PATH; else process.env.AGNI_DB_PATH = saved.db;
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  roots = [];
});

describe("checkPosixPrivate", () => {
  test("a private directory is left alone", () => {
    const { fs, calls } = fakePosix({ "/h": { mode: 0o040700, uid: 1000, dir: true } });
    expect(checkPosixPrivate("/h", 0o700, fs)).toBe("ok");
    expect(calls).toEqual([]);
  });

  test("a directory open to group or others is set to 700 and checked again", () => {
    const { fs, calls } = fakePosix({ "/h": { mode: 0o040755, uid: 1000, dir: true } });
    expect(checkPosixPrivate("/h", 0o700, fs)).toBe("fixed");
    expect(calls).toEqual([["/h", 0o700]]);
  });

  test("a file readable by group is set to 600", () => {
    const { fs, calls } = fakePosix({ "/h/config.env": { mode: 0o100640, uid: 1000, dir: false } });
    expect(checkPosixPrivate("/h/config.env", 0o600, fs)).toBe("fixed");
    expect(calls).toEqual([["/h/config.env", 0o600]]);
  });

  test("another account's directory is refused, and chmod is not tried", () => {
    const { fs, calls } = fakePosix({ "/h": { mode: 0o040700, uid: 0, dir: true } });
    expect(() => checkPosixPrivate("/h", 0o700, fs)).toThrow(PrivateFileError);
    expect(calls).toEqual([]);
  });

  test("a chmod that fails, or does nothing, is refused rather than ignored", () => {
    const wide = { "/h": { mode: 0o040777, uid: 1000, dir: true } };
    expect(() => checkPosixPrivate("/h", 0o700, fakePosix(wide, { chmodThrows: true }).fs)).toThrow(PrivateFileError);
    expect(() => checkPosixPrivate("/h", 0o700, fakePosix(wide, { chmodSticks: false }).fs)).toThrow(/still readable/);
  });

  test("the message names the folder so the owner can fix it", () => {
    const { fs } = fakePosix({ "/h": { mode: 0o040777, uid: 1000, dir: true } }, { chmodThrows: true });
    expect(() => checkPosixPrivate("/h", 0o700, fs)).toThrow(/\/h/);
  });
});

describe("verifyHomePrivate on macOS and Linux", () => {
  const home = "/home/me/.agni";
  test("fixes the home and every secret file in it, skips files that do not exist", () => {
    const { fs, calls } = fakePosix({
      [home]: { mode: 0o040755, uid: 1000, dir: true },
      [`${home}/config.env`]: { mode: 0o100644, uid: 1000, dir: false },
      [`${home}/vault.bin`]: { mode: 0o100600, uid: 1000, dir: false },
    });
    expect(verifyHomePrivate(home, "linux", fs)).toBe("fixed");
    expect(calls).toEqual([[home, 0o700], [`${home}/config.env`, 0o600]]);
    expect(verifyHomePrivate(home, "linux", fs)).toBe("ok");
  });

  test("a missing home is an error (the caller creates it first)", () => {
    expect(() => verifyHomePrivate(home, "linux", fakePosix({}).fs)).toThrow(PrivateFileError);
  });

  test("a symlink-free home owned by someone else is refused", () => {
    const { fs } = fakePosix({ [home]: { mode: 0o040700, uid: 501, dir: true } }, { uid: 1000 });
    expect(() => verifyHomePrivate(home, "darwin", fs)).toThrow(/another account/);
  });
});

describe("verifyHomePrivate on Windows", () => {
  const onlyWindows = test.skipIf(process.platform !== "win32");

  onlyWindows("a folder that is not owner-only is locked, then reported ok on the next start", () => {
    const dir = fresh();
    expect(isOwnerOnlyDirectory(dir)).toBe(false);
    expect(verifyHomePrivate(dir)).toBe("fixed");
    expect(isOwnerOnlyDirectory(dir)).toBe(true);
    expect(verifyHomePrivate(dir)).toBe("ok");
  });

  onlyWindows("refuses when the ACL tools cannot run", () => {
    const dir = fresh();
    const roots = ["SystemRoot", "windir", "SYSTEMROOT", "WINDIR"].map((name) => [name, process.env[name]] as const);
    for (const [name] of roots) process.env[name] = "Z:\\no-such-windows";
    try {
      expect(() => verifyHomePrivate(dir)).toThrow(PrivateFileError);
    } finally {
      for (const [name, value] of roots) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    }
  });
});

describe("a database outside AGNI_HOME on macOS and Linux", () => {
  /** Run `fn` as if on Linux, over a fake mode table that records what the code asked for. */
  function asLinux(nodes: Record<string, FakeNode>) {
    const fake = fakePosix(nodes, { unknownExist: true });
    setPosixFsForTests(fake.fs);
    Object.defineProperty(process, "platform", { value: "linux" });
    return fake;
  }

  test("files SQLite will use are created owner-only before it opens them, in a folder the server made", () => {
    const root = fresh();
    process.env.AGNI_HOME = join(root, "home");
    const folder = join(root, "elsewhere");
    const dbPath = join(folder, "agni.sqlite");
    process.env.AGNI_DB_PATH = dbPath;
    const fake = asLinux({ [folder]: { mode: 0o040755, uid: 1000, dir: true } });
    const db = openDatabase(dbPath);
    db.close();
    Object.defineProperty(process, "platform", { value: saved.platform });
    expect(existsSync(dbPath)).toBe(true);
    // The folder was made by this start, so it is locked to 700 before the database opens.
    expect(fake.calls.some(([path, mode]) => path === fake.norm(folder) && mode === 0o700)).toBe(true);
  });

  test("a folder that already holds other files is not changed; only the database files are locked", () => {
    const root = fresh();
    process.env.AGNI_HOME = join(root, "home");
    const folder = join(root, "shared");
    mkdirSync(folder);
    writeFileSync(join(folder, "other.txt"), "x");
    const dbPath = join(folder, "agni.sqlite");
    process.env.AGNI_DB_PATH = dbPath;
    const fake = asLinux({
      [folder]: { mode: 0o040755, uid: 1000, dir: true },
      [dbPath]: { mode: 0o100644, uid: 1000, dir: false },
    });
    const db = openDatabase(dbPath);
    db.close();
    Object.defineProperty(process, "platform", { value: saved.platform });
    expect(fake.calls.find(([path]) => path === fake.norm(folder))).toBeUndefined();
    expect(fake.calls).toContainEqual([fake.norm(dbPath), 0o600]);
  });

  test("a database it cannot lock refuses to start and names the path", () => {
    const root = fresh();
    process.env.AGNI_HOME = join(root, "home");
    const folder = join(root, "shared");
    mkdirSync(folder);
    writeFileSync(join(folder, "other.txt"), "x");
    const dbPath = join(folder, "agni.sqlite");
    process.env.AGNI_DB_PATH = dbPath;
    const fake = fakePosix({ [folder]: { mode: 0o040755, uid: 1000, dir: true }, [dbPath]: { mode: 0o100644, uid: 1000, dir: false } }, { chmodThrows: true, unknownExist: true });
    setPosixFsForTests(fake.fs);
    Object.defineProperty(process, "platform", { value: "linux" });
    writeFileSync(dbPath, "");
    expect(() => openDatabase(dbPath)).toThrow(/Refusing to start/);
  });
});
