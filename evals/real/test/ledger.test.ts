import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../../apps/server/src/db";
import { recordLedgerCall, recordUsage } from "../../../apps/server/src/stores/usage";
import { readLedger } from "../ledger";

const open: Array<{ db: Database; dir: string }> = [];
afterEach(() => {
  for (const { db, dir } of open.splice(0)) {
    db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
/** A database with the server's own migrations, written by the server's own ledger functions. */
function realLedgerDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "agni-eval-ledger-"));
  const db = openDatabase(join(dir, "agni.sqlite"));
  open.push({ db, dir });
  return db;
}

describe("ledger reader", () => {
  test("sums per-call rows, counts unknown cost, and leaves out the old per-turn rows", () => {
    const db = realLedgerDb();
    recordLedgerCall(db, { provider: "openrouter", model: "m", inputTokens: 100, outputTokens: 10, costUsd: 0.001, costSource: "reported", kind: "turn" });
    recordLedgerCall(db, { provider: "openrouter", model: "m", inputTokens: 50, outputTokens: 5, costUsd: null, kind: "side" });
    recordUsage(db, { provider: "openrouter", model: "m", inputTokens: 9999, outputTokens: 9999 });
    const summary = readLedger(db);
    expect(summary.calls).toBe(2);
    expect(summary.costUsd).toBeCloseTo(0.001, 10);
    expect(summary.unknownCostCalls).toBe(1);
    expect(summary.inputTokens).toBe(150);
    expect(summary.outputTokens).toBe(15);
  });

  test("repair and escalation are null until the ledger has their columns", () => {
    const db = realLedgerDb();
    recordLedgerCall(db, { provider: "openrouter", model: "m", costUsd: 0.001, kind: "turn" });
    expect(readLedger(db).repairCalls).toBeNull();
    expect(readLedger(db).escalatedCalls).toBeNull();
    db.exec("ALTER TABLE usage_ledger ADD COLUMN repair_attempts INTEGER");
    expect(readLedger(db).repairCalls).toBe(0);
    db.exec("UPDATE usage_ledger SET repair_attempts = 2");
    expect(readLedger(db).repairCalls).toBe(1);
    expect(readLedger(db).escalatedCalls).toBeNull();
  });

  test("an empty ledger is zero calls and zero cost, not an error", () => {
    const summary = readLedger(realLedgerDb());
    expect(summary).toEqual({ calls: 0, costUsd: 0, unknownCostCalls: 0, inputTokens: 0, outputTokens: 0, repairCalls: null, escalatedCalls: null });
  });
});
