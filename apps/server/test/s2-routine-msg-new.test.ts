/**
 * Carried from Sprint 1: a routine's final post reaches the owner's channel as
 * a `msg.new`, so it shows without a reload. The saved-state block never does,
 * a run with nothing to report stays silent, and a failed run posts nothing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { ServerFrameBody } from "@agni/protocol";
import { openDatabase } from "../src/db";
import { executeRoutine } from "../src/routines/run";
import type { Routine } from "../src/routines/types";
import { insertRoutine } from "../src/stores/routines";
import { createThread } from "../src/stores/threads";

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

function routine(overrides: Partial<Routine> = {}): Routine {
  const now = new Date().toISOString();
  return {
    id: "rtn_msg", jobID: "job_msg", agentID: "ea", name: "Daily check", prompt: "Check the status.",
    cron: "0 9 * * *", timezone: "UTC", misfire: "run_once", preflight: { kind: "none" },
    maxTokens: 16_000, maxExecutionMs: 5_000, allowedDomains: [], threadID: null,
    lastStateHash: null, stateContext: null, successStreak: 0, failureStreak: 0,
    createdAt: now, updatedAt: now, ...overrides,
  };
}

function setup(value: Routine): Database {
  db = openDatabase(":memory:");
  db.run("INSERT INTO jobs (id, kind, payload, run_at, enabled, created_at, updated_at) VALUES (?, 'routine', '{}', ?, 1, ?, ?)", [value.jobID, new Date().toISOString(), value.createdAt, value.createdAt]);
  insertRoutine(db, value);
  return db;
}

const settings = { firstTokenTimeoutMs: 1_000, turnTimeoutMs: 10_000 };
const withState = (text: string) => `${text}\n\nRoutine state (used next run)\n\`\`\`json\n{"stateContext":{"seen":2}}\n\`\`\``;

async function run(value: Routine, reply: string | (() => never)): Promise<{ frames: ServerFrameBody[]; database: Database }> {
  const database = setup(value);
  const frames: ServerFrameBody[] = [];
  const router = { route: async () => (typeof reply === "function" ? reply() : { text: reply, outputTokens: 5, provider: "fake", model: "fake", latencyMs: 1 }) } as never;
  await executeRoutine({ db: database, router, settings, emit: (frame) => frames.push(frame) }, { ...value, threadID: createThread(database, value.agentID).id });
  return { frames, database };
}

describe("routine msg.new", () => {
  test("the main assistant's routine posts its final reply to the main channel", async () => {
    const { frames, database } = await run(routine(), withState("The server is healthy."));
    const posted = frames.filter((frame) => frame.type === "msg.new");
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ type: "msg.new", channelId: "main", fromType: "agent", fromId: "ea", text: "The server is healthy.", internal: false });
    // The saved-state block never reaches the owner's channel.
    expect((posted[0] as { text: string }).text).not.toContain("stateContext");
    const row = database.query<{ text: string; peer_influenced: number; turn_id: string | null }, []>("SELECT text, peer_influenced, turn_id FROM channel_messages WHERE channel_id = 'main' AND from_type = 'agent'").get();
    expect(row?.text).toBe("The server is healthy.");
    // What a routine says was shaped by saved state and fetched pages: it is marked as such.
    expect(row?.peer_influenced).toBe(1);
    expect(row?.turn_id).toBeTruthy();
  });

  test("another bot's routine posts to that bot's own channel", async () => {
    const { frames } = await run(routine({ agentID: "researcher", id: "rtn_r", jobID: "job_r" }), withState("Found two new papers."));
    const posted = frames.find((frame) => frame.type === "msg.new");
    expect(posted).toMatchObject({ channelId: "dm:researcher", fromId: "researcher", text: "Found two new papers." });
  });

  test("a run with nothing to report posts nothing", async () => {
    const { frames, database } = await run(routine(), withState("NOTHING_TO_REPORT"));
    expect(frames.filter((frame) => frame.type === "msg.new")).toEqual([]);
    expect(database.query("SELECT COUNT(*) AS n FROM channel_messages WHERE from_type = 'agent'").get()).toEqual({ n: 0 });
  });

  test("a reply that was only the state block posts the same short line the thread shows", async () => {
    const { frames } = await run(routine(), "```json\n{\"stateContext\":{\"seen\":3}}\n```");
    expect(frames.find((frame) => frame.type === "msg.new")).toMatchObject({ text: "Routine completed; state saved." });
  });

  test("a failed run posts nothing", async () => {
    const { frames } = await run(routine(), () => { throw new Error("model down"); });
    expect(frames.filter((frame) => frame.type === "msg.new")).toEqual([]);
  });
});

describe("routine token count", () => {
  async function tokensWith(options: { ledgerKeepsTurnID: boolean }): Promise<number> {
    const value = routine({ id: "rtn_tok", jobID: "job_tok" });
    const database = setup(value);
    if (!options.ledgerKeepsTurnID) {
      // The per-call ledger (S2-10) writes rows with no turn_id: model that by clearing it as each row lands.
      database.run("CREATE TRIGGER no_turn_id AFTER INSERT ON usage_ledger BEGIN UPDATE usage_ledger SET turn_id = NULL WHERE id = NEW.id; END;");
    }
    const router = { route: async () => ({ text: withState("All good."), inputTokens: 30, outputTokens: 20, provider: "fake", model: "fake", latencyMs: 1 }) } as never;
    const result = await executeRoutine({ db: database, router, settings, emit: () => undefined }, { ...value, threadID: createThread(database, "ea").id });
    return result.tokens;
  }

  test("counts the turn's tokens when the ledger rows carry the turn id", async () => {
    expect(await tokensWith({ ledgerKeepsTurnID: true })).toBe(50);
  });

  test("counts the same when the ledger rows carry no turn id", async () => {
    expect(await tokensWith({ ledgerKeepsTurnID: false })).toBe(50);
  });
});
