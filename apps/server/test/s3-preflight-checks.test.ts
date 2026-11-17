import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { MIGRATIONS } from "../src/db/migrations";
import { S3_MIGRATIONS } from "../src/db/s3";
import { PREFLIGHT_CHECKS, describeChecks, parseCheckPreflight, type CheckPreflight } from "../src/routines/preflight-checks";
import { runPreflight } from "../src/routines/preflight";

/** S3-09: routine pre-checks are a fixed list of parameterised checks, never model-written SQL. */

const open: Database[] = [];
function db(): Database {
  const database = openDatabase(":memory:");
  open.push(database);
  return database;
}
afterEach(() => { for (const database of open.splice(0)) database.close(); });

const check = (name: string, params: Record<string, string | number> = {}): CheckPreflight => ({ kind: "check", name, params }) as CheckPreflight;

describe("the list of checks", () => {
  test("is fixed, named and described", () => {
    const names = PREFLIGHT_CHECKS.map((entry) => entry.name);
    expect(names).toEqual(["thread_activity", "agent_memories", "open_tasks", "pending_approvals", "failed_jobs", "new_turns"]);
    for (const entry of describeChecks()) expect(entry.description.length).toBeGreaterThan(10);
  });

  test("every check is a constant statement with placeholders only: no interpolation points", () => {
    for (const entry of PREFLIGHT_CHECKS) {
      expect(entry.sql).toMatch(/^SELECT /);
      expect(entry.sql).not.toContain(";");
      expect(entry.sql).not.toContain("${");
      expect((entry.sql.match(/\?/g) ?? []).length).toBe(entry.bind(entry.sampleParams()).length);
    }
  });
});

describe("parseCheckPreflight", () => {
  test("accepts a known name with typed parameters and fills defaults", () => {
    expect(parseCheckPreflight({ kind: "check", name: "thread_activity", params: { agentID: "ea" } })).toEqual(check("thread_activity", { agentID: "ea" }));
    expect(parseCheckPreflight({ kind: "check", name: "new_turns", params: { agentID: "ea" } })).toEqual(check("new_turns", { agentID: "ea", hours: 24 }));
    expect(parseCheckPreflight({ kind: "check", name: "pending_approvals" })).toEqual(check("pending_approvals"));
  });

  test.each([
    [{ kind: "check", name: "drop_everything" }, /unknown check/],
    [{ kind: "check", name: "thread_activity" }, /agentID is required/],
    [{ kind: "check", name: "thread_activity", params: { agentID: "ea; DROP TABLE agents" } }, /agentID/],
    [{ kind: "check", name: "thread_activity", params: { agentID: "ea' OR '1'='1" } }, /agentID/],
    [{ kind: "check", name: "thread_activity", params: { agentID: 7 } }, /agentID/],
    [{ kind: "check", name: "thread_activity", params: { agentID: "ea", extra: "x" } }, /unknown parameter/],
    [{ kind: "check", name: "new_turns", params: { agentID: "ea", hours: 0 } }, /hours/],
    [{ kind: "check", name: "new_turns", params: { agentID: "ea", hours: 100000 } }, /hours/],
    [{ kind: "check", name: "new_turns", params: { agentID: "ea", hours: 1.5 } }, /hours/],
    [{ kind: "check", name: "new_turns", params: { agentID: "ea", hours: "24" } }, /hours/],
    [{ kind: "check", name: "pending_approvals", params: { x: 1 } }, /unknown parameter/],
    ["SELECT 1", /preflight/],
    [null, /preflight/],
  ])("refuses %j", (input, message) => {
    expect(() => parseCheckPreflight(input)).toThrow(message);
  });
});

describe("runPreflight with a named check", () => {
  test("hashes the check's answer: unchanged state is changed:false, a new row is changed:true", async () => {
    const database = db();
    const first = await runPreflight(check("pending_approvals"), database, null);
    expect(first.changed).toBe(true);
    expect(await runPreflight(check("pending_approvals"), database, first.hash)).toEqual({ ...first, changed: false });
    database.run("INSERT INTO approvals (id, action, preview, status, created_at) VALUES ('a1', 'x', 'p', 'pending', ?)", [new Date().toISOString()]);
    const after = await runPreflight(check("pending_approvals"), database, first.hash);
    expect(after.changed).toBe(true);
    expect(after.hash).not.toBe(first.hash);
  });

  test("each check reads what its name says, scoped by its parameters", async () => {
    const database = db();
    const before = await runPreflight(check("thread_activity", { agentID: "ea" }), database, null);
    database.run("INSERT INTO threads (id, agent_id, created_at, updated_at) VALUES ('t1', 'ea', 'now', 'now')");
    database.run("INSERT INTO messages (id, thread_id, role, text, created_at) VALUES ('m1', 't1', 'user', 'hi', '2026-01-01T00:00:00Z')");
    const other = await runPreflight(check("thread_activity", { agentID: "researcher" }), database, null);
    const mine = await runPreflight(check("thread_activity", { agentID: "ea" }), database, before.hash);
    expect(mine.changed).toBe(true);
    // The other bot's activity is a different question with its own, unchanged, answer.
    expect((await runPreflight(check("thread_activity", { agentID: "researcher" }), database, other.hash)).changed).toBe(false);
  });

  test("works on an in-memory database; it needs no file", async () => {
    const database = new Database(":memory:");
    open.push(database);
    database.exec("CREATE TABLE approvals (id TEXT, status TEXT, created_at TEXT);");
    await expect(runPreflight(check("pending_approvals"), database, null)).resolves.toMatchObject({ changed: true });
  });

  test("parameters are bound, not spliced: a hostile value that gets past the type check cannot change the statement", async () => {
    const database = db();
    database.run("INSERT INTO threads (id, agent_id, created_at, updated_at) VALUES ('t1', 'ea', 'now', 'now')");
    // runPreflight validates again, so a stored routine edited by hand is still refused.
    await expect(runPreflight(check("thread_activity", { agentID: "x' OR 1=1 --" }), database, null)).rejects.toThrow(/agentID/);
    expect(database.query("SELECT COUNT(*) AS n FROM threads").get()).toEqual({ n: 1 });
  });

  test("an unknown check name from a stored routine fails with a message, not a query", async () => {
    const database = db();
    await expect(runPreflight({ kind: "check", name: "nope", params: {} } as never, database, null)).rejects.toThrow(/unknown check/);
  });
});

