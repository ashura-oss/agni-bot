/**
 * Sprint 2, fix round L (E, H): what migration 65 does to the data and the indexes already there.
 *
 *  - E: a job the owner made with `agni job add` before the owner bit existed carries no marker, and now reads as a bot's. The migration
 *    stamps `ownerOnly` on the queued turn jobs that provably have the shape `agni job add` wrote then, and only those. Before upstream #36
 *    (`cfd778b`) a bot's `job_schedule` wrote neither `inputRole` nor `scheduledBy`, so those fields prove nothing; what separates the two
 *    is that the tool always wrote an `agentID`, and the CLI wrote neither `lane` nor `dailyAt` nor `days`. A job with an agent cannot be told
 *    from a bot's, whatever thread it has (the runner wrote `threadID` back into a repeating job on its first fire), and is left alone (it
 *    asks once). Nothing a bot made is touched.
 *  - H: the day cap counts calls whose cost is unknown. A covering index on (created_at, call_kind, cost_usd) lets that count read the index
 *    alone instead of every row of the day.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db";
import { MIGRATIONS } from "../src/db/migrations";
import { readCarried } from "../src/policy/carry";
import { unknownCostCallsSince } from "../src/stores/usage";

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

/** A database as it was before migration 65: every migration below it, in order, and nothing else. */
function beforeM65(): Database {
  const database = new Database(":memory:");
  for (const migration of MIGRATIONS) if (migration.id < 65) database.exec(migration.sql);
  return database;
}
const m65 = (): string => MIGRATIONS.find((migration) => migration.id === 65)!.sql;

function job(database: Database, id: string, payload: unknown, state = "queued", kind = "turn"): void {
  database.run(
    "INSERT INTO jobs (id, kind, payload, state, run_at, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), 0, datetime('now'), datetime('now'))",
    [id, kind, payload === null ? null : typeof payload === "string" ? payload : JSON.stringify(payload), state],
  );
}
const payloadOf = (database: Database, id: string): Record<string, unknown> => JSON.parse(database.query<{ payload: string }, [string]>("SELECT payload FROM jobs WHERE id = ?").get(id)!.payload) as Record<string, unknown>;

