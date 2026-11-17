/**
 * The run clock's bookkeeping (S2-09, fix round D): what a restart does to waits that were open, and what the
 * cleanup that runs with every new clock costs.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { beginOwnerWait, readClock, startClock } from "../src/agent/run-clock";
import { recoverInterruptedTurns } from "../src/ws/boot-recovery";

const MIN = 60_000;
const T0 = Date.parse("2026-11-17T09:00:00.000Z");

let db: Database;
beforeEach(() => { db = openDatabase(":memory:"); });
afterEach(() => { setSystemTime(); db.close(); });

describe("a restart closes the waits that were open", () => {
  test("a wait the dead process left open ends at boot, so a retried job is not given the longest wait for free", () => {
    startClock(db, "job_a@slot", T0);
    beginOwnerWait(db, "job_a@slot", T0 + 1 * MIN); // the process dies two minutes later, the wait never ended
    setSystemTime(new Date(T0 + 3 * MIN));
    recoverInterruptedTurns(db, () => undefined);

    const row = db.query<{ ended_at: string | null }, []>("SELECT ended_at FROM run_clock_waits").get();
    expect(row?.ended_at, "the open wait was left open").toBe(new Date(T0 + 3 * MIN).toISOString());
    // The retry looks 40 minutes in: only the two minutes the wait really lasted are the owner's.
    expect(readClock(db, "job_a@slot", T0 + 40 * MIN)?.waitedMs, "a crash granted the run extra time").toBe(2 * MIN);
  });

  test("a wait that already ended keeps its own end", () => {
    startClock(db, "job_b@slot", T0);
    const end = beginOwnerWait(db, "job_b@slot", T0 + 1 * MIN);
    setSystemTime(new Date(T0 + 2 * MIN));
    end();
    setSystemTime(new Date(T0 + 9 * MIN));
    recoverInterruptedTurns(db, () => undefined);
    expect(readClock(db, "job_b@slot", T0 + 40 * MIN)?.waitedMs).toBe(1 * MIN);
  });
});

describe("starting a clock does not scan the table", () => {
  test("the cleanup of old clocks uses an index on started_at", () => {
    const plan = db
      .query<{ detail: string }, [string]>("EXPLAIN QUERY PLAN DELETE FROM run_clocks WHERE started_at < ?")
      .all("2026-01-01T00:00:00.000Z")
      .map((row) => row.detail)
      .join(" | ");
    expect(plan, "the cleanup that every clock start runs scans run_clocks").toMatch(/USING (COVERING )?INDEX/);
  });
});
