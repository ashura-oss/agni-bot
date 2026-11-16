/**
 * Sprint 1, wave 2, W2-B items 6 to 9: platform helpers (shell scrub, Windows
 * system tools, private files, the database folder).
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db";
import { agniHome } from "../src/home";
import { providerKeyEnvNames } from "../src/models/providers";
import { scrubbedShellEnv } from "../src/util/scrubbed-env";
import { windowsSystemTool } from "../src/util/windows-acl";
import { browserOpenCommand } from "../src/util/open-url";
import { isOwnerOnlyDirectory, secureDirectoryIfNeeded } from "../src/util/private-file";

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

describe("W2-B 6: the shell scrub is fed by the provider catalog", () => {
  test("providerKeyEnvNames lists every catalog key variable, and the scrub removes each one", () => {
    const names = providerKeyEnvNames();
    expect(names).toEqual(expect.arrayContaining(["GROQ_API_KEY", "CEREBRAS_API_KEY", "NVIDIA_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"]));
    expect(new Set(names).size).toBe(names.length);
    const env = Object.fromEntries(names.map((name) => [name, "x"]));
    expect(scrubbedShellEnv({ ...env, PATH: "/bin", GROQ_MODEL: "m" })).toEqual({ PATH: "/bin", GROQ_MODEL: "m" });
  });
});

describe("W2-B 7: rundll32 is a system tool resolved like whoami and icacls", () => {
  test("windowsSystemTool resolves rundll32 under System32, and open-url uses it", () => {
    const expected = String.raw`D:\Win\System32\rundll32.exe`;
    expect(windowsSystemTool("rundll32", { SystemRoot: String.raw`D:\Win` })).toBe(expected);
    expect(() => windowsSystemTool("rundll32", {})).toThrow(/SystemRoot/);
    expect(browserOpenCommand("https://example.com/", "win32", { SystemRoot: String.raw`D:\Win` })[0]).toBe(expected);
  });
});

describe("W2-B 8: a missing temp folder warns, it does not crash", () => {
  test.skipIf(process.platform !== "win32")("isOwnerOnlyDirectory and secureDirectoryIfNeeded survive an unusable TEMP", () => {
    const dir = mkdtempSync(join(tmpdir(), "agni-w2b-dir-"));
    const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP };
    try {
      const missing = join(dir, "no", "such", "folder");
      process.env.TEMP = missing;
      process.env.TMP = missing;
      expect(() => isOwnerOnlyDirectory(dir)).not.toThrow();
      expect(isOwnerOnlyDirectory(dir)).toBe(false);
      expect(() => secureDirectoryIfNeeded(dir, "warn")).not.toThrow();
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("W2-B 9: a database kept outside AGNI_HOME gets an owner-only folder on Windows", () => {
  const saved = { home: process.env.AGNI_HOME, dbPath: process.env.AGNI_DB_PATH };
  afterEach(() => {
    if (saved.home === undefined) delete process.env.AGNI_HOME; else process.env.AGNI_HOME = saved.home;
    if (saved.dbPath === undefined) delete process.env.AGNI_DB_PATH; else process.env.AGNI_DB_PATH = saved.dbPath;
  });

  test.skipIf(process.platform !== "win32")("the configured folder is secured when the database opens", () => {
    const root = mkdtempSync(join(tmpdir(), "agni-w2b-db-"));
    try {
      process.env.AGNI_HOME = join(root, "home");
      const outside = join(root, "elsewhere");
      process.env.AGNI_DB_PATH = join(outside, "agni.sqlite");
      db = openDatabase(process.env.AGNI_DB_PATH);
      db.close(); db = undefined;
      expect(isOwnerOnlyDirectory(outside)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /** Lines of `icacls` for a path that still inherit from the parent. */
  const inherited = (path: string): number =>
    execFileSync(windowsSystemTool("icacls"), [path], { encoding: "utf8", windowsHide: true }).split("\n").filter((line) => line.includes("(I)")).length;

  test.skipIf(process.platform !== "win32")("an existing empty folder is secured too", () => {
    const root = mkdtempSync(join(tmpdir(), "agni-w2b-db-"));
    try {
      process.env.AGNI_HOME = join(root, "home");
      const empty = join(root, "empty");
      mkdirSync(empty);
      process.env.AGNI_DB_PATH = join(empty, "agni.sqlite");
      db = openDatabase(process.env.AGNI_DB_PATH);
      db.close(); db = undefined;
      expect(isOwnerOnlyDirectory(empty)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform !== "win32")("a folder that already holds other files is left alone; only the database files are secured", () => {
    const root = mkdtempSync(join(tmpdir(), "agni-w2b-db-"));
    try {
      process.env.AGNI_HOME = join(root, "home");
      const shared = join(root, "shared");
      mkdirSync(shared);
      const neighbour = join(shared, "notes.txt");
      writeFileSync(neighbour, "not ours");
      process.env.AGNI_DB_PATH = join(shared, "agni.sqlite");
      db = openDatabase(process.env.AGNI_DB_PATH);
      db.run("CREATE TABLE IF NOT EXISTS w (x)");
      db.run("INSERT INTO w VALUES (1)");
      expect(isOwnerOnlyDirectory(shared)).toBe(false);
      expect(inherited(neighbour)).toBeGreaterThan(0);
      expect(inherited(process.env.AGNI_DB_PATH)).toBe(0);
      db.close(); db = undefined;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform !== "win32")("a folder inside the home and a database nobody configured are left alone", () => {
    const root = mkdtempSync(join(tmpdir(), "agni-w2b-db-"));
    try {
      process.env.AGNI_HOME = join(root, "home");
      const inside = join(agniHome(), "data");
      process.env.AGNI_DB_PATH = join(inside, "agni.sqlite");
      db = openDatabase(process.env.AGNI_DB_PATH);
      db.close(); db = undefined;
      expect(isOwnerOnlyDirectory(inside)).toBe(false);

      const other = join(root, "other");
      db = openDatabase(join(other, "agni.sqlite"));
      db.close(); db = undefined;
      expect(isOwnerOnlyDirectory(other)).toBe(false);
      expect(existsSync(join(other, "agni.sqlite"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an in-memory database touches nothing", () => {
    process.env.AGNI_DB_PATH = ":memory:";
    db = openDatabase(":memory:");
    expect(db).toBeDefined();
  });
});
