import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, openDatabaseForCLI } from "../src/db";
import { buildMigrations, MIGRATIONS, type Migration } from "../src/db/migrations";
import { S2_MIGRATIONS } from "../src/db/s2";
import { S3_MIGRATIONS } from "../src/db/s3";

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const fn of cleanups) fn();
});

function fake(id: number): Migration {
  return { id, name: `fake_${id}`, sql: "SELECT 1;" };
}

function tempDB(): string {
  const dir = mkdtempSync(join(tmpdir(), "agni-p0-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "agni.db");
}

describe("P0 migration aggregation", () => {
  test("the sprint placeholder lists hold one slot per reserved id", () => {
    expect(S2_MIGRATIONS).toHaveLength(6); // 54..59
    expect(S3_MIGRATIONS).toHaveLength(5); // 60..64
  });

  test("MIGRATIONS has unique ids in ascending order", () => {
    const ids = MIGRATIONS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  test("buildMigrations drops nulls and sorts by id", () => {
    const merged = buildMigrations([fake(1), fake(2)], [null, fake(60), null], [fake(54)]);
    expect(merged.map((entry) => entry.id)).toEqual([1, 2, 54, 60]);
  });

  test("buildMigrations refuses a duplicate id", () => {
    expect(() => buildMigrations([fake(1), fake(54)], [fake(54)])).toThrow(/duplicate migration id 54/);
  });
});

describe("P0 CLI schema check", () => {
  test("a database with 60 applied but 54 missing is refused, naming the missing id", () => {
    const path = tempDB();
    openDatabase(path).close(); // applies the real list
    const list = buildMigrations(MIGRATIONS, [fake(54)], [fake(60)]);

    const seeded = new Database(path);
    seeded.run("INSERT INTO schema_migrations (id, name, applied_at) VALUES (60, 'fake_60', 'test')");
    seeded.close();

    expect(() => openDatabaseForCLI(path, list)).toThrow(/missing migration.*\b54\b/);

    const fixed = new Database(path);
    fixed.run("INSERT INTO schema_migrations (id, name, applied_at) VALUES (54, 'fake_54', 'test')");
    fixed.close();
    openDatabaseForCLI(path, list).close();
  });

  test("the real list is accepted on a fully migrated database", () => {
    const path = tempDB();
    openDatabase(path).close();
    openDatabaseForCLI(path).close();
  });
});