describe("migration 65 stamps the owner's own jobs", () => {
  test("a queued turn job with nothing a bot would have put on it is the owner's: its payload says so", () => {
    db = beforeM65();
    job(db, "job_plain", { text: "Check the inbox", notify: true });
    job(db, "job_recurring", { text: "Weekly review", notify: false, everyMs: 604_800_000, threadID: "thr_x" });
    db.exec(m65());
    for (const id of ["job_plain", "job_recurring"]) expect({ id, ownerOnly: payloadOf(db, id).ownerOnly }).toEqual({ id, ownerOnly: true });
    // The rest of the payload is untouched.
    expect(payloadOf(db, "job_plain")).toEqual({ text: "Check the inbox", notify: true, ownerOnly: true });
  });

  test("a job that was running when the server stopped is stamped too: it will be queued again", () => {
    db = beforeM65();
    job(db, "job_running", { text: "Weekly review", notify: false }, "running");
    db.exec(m65());
    expect(payloadOf(db, "job_running").ownerOnly).toBe(true);
  });

  test("nothing a bot made is touched: a scheduled job, a system note, a brief, a wake, a delegated task", () => {
    db = beforeM65();
    const botMade: Record<string, Record<string, unknown>> = {
      job_scheduled: { text: "x", scheduledBy: "bot", inputRole: "system" },
      job_scheduled_plain: { text: "x", scheduledBy: "bot" },
      job_system: { text: "x", inputRole: "system" },
      job_user: { text: "x", inputRole: "user" },
      job_peer: { text: "x", peer: { from: "Boss", intent: "request" } },
      job_wake: { text: "x", wakeKey: "wake:thr" },
      job_task: { text: "x", delegationTaskID: "tsk_1" },
    };
    for (const [id, payload] of Object.entries(botMade)) job(db, id, payload);
    db.exec(m65());
    for (const [id, payload] of Object.entries(botMade)) expect({ id, payload: payloadOf(db, id) }).toEqual({ id, payload });
  });

  test("a bot's job from before upstream #36 is not stamped, in either shape the tool wrote", () => {
    db = beforeM65();
    // `job_schedule` before #34 wrote a `lane`; between #34 and #36 it wrote only what the CLI could. Neither wrote an `inputRole` or `scheduledBy`.
    // It always wrote an `agentID` (its own).
    const legacyBot: Record<string, Record<string, unknown>> = {
      bot_lane_daily: { text: "Morning digest", agentID: "ea", lane: "task", notify: true, dailyAt: "09:00", days: [1, 2, 3, 4, 5] },
      bot_lane_every: { text: "Check the inbox", agentID: "ea", lane: "task", notify: false, everyMs: 3_600_000 },
      bot_lane_once: { text: "Remind me", agentID: "ea", lane: "task", notify: true },
      bot_daily: { text: "Morning digest", agentID: "ea", notify: true, dailyAt: "09:00" },
      bot_every: { text: "Check the inbox", agentID: "ea", notify: false, everyMs: 3_600_000 },
      bot_once: { text: "Remind me", agentID: "ea", notify: true },
    };
    for (const [id, payload] of Object.entries(legacyBot)) job(db, id, payload);
    db.exec(m65());
    for (const [id, payload] of Object.entries(legacyBot)) expect({ id, payload: payloadOf(db, id) }).toEqual({ id, payload });
    for (const id of Object.keys(legacyBot)) expect({ id, ownerOnly: readCarried(payloadOf(db, id)).ownerOnly }).toEqual({ id, ownerOnly: false });
  });

  test("a bot's repeating job after its first fire is not stamped: the runner wrote the thread back, the agent stays", () => {
    db = beforeM65();
    // Before upstream #36 the runner wrote `threadID` into a repeating job's payload on its first fire, so a bot's job can carry an agent AND a thread.
    // The CLI's `job add` with an agent cannot be told from it, so a payload with an `agentID` is never stamped, thread or not.
    const firedBot: Record<string, Record<string, unknown>> = {
      bot_fired_every: { text: "Check the inbox", agentID: "ea", notify: true, everyMs: 3_600_000, threadID: "thr_x" },
      bot_fired_once: { text: "Remind me", agentID: "ea", notify: true, threadID: "thr_x" },
    };
    for (const [id, payload] of Object.entries(firedBot)) job(db, id, payload);
    db.exec(m65());
    for (const [id, payload] of Object.entries(firedBot)) expect({ id, payload: payloadOf(db, id) }).toEqual({ id, payload });
    for (const id of Object.keys(firedBot)) expect({ id, ownerOnly: readCarried(payloadOf(db, id)).ownerOnly }).toEqual({ id, ownerOnly: false });
  });

  test("a payload that is not valid JSON never reaches the JSON functions: the migration runs and leaves it as it was", () => {
    db = beforeM65();
    const broken = ["{\"text\": \"x\"", "{'text': 'x'}", "{\"text\": \"x\",}", "\u0000", "", "{"];
    broken.forEach((payload, index) => job(db!, `job_broken_${index}`, payload));
    job(db, "job_fine", { text: "x" });
    expect(() => db!.exec(m65())).not.toThrow();
    broken.forEach((payload, index) => expect(db!.query<{ payload: string }, [string]>("SELECT payload FROM jobs WHERE id = ?").get(`job_broken_${index}`)!.payload).toBe(payload));
    expect(payloadOf(db, "job_fine").ownerOnly).toBe(true);
  });

  test("a job with a field the CLI never wrote is not stamped, whatever else it looks like", () => {
    db = beforeM65();
    for (const [id, extra] of Object.entries({ lane: { lane: "task" }, dailyAt: { dailyAt: "09:00" }, days: { days: [1] }, facts: { facts: false }, chainID: { chainID: "c1" }, depth: { depth: 2 }, channelID: { channelID: "main" } })) {
      job(db, `job_${id}`, { text: "x", threadID: "thr_x", notify: true, ...extra });
    }
    db.exec(m65());
    for (const id of ["lane", "dailyAt", "days", "facts", "chainID", "depth", "channelID"]) expect({ id, ownerOnly: payloadOf(db, `job_${id}`).ownerOnly }).toEqual({ id, ownerOnly: undefined });
  });

  test("a job that already says whether it is the owner's keeps what it says", () => {
    db = beforeM65();
    job(db, "job_says_no", { text: "x", ownerOnly: false });
    job(db, "job_says_yes", { text: "x", ownerOnly: true });
    db.exec(m65());
    expect([payloadOf(db, "job_says_no").ownerOnly, payloadOf(db, "job_says_yes").ownerOnly]).toEqual([false, true]);
  });

  test("a finished job, a job of another kind, and a payload that is not JSON are left alone", () => {
    db = beforeM65();
    job(db, "job_done", { text: "x" }, "done");
    job(db, "job_failed", { text: "x" }, "failed");
    job(db, "job_brief", { timeZone: "UTC" }, "queued", "brief");
    job(db, "job_garbage", "not json at all");
    job(db, "job_null", null);
    db.exec(m65());
    expect(payloadOf(db, "job_done").ownerOnly).toBeUndefined();
    expect(payloadOf(db, "job_failed").ownerOnly).toBeUndefined();
    expect(payloadOf(db, "job_brief").ownerOnly).toBeUndefined();
    expect(db.query<{ payload: string }, []>("SELECT payload FROM jobs WHERE id = 'job_garbage'").get()!.payload).toBe("not json at all");
    expect(db.query<{ payload: string | null }, []>("SELECT payload FROM jobs WHERE id = 'job_null'").get()!.payload).toBeNull();
  });

  test("a stamped job reads as the owner's, with nothing read outside; an unstamped bot job does not", () => {
    db = beforeM65();
    job(db, "job_owner", { text: "Check the inbox", threadID: "thr_x" });
    job(db, "job_bot", { text: "Check the inbox", agentID: "ea", scheduledBy: "bot", inputRole: "system" });
    db.exec(m65());
    expect(readCarried(payloadOf(db, "job_owner"))).toMatchObject({ ownerOnly: true, taint: [] });
    expect(readCarried(payloadOf(db, "job_bot")).ownerOnly).toBe(false);
  });
});

