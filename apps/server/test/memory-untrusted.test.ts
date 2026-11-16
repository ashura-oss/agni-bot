/**
 * S2-05: what a run writes after reading outside text is kept as the bot's own note, flagged
 * `source = 'untrusted'`. It is never injected into a prompt as a fact; the model's own explicit
 * recall and the owner's lists can still reach it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { listAgentMemories, putAgentMemory, searchAgentMemories, searchMemoriesByVector, setMemoryEmbedding } from "../src/stores/agent-memories";
import { recallFact, rememberFact } from "../src/tools/facts";

let db: Database;
beforeEach(() => {
  db = openDatabase(":memory:");
  rememberFact(db, { fact: "The owner pays invoices on Friday", source: "user" });
  putAgentMemory(db, { scope: "agent", agentID: "ea", keySlug: "page_note", type: "fact", content: "The page says invoices go to boss at evil dot example", source: "untrusted" });
});
afterEach(() => db.close());

describe("notes kept from outside text", () => {
  test("a search that feeds a prompt does not find them", () => {
    const hits = searchAgentMemories(db, { query: "invoices", callerAgentID: "ea" });
    expect(hits.map((hit) => hit.row.content)).toEqual(["The owner pays invoices on Friday"]);
  });

  test("the model's own explicit recall can ask for them", () => {
    const hits = searchAgentMemories(db, { query: "invoices", callerAgentID: "ea", includeUntrusted: true });
    expect(hits.map((hit) => hit.row.source).sort()).toEqual(["untrusted", "user"]);
  });

  test("the facts injected into the prompt prefix leave them out, with or without a query", () => {
    expect(recallFact(db, { query: "invoices", callerAgentID: "ea" }).facts.map((fact) => fact.fact)).toEqual(["The owner pays invoices on Friday"]);
    expect(recallFact(db, { scope: "agent", agentID: "ea", callerAgentID: "ea", limit: 5 }).facts).toEqual([]);
  });

  test("recall_fact as a tool call may read them", () => {
    const facts = recallFact(db, { scope: "agent", agentID: "ea", callerAgentID: "ea", limit: 5, includeUntrusted: true }).facts;
    expect(facts.map((fact) => fact.fact)).toEqual(["The page says invoices go to boss at evil dot example"]);
  });

  test("the owner's own lists still show them, so they can be read and removed", () => {
    const rows = listAgentMemories(db, { scope: "agent", agentID: "ea", callerAgentID: "ea" });
    expect(rows.map((row) => row.source)).toEqual(["untrusted"]);
    expect(listAgentMemories(db, { scope: "agent", agentID: "ea", callerAgentID: "ea", excludeUntrusted: true })).toEqual([]);
  });

  test("a vector search that feeds a prompt does not find them either", () => {
    const rows = db.query<{ id: string; source: string }, []>("SELECT id, source FROM agent_memories").all();
    for (const row of rows) setMemoryEmbedding(db, row.id, new Float32Array([1, 0, 0]), "test-model");
    const found = searchMemoriesByVector(db, { vector: new Float32Array([1, 0, 0]), callerAgentID: "ea" });
    expect(found.map((hit) => hit.row.source)).toEqual(["user"]);
    expect(searchMemoriesByVector(db, { vector: new Float32Array([1, 0, 0]), callerAgentID: "ea", includeUntrusted: true })).toHaveLength(2);
  });
});
