/**
 * A row is closed with a timestamp from JavaScript's clock and read back as
 * live or not by SQLite's own clock. On Windows SQLite's clock lags
 * JavaScript's by a millisecond or two, so a row closed "now" was still live
 * for a moment and a just-superseded fact showed up beside its replacement
 * (flaky B2 tagger, MEM-002 and nightly-sweep tests). Closing must never land
 * after the clock that decides what is live.
 *
 * `setSystemTime` moves JavaScript's clock only, which exaggerates the lag
 * into something deterministic on every platform.
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { consolidateMemories } from "../src/jobs/memory";
import { listAgentMemories, putAgentMemory } from "../src/stores/agent-memories";

let db: Database | undefined;
afterEach(() => {
  setSystemTime();
  db?.close();
  db = undefined;
});

const skew = (ms: number): void => {
  setSystemTime(new Date(Date.now() + ms));
};
const live = (database: Database) => listAgentMemories(database, { scope: "global_user", callerAgentID: "ea" });

describe("closing a memory row and the live check agree on the time", () => {
  test("a superseded fact is not live even when JavaScript's clock is ahead of SQLite's", () => {
    db = openDatabase(":memory:");
    skew(5_000);
    putAgentMemory(db, { scope: "global_user", keySlug: "city", content: "The owner lives in NYC." });
    putAgentMemory(db, { scope: "global_user", keySlug: "city", content: "The owner lives in SF." });
    expect(live(db).map((row) => row.content)).toEqual(["The owner lives in SF."]);
  });

  test("the sweep's closes and merges are not live when JavaScript's clock is ahead", () => {
    db = openDatabase(":memory:");
    const stale = putAgentMemory(db, { scope: "global_user", keySlug: "stale", content: "A superseded fact." });
    const newer = putAgentMemory(db, { scope: "global_user", keySlug: "newer", content: "Its replacement." });
    db.run("UPDATE agent_memories SET supersedes_id = ? WHERE id = ?", [stale.id, newer.id]);
    putAgentMemory(db, { scope: "global_user", keySlug: "one", content: "The same fact." });
    putAgentMemory(db, { scope: "global_user", keySlug: "two", content: "The same fact." });

    skew(5_000);
    const result = consolidateMemories(db);
    expect(result.closed).toBe(1);
    expect(result.merged).toBe(1);
    expect(live(db).map((row) => row.content).sort()).toEqual(["Its replacement.", "The same fact."]);
  });
});
