/**
 * The database is private from its first byte (Windows): the folder is locked
 * owner-only before SQLite opens anything, or, in a folder that is not ours,
 * the database files are created and locked before SQLite opens them. If it
 * cannot be done the server refuses to start.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db";
import { agniHome } from "../src/home";
import { log } from "../src/log";
import { currentUserSid, windowsSystemTool } from "../src/util/windows-acl";
import { isOwnerOnlyDirectory } from "../src/util/private-file";

const onlyWindows = test.skipIf(process.platform !== "win32");
const saved = {
  home: process.env.AGNI_HOME, dbPath: process.env.AGNI_DB_PATH,
  roots: ["SystemRoot", "windir", "SYSTEMROOT", "WINDIR"].map((name) => [name, process.env[name]] as const),
};
let db: Database | undefined;
let root: string;
const fresh = (): string => (root = mkdtempSync(join(tmpdir(), "agni-dbpriv-")));
afterEach(() => {
  db?.close(); db = undefined;
  for (const [name, value] of saved.roots) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  if (saved.home === undefined) delete process.env.AGNI_HOME; else process.env.AGNI_HOME = saved.home;
  if (saved.dbPath === undefined) delete process.env.AGNI_DB_PATH; else process.env.AGNI_DB_PATH = saved.dbPath;
  if (root) rmSync(root, { recursive: true, force: true });
});

/** The access entries of a file or folder, read the locale-independent way. */
function acl(path: string): string[] {
  const scratch = mkdtempSync(join(tmpdir(), "agni-dbpriv-acl-"));
  try {
    const out = join(scratch, "acl.txt");
    execFileSync(windowsSystemTool("icacls"), [path, "/save", out, "/q"], { stdio: "pipe", windowsHide: true });
    const sddl = readFileSync(out, "utf16le").match(/^D:(.*)$/m)?.[1]?.trim() ?? "";
    return sddl.match(/\([^)]*\)/g) ?? [];
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
const ownerOnly = (path: string): boolean => {
  const entries = acl(path);
  return entries.length === 1 && entries[0]!.includes(`;;;${currentUserSid()})`);
};
/** Make SQLite write, so the -wal and -shm files exist. */
const touch = (database: Database): void => { database.run("CREATE TABLE IF NOT EXISTS w (x)"); database.run("INSERT INTO w VALUES (1)"); };
/** Windows cannot find icacls: nothing can be locked. */
const breakAclTools = (): void => { for (const name of ["SystemRoot", "windir", "SYSTEMROOT", "WINDIR"]) process.env[name] = "Z:\no-such-windows"; };

describe("a folder the server creates is locked before the database opens", () => {
  onlyWindows("every file made in it, the database files included, inherits owner-only access", () => {
    const home = join(fresh(), "home");
    process.env.AGNI_HOME = home;
    const folder = join(root, "elsewhere");
    process.env.AGNI_DB_PATH = join(folder, "agni.sqlite");
    db = openDatabase(process.env.AGNI_DB_PATH);
    touch(db);
    expect(isOwnerOnlyDirectory(folder)).toBe(true);
    for (const file of ["agni.sqlite", "agni.sqlite-wal", "agni.sqlite-shm"]) {
      expect(existsSync(join(folder, file))).toBe(true);
      expect(ownerOnly(join(folder, file))).toBe(true);
    }
    // A file made later gets the folder's access from birth, with nothing applied to it.
    writeFileSync(join(folder, "later.txt"), "x");
    expect(ownerOnly(join(folder, "later.txt"))).toBe(true);
  });

  onlyWindows("a second start finds its own locked folder: no warning and no file-by-file work", () => {
    process.env.AGNI_HOME = join(fresh(), "home");
    const folder = join(root, "elsewhere");
    process.env.AGNI_DB_PATH = join(folder, "agni.sqlite");
    db = openDatabase(process.env.AGNI_DB_PATH);
    touch(db);
    db.close(); db = undefined;
    const warn = spyOn(log, "warn");
    try {
      db = openDatabase(process.env.AGNI_DB_PATH);
      expect(warn).not.toHaveBeenCalled();
      expect(isOwnerOnlyDirectory(folder)).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  onlyWindows("the data folder inside the home is locked first, even with files already in it", () => {
    process.env.AGNI_HOME = join(fresh(), "home");
    delete process.env.AGNI_DB_PATH;
    const data = join(agniHome(), "data");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "older.bin"), "x");
    db = openDatabase(join(data, "agni.sqlite"));
    expect(isOwnerOnlyDirectory(data)).toBe(true);
  });

  onlyWindows("refuses to start, naming the path, and creates no database, when the folder cannot be locked", () => {
    process.env.AGNI_HOME = join(fresh(), "home");
    const folder = join(root, "elsewhere");
    process.env.AGNI_DB_PATH = join(folder, "agni.sqlite");
    breakAclTools();
    expect(() => openDatabase(process.env.AGNI_DB_PATH!)).toThrow(/elsewhere/);
    expect(existsSync(process.env.AGNI_DB_PATH!)).toBe(false);
  });
});

describe("a folder that is not ours: the files are created locked before SQLite opens them", () => {
  onlyWindows("the folder keeps its access rules, the three database files are owner-only, and nothing else is touched", () => {
    process.env.AGNI_HOME = join(fresh(), "home");
    const shared = join(root, "shared");
    mkdirSync(shared);
    writeFileSync(join(shared, "notes.txt"), "not ours");
    const before = acl(join(shared, "notes.txt"));
    process.env.AGNI_DB_PATH = join(shared, "agni.sqlite");
    db = openDatabase(process.env.AGNI_DB_PATH);
    touch(db);
    expect(isOwnerOnlyDirectory(shared)).toBe(false);
    for (const file of ["agni.sqlite", "agni.sqlite-wal", "agni.sqlite-shm"]) expect(ownerOnly(join(shared, file))).toBe(true);
    expect(acl(join(shared, "notes.txt"))).toEqual(before);
    // The database still works after being closed and opened again (the -wal and -shm are made anew).
    db.close();
    db = openDatabase(process.env.AGNI_DB_PATH);
    touch(db);
    for (const file of ["agni.sqlite", "agni.sqlite-wal", "agni.sqlite-shm"]) expect(ownerOnly(join(shared, file))).toBe(true);
  });

  onlyWindows("refuses to start and leaves no database file when the files cannot be locked", () => {
    process.env.AGNI_HOME = join(fresh(), "home");
    const shared = join(root, "shared");
    mkdirSync(shared);
    writeFileSync(join(shared, "notes.txt"), "not ours");
    process.env.AGNI_DB_PATH = join(shared, "agni.sqlite");
    breakAclTools();
    expect(() => openDatabase(process.env.AGNI_DB_PATH!)).toThrow(/shared/);
    expect(existsSync(process.env.AGNI_DB_PATH!)).toBe(false);
  });
});

describe("databases nobody configured are left alone", () => {
  test("an in-memory database and one at an unrelated path touch no access rules", () => {
    process.env.AGNI_HOME = join(fresh(), "home");
    delete process.env.AGNI_DB_PATH;
    breakAclTools(); // would make any locking attempt throw
    db = openDatabase(":memory:");
    db.close();
    db = openDatabase(join(root, "other", "agni.sqlite"));
    expect(existsSync(join(root, "other", "agni.sqlite"))).toBe(true);
  });
});
