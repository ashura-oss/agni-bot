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
    expect(S2_MIGRATIONS).toHaveLength(7); // 54..59, and 65 (the run clock: 60..64 are Sprint 3's)
    expect(S3_MIGRATIONS).toHaveLength(5); // 60..64
  });

  test("MIGRATIONS has unique ids in ascending order", () => {
    const ids = MIGRATIONS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  test("buildMigrations drops nulls and sorts by id", () => {
    // Test-local lists: none of these go near the real list, so filling a spare slot cannot break them.
    const merged = buildMigrations([fake(1), fake(2)], [null, fake(9064), null], [fake(9059)]);
    expect(merged.map((entry) => entry.id)).toEqual([1, 2, 9059, 9064]);
  });

  test("buildMigrations refuses a duplicate id", () => {
    expect(() => buildMigrations([fake(1), fake(9059)], [fake(9059)])).toThrow(/duplicate migration id 9059/);
  });
});

describe("P0 CLI schema check", () => {
  test("a database with a later migration applied but an earlier one missing is refused, naming the missing id", () => {
    const path = tempDB();
    openDatabase(path).close(); // applies the real list
    // Ids far above the real range, so a sprint that fills a spare slot never collides with this test.
    const list = buildMigrations(MIGRATIONS, [fake(9001), fake(9002)]);

    const seeded = new Database(path);
    seeded.run("INSERT INTO schema_migrations (id, name, applied_at) VALUES (9002, 'fake_9002', 'test')");
    seeded.close();

    expect(() => openDatabaseForCLI(path, list)).toThrow(/missing migration.*\b9001\b/);

    const fixed = new Database(path);
    fixed.run("INSERT INTO schema_migrations (id, name, applied_at) VALUES (9001, 'fake_9001', 'test')");
    fixed.close();
    openDatabaseForCLI(path, list).close();
  });

  test("the real list is accepted on a fully migrated database", () => {
    const path = tempDB();
    openDatabase(path).close();
    openDatabaseForCLI(path).close();
  });
});