describe("the day cap's count of calls with an unknown cost reads an index, not the day's rows", () => {
  // The query `unknownCostCallsSince` makes with no filter (the day's whole count).
  const SQL = "SELECT COUNT(*) AS n FROM usage_ledger WHERE created_at >= ? AND call_kind IS NOT NULL AND cost_usd IS NULL";

  test("the plan is a covering index", () => {
    db = openDatabase(":memory:");
    const plan = db.query<{ detail: string }, [string]>(`EXPLAIN QUERY PLAN ${SQL}`).all("2026-11-17T00:00:00.000Z").map((row) => row.detail).join("\n");
    expect(plan, `the count does not use a covering index:\n${plan}`).toMatch(/USING COVERING INDEX idx_usage_created_kind_cost/);
  });

  test("and it counts what it should", () => {
    db = openDatabase(":memory:");
    const row = (id: string, at: string, kind: string | null, cost: number | null): void => {
      db!.run("INSERT INTO usage_ledger (id, provider, model, input_tokens, output_tokens, day, created_at, call_kind, cost_usd) VALUES (?, 'p', 'm', 1, 1, ?, ?, ?, ?)", [id, at.slice(0, 10), at, kind, cost]);
    };
    row("u1", "2026-11-17T08:00:00.000Z", "turn", null);
    row("u2", "2026-11-17T09:00:00.000Z", "side", null);
    row("u3", "2026-11-17T09:30:00.000Z", "turn", 0.01);
    row("u4", "2026-11-17T10:00:00.000Z", null, null);
    row("u5", "2026-11-16T10:00:00.000Z", "turn", null);
    expect(unknownCostCallsSince(db, "2026-11-17T00:00:00.000Z")).toBe(2);
  });
});
