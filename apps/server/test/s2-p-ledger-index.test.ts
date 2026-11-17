/**
 * Sprint 2, fix round P (item 4): one index too many on the ledger.
 *
 * m54 made `idx_usage_created (created_at, cost_usd)`; m65 later made `idx_usage_created_kind_cost (created_at, call_kind, cost_usd)`, which
 * answers every question the first one did (it leads with the same column and holds the cost as well). Every write to the ledger, one per model
 * call, paid for both. m65 drops the older one. This pins that no ledger query needs it: each reads an index, none scans the table.
 */
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db";

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

const SINCE = "2026-11-17T00:00:00.000Z";
// The queries `stores/usage.ts` makes on the ledger by time (spentSince in its three shapes, spentByBotSince, the two unknown-cost counts).
const QUERIES: Array<[string, string, string[]]> = [
  ["spentSince", "SELECT SUM(cost_usd) AS spent FROM usage_ledger WHERE created_at >= ?", [SINCE]],
  ["spentSince for a bot", "SELECT SUM(cost_usd) AS spent FROM usage_ledger WHERE created_at >= ? AND agent_id = ?", [SINCE, "ea"]],
  ["spentSince for a root job", "SELECT SUM(cost_usd) AS spent FROM usage_ledger WHERE created_at >= ? AND root_job_id = ?", [SINCE, "job_1"]],
  ["spentByBotSince", "SELECT agent_id, SUM(cost_usd) AS spent FROM usage_ledger WHERE created_at >= ? AND agent_id IS NOT NULL GROUP BY agent_id ORDER BY spent DESC, agent_id", [SINCE]],
  ["unpricedCallsSince", "SELECT COUNT(*) AS n FROM usage_ledger WHERE created_at >= ? AND call_kind IS NOT NULL AND cost_usd IS NULL", [SINCE]],
  ["unknownCostCallsSince for a bot", "SELECT COUNT(*) AS n FROM usage_ledger WHERE created_at >= ? AND call_kind IS NOT NULL AND cost_usd IS NULL AND agent_id = ?", [SINCE, "ea"]],
];

const planOf = (database: Database, sql: string, params: string[]): string =>
  database.query<{ detail: string }, string[]>(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((row) => row.detail).join("\n");

describe("the ledger's time indexes", () => {
  test("the older index that m65's covers is gone, and the newer one is there", () => {
    db = openDatabase(":memory:");
    const names = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'usage_ledger'").all().map((row) => row.name);
    expect(names).not.toContain("idx_usage_created");
    expect(names).toEqual(expect.arrayContaining(["idx_usage_created_kind_cost", "idx_usage_agent_created", "idx_usage_root_job"]));
  });

  for (const [name, sql, params] of QUERIES) {
    test(`${name} reads an index and does not scan the table`, () => {
      db = openDatabase(":memory:");
      const plan = planOf(db, sql, params);
      expect(plan, plan).toMatch(/USING (COVERING )?INDEX idx_usage_/);
      expect(plan, plan).not.toMatch(/SCAN (TABLE )?usage_ledger(?! USING)/);
      expect(plan, plan).not.toMatch(/idx_usage_created\b(?!_)/);
    });
  }
});
