import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintToken, revokeDevice } from "../../src/auth/tokens";
import { openDatabase } from "../../src/db";
import { startPending, getConnectionByState, completeConnect } from "../../src/plugins/store";
import { runPreflight } from "../../src/routines/preflight";
import { enqueueJob, getJob, getJobByPrefix } from "../../src/stores/jobs";
import { saveLink } from "../../src/stores/links";
import { buildTaskToolRegistry } from "../../src/tools/task-registry";
import { cancelScheduledJob, scheduleJob } from "../../src/tools/jobs-tool";
import { rememberFact } from "../../src/tools/facts";
import { startHarness, type Harness } from "../ws-harness";
import { useThrowawayHome } from "./isolated-home";

/**
 * S3-13 / S3-09: SQL injection paths. Text the model or a message supplies
 * (search queries, ids, titles, a state value) reaches the database through
 * the real tool functions, store functions or dispatcher, and must stay data:
 * no statement runs, no row it should not reach is returned, nothing is lost.
 */

useThrowawayHome();

const dirs: string[] = [];
let db: Database | undefined;
let harness: Harness | undefined;
afterEach(async () => {
  db?.close();
  db = undefined;
  await harness?.stop();
  harness = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const caller = (agent: string) => ({
  threadID: "thr_sql",
  turnID: "trn_sql",
  signal: new AbortController().signal,
  chain: { depth: 1, rootAgentID: agent, currentAgentID: agent, handoffSummary: null },
});

/** Row counts of every table that holds user data, so a dropped or emptied table is caught. */
function snapshot(database: Database): Record<string, number> {
  const out: Record<string, number> = {};
  for (const { name } of database.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
    if (name.includes("_fts")) continue;
    out[name] = database.query<{ n: number }, []>(`SELECT count(*) AS n FROM "${name}"`).get()!.n;
  }
  return out;
}

const PAYLOADS = [
  "' OR '1'='1",
  '" OR "1"="1',
  "'; DROP TABLE agent_memories; --",
  "x%' OR 1=1 --",
  "' UNION SELECT token_hash FROM devices --",
  "%",
  "_",
  "\\",
  "*",
  '"unbalanced',
  "NEAR(zed zee)",
  "content:zed",
  "-zed",
  "^zed",
  "((",
  "zed)",
  "zed OR zee",
  "zed AND NOT zee",
  "zed*",
  "{zed}",
  "a\0b",
  "1; ATTACH DATABASE 'x.db' AS y",
];

describe("search tools (memory, facts, links, transcripts)", () => {
  function seeded() {
    db = openDatabase(":memory:");
    rememberFact(db, { fact: "Quarterly budget review is on Friday" });
    rememberFact(db, { fact: "Travel plan to Lisbon in May" });
    // Another bot's private note: not readable by the caller whatever the query says.
    rememberFact(db, { fact: "TOPSECRET private note of the researcher bot", scope: "agent", agentID: "researcher", visibility: "private" });
    saveLink(db, { url: "https://example.com/budget", title: "Budget page", note: "budget numbers" });
    return buildTaskToolRegistry(db);
  }

  test("a normal query finds its row (so the empty answers below mean something)", async () => {
    const registry = seeded();
    const recalled = (await registry.get("recall_fact")!.handler({ query: "budget" } as never, caller("ea"))) as { facts: Array<{ fact: string }> };
    expect(recalled.facts.map((fact) => fact.fact)).toEqual(["Quarterly budget review is on Friday"]);
    const memory = (await registry.get("memory_search")!.handler({ query: "budget" } as never, caller("ea"))) as { memories: Array<{ text: string }> };
    expect(memory.memories.map((row) => row.text)).toContain("Quarterly budget review is on Friday");
    const links = (await registry.get("links_search")!.handler({ query: "budget" } as never, caller("ea"))) as { links: unknown[] };
    expect(links.links).toHaveLength(1);
  });

  for (const tool of ["recall_fact", "memory_search", "links_search", "transcript_search"]) {
    test(`${tool}: injection text matches nothing, changes nothing, and reads no other table`, async () => {
      const registry = seeded();
      const device = await mintToken(db!, "victim-device");
      const hash = db!.query<{ token_hash: string }, []>("SELECT token_hash FROM devices").get()!.token_hash;
      const before = snapshot(db!);
      for (const query of PAYLOADS) {
        let outcome: unknown;
        try {
          outcome = await registry.get(tool)!.handler({ query } as never, caller("ea"));
        } catch (error) {
          // A refusal is fine; a database error naming SQL is not.
          expect({ tool, query, message: String((error as Error).message) }).toEqual({ tool, query, message: expect.not.stringMatching(/sql|syntax|fts5|near "/i) });
          continue;
        }
        const text = JSON.stringify(outcome);
        expect({ tool, query, leaked: [hash, device.token, "TOPSECRET"].some((secret) => text.includes(secret)) }).toEqual({ tool, query, leaked: false });
        // None of the seeded rows contains these words, so a hit means the text was read as a condition.
        const rows = Object.values(outcome as Record<string, unknown[]>).flat();
        expect({ tool, query, rows: rows.length }).toEqual({ tool, query, rows: 0 });
      }
      expect(snapshot(db!)).toEqual(before);
    });
  }

  test("a LIKE wildcard in a query is searched for literally", async () => {
    db = openDatabase(":memory:");
    rememberFact(db, { fact: "The offer is 100% refundable" });
    rememberFact(db, { fact: "A plain note about nothing" });
    rememberFact(db, { fact: "snake_case names are fine" });
    const registry = buildTaskToolRegistry(db);
    const percent = (await registry.get("memory_search")!.handler({ query: "%" } as never, caller("ea"))) as { memories: Array<{ text: string }> };
    expect(percent.memories.map((row) => row.text)).toEqual(["The offer is 100% refundable"]);
    const underscore = (await registry.get("memory_search")!.handler({ query: "_" } as never, caller("ea"))) as { memories: Array<{ text: string }> };
    expect(underscore.memories.map((row) => row.text)).toEqual(["snake_case names are fine"]);
  });
});

describe("write tools keep text as data", () => {
  test("a task title that is a SQL statement is stored as a title and the table survives", async () => {
    db = openDatabase(":memory:");
    const registry = buildTaskToolRegistry(db);
    const title = "x'); DROP TABLE tasks; DELETE FROM agent_memories; --";
    await registry.get("task_create")!.handler({ title } as never, caller("ea"));
    const listed = (await registry.get("tasks_list")!.handler({} as never, caller("ea"))) as { tasks: Array<{ title: string }> };
    expect(listed.tasks.map((task) => task.title)).toContain(title);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'tasks'").get()).not.toBeNull();
  });

  test("forget_fact with an id that is a condition deletes nothing", async () => {
    db = openDatabase(":memory:");
    rememberFact(db, { fact: "keep me one" });
    rememberFact(db, { fact: "keep me two" });
    const registry = buildTaskToolRegistry(db);
    const before = snapshot(db);
    for (const id of ["' OR '1'='1", "%", "*", "x' OR key_slug LIKE '%", "keep_me_one'--", ""]) {
      try {
        await registry.get("forget_fact")!.handler({ id } as never, caller("ea"));
      } catch {
        // refused: fine
      }
    }
    expect(snapshot(db)).toEqual(before);
  });

  test("a fact whose text is a statement is stored as text", async () => {
    db = openDatabase(":memory:");
    const registry = buildTaskToolRegistry(db);
    const fact = "'); DELETE FROM devices; --";
    await mintToken(db, "keep-this-device");
    await registry.get("remember_fact")!.handler({ fact } as never, caller("ea"));
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM devices").get()!.n).toBe(1);
    const recalled = (await registry.get("recall_fact")!.handler({} as never, caller("ea"))) as { facts: Array<{ fact: string }> };
    expect(recalled.facts.map((row) => row.fact)).toContain(fact);
  });
});

describe("LIKE wildcards in id-prefix lookups", () => {
  // These resolve "a full id or a unique prefix" with `id LIKE 'prefix%'`; a `%` or `_` typed as the prefix is a wildcard, not a prefix.

  test("revoking a device by a wildcard prefix revokes nothing", async () => {
    db = openDatabase(":memory:");
    await mintToken(db, "phone");
    await mintToken(db, "laptop");
    for (const prefix of ["%", "_", "dev_%", "", "dev_____"]) {
      const revoked = revokeDevice(db, prefix);
      expect({ prefix, revoked: revoked?.name ?? null }).toEqual({ prefix, revoked: null });
    }
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM devices WHERE revoked_at IS NULL").get()!.n).toBe(2);
  });

  test("a job looked up by a wildcard prefix is not found, even when there is only one job", () => {
    db = openDatabase(":memory:");
    const only = enqueueJob(db, { kind: "turn", payload: { text: "only job" } });
    for (const prefix of ["%", "_", "job_%"]) {
      expect({ prefix, found: getJobByPrefix(db, prefix)?.id ?? null }).toEqual({ prefix, found: null });
    }
    // A real prefix still works.
    expect(getJobByPrefix(db, only.id.slice(0, 8))?.id).toBe(only.id);
  });

  test("a bot cannot cancel a job it does not know the id of by passing a wildcard", async () => {
    db = openDatabase(":memory:");
    const job = scheduleJob(db, { text: "water the plants", dailyAt: "09:05", days: ["mon"] }, "ea");
    const registry = buildTaskToolRegistry(db);
    for (const id of ["%", "_", "job_%"]) {
      await registry.get("job_cancel")!.handler({ id } as never, caller("ea")).catch(() => undefined);
    }
    expect(getJob(db, job.id)).not.toBeNull();
    // And through the tool-guard, the same by the model's own name for it.
    expect(() => cancelScheduledJob(db!, "%", "ea")).toThrow();
  });

  test("the dispatcher's job.set with a wildcard id acts on no job", async () => {
    harness = await startHarness();
    const job = enqueueJob(harness.db, { kind: "turn", payload: { text: "only job", agentID: "ea" } });
    const client = await harness.connect();
    client.drain();
    client.send({ type: "job.set", jobID: "%", action: "pause" });
    const error = await client.next("error");
    expect(error.code).toBe("unknown_job");
    expect(getJob(harness.db, job.id)!.enabled).toBe(1);
  });

  test("an OAuth state value is matched exactly: a wildcard or a quote finds no pending connection", () => {
    db = openDatabase(":memory:");
    const pending = startPending(db, { pluginID: "gmail", account: "agent", scopes: [], capabilities: {}, state: "st_realvalue" });
    expect(getConnectionByState(db, "st_realvalue")?.id).toBe(pending.id);
    for (const state of ["%", "_", "st_%", "st_realvalu_", '"', '","x":"', `st_realvalue","state":"x`, "", "st_realvalue%"]) {
      expect({ state, found: getConnectionByState(db, state)?.id ?? null }).toEqual({ state, found: null });
    }
    // Once connected, the state is spent: the same value finds nothing.
    completeConnect(db, pending.id, { access_token: "t" } as never, "a@example.test");
    expect(getConnectionByState(db, "st_realvalue")).toBeNull();
  });
});

describe("routine pre-check SQL (S3-09)", () => {
  function fileDB(): Database {
    const dir = mkdtempSync(join(tmpdir(), "agni-sql-injection-"));
    dirs.push(dir);
    const database = openDatabase(join(dir, "agni.sqlite"));
    return database;
  }

  test.each([
    ["the device token hashes", "SELECT token_hash FROM devices"],
    ["the OAuth tokens", "SELECT tokens FROM plugin_connections"],
    ["a pairing code hash", "SELECT code_hash FROM pair_codes"],
    ["a boolean oracle on a stored token", "SELECT substr(tokens, 1, 1) = 'a' FROM plugin_connections"],
    ["a table list", "SELECT name FROM sqlite_master"],
    ["a pragma function", "SELECT * FROM pragma_database_list"],
    ["a function that loads code", "SELECT load_extension('x')"],
  ])("a model-written query that reads %s is refused", async (_label, query) => {
    db = fileDB();
    await mintToken(db, "secret-device");
    await expect(runPreflight({ kind: "sql", query }, db, null)).rejects.toThrow();
  });

  test.each([
    ["a second statement", "SELECT 1; DELETE FROM devices"],
    ["a comment hiding a second statement", "SELECT 1 /* ; */; DELETE FROM devices"],
    ["a write keyword", "DELETE FROM devices"],
    ["an insert", "INSERT INTO meta(key, value) VALUES ('x', 'y')"],
    ["lowercase attach", "select 1 from x attach database 'y' as z"],
    ["a recursive query", "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c"],
    ["a pragma", "PRAGMA writable_schema = 1"],
    ["a vacuum", "VACUUM INTO 'x.db'"],
  ])("%s is refused and nothing changes", async (_label, query) => {
    db = fileDB();
    await mintToken(db, "keep-me");
    const before = snapshot(db);
    await expect(runPreflight({ kind: "sql", query }, db, null)).rejects.toThrow();
    expect(snapshot(db)).toEqual(before);
  });
});