describe("the retired SQL pre-check", () => {
  test("a stored routine with kind sql is refused with a message saying what to do, and nothing runs", async () => {
    const database = db();
    let queried = false;
    const spy = new Proxy(database, {
      get(target, prop) {
        if (prop === "query" || prop === "prepare" || prop === "run" || prop === "exec") queried = true;
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const error = await runPreflight({ kind: "sql", query: "SELECT 1" }, spy, null).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/SQL pre-checks were removed/);
    expect((error as Error).message).toMatch(/named check/);
    expect(queried).toBe(false);
  });
});

describe("migration 63: existing routines with a SQL pre-check", () => {
  function legacyDB(): Database {
    const database = new Database(":memory:");
    open.push(database);
    for (const migration of MIGRATIONS.filter((entry) => entry.id < 63)) database.exec(migration.sql);
    return database;
  }
  const migration = S3_MIGRATIONS[3];

  function addRoutine(database: Database, id: string, preflight: string): void {
    database.run("INSERT INTO jobs (id, kind, payload, state, run_at, created_at, updated_at, enabled) VALUES (?, 'routine', NULL, 'queued', '2030-01-01T00:00:00Z', 'now', 'now', 1)", [`job_${id}`]);
    database.run(
      `INSERT INTO routines (id, job_id, agent_id, name, prompt, cron, timezone, misfire, preflight, max_tokens, max_execution_ms, allowed_domains, last_state_hash, created_at, updated_at)
       VALUES (?, ?, 'ea', ?, 'p', '*/10 * * * *', 'UTC', 'skip', ?, 1000, 1000, '[]', 'oldhash', 'now', 'now')`,
      [id, `job_${id}`, `Routine ${id}`, preflight],
    );
  }

  test("is registered", () => {
    expect(migration).not.toBeNull();
    expect(migration?.id).toBe(63);
  });

  test("pauses each SQL routine, drops its query, and leaves a run row that says why", () => {
    const database = legacyDB();
    addRoutine(database, "r_sql", JSON.stringify({ kind: "sql", query: "SELECT count(*) FROM tasks" }));
    addRoutine(database, "r_none", JSON.stringify({ kind: "none" }));
    addRoutine(database, "r_http", JSON.stringify({ kind: "http", url: "https://example.com/" }));
    addRoutine(database, "r_bad", "not json at all");
    database.exec(migration!.sql);

    const sql = database.query<{ preflight: string; last_state_hash: string | null }, []>("SELECT preflight, last_state_hash FROM routines WHERE id = 'r_sql'").get();
    expect(JSON.parse(sql!.preflight)).toEqual({ kind: "none" });
    expect(sql!.last_state_hash).toBeNull();
    expect(database.query("SELECT enabled FROM jobs WHERE id = 'job_r_sql'").get()).toEqual({ enabled: 0 });

    const run = database.query<{ outcome: string; error: string }, []>("SELECT outcome, error FROM routine_runs WHERE routine_id = 'r_sql'").get();
    expect(run?.outcome).toBe("failed");
    expect(run?.error).toMatch(/SQL pre-check was removed/);
    expect(run?.error).toMatch(/paused/i);

    // The others are untouched, including a row whose JSON is broken.
    for (const id of ["r_none", "r_http", "r_bad"]) {
      expect(database.query(`SELECT enabled FROM jobs WHERE id = 'job_${id}'`).get()).toEqual({ enabled: 1 });
      expect(database.query(`SELECT COUNT(*) AS n FROM routine_runs WHERE routine_id = '${id}'`).get()).toEqual({ n: 0 });
    }
    expect(database.query("SELECT preflight FROM routines WHERE id = 'r_http'").get()).toEqual({ preflight: JSON.stringify({ kind: "http", url: "https://example.com/" }) });
    expect(database.query("SELECT preflight FROM routines WHERE id = 'r_bad'").get()).toEqual({ preflight: "not json at all" });
  });

  test("a database with no routines migrates cleanly", () => {
    const database = legacyDB();
    expect(() => database.exec(migration!.sql)).not.toThrow();
  });
});
