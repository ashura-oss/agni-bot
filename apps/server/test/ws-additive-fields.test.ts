import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { ensureConversation } from "../src/stores/conversations";
import { enqueueJob } from "../src/stores/jobs";
import { buildConversationHistory } from "../src/ws/history";
import { startHarness, type Harness } from "./ws-harness";

/** W2-A item 6: JobInfo carries dailyAt, days and internal; MessageInfo carries stopReason. */

let harness: Harness | undefined;
let db: Database | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
  db?.close();
  db = undefined;
});

const FAR = "2099-01-01T00:00:00.000Z";

describe("job.list.ok recurrence and housekeeping fields", () => {
  test("a wall-clock job lists its time and weekday names", async () => {
    harness = await startHarness();
    const job = enqueueJob(harness.db, {
      kind: "turn",
      runAt: FAR,
      payload: { agentID: "ea", text: "Weekly summary", dailyAt: "09:05", days: [1, 2, 3, 4, 5] },
    });
    const client = await harness.connect();
    client.send({ type: "job.list" });
    const listed = (await client.next("job.list.ok")).jobs.find((entry) => entry.id === job.id)!;
    expect(listed).toMatchObject({ dailyAt: "09:05", days: ["mon", "tue", "wed", "thu", "fri"], internal: false });
  });

  test("a job with no weekday limit lists a time and no days; an interval job lists neither", async () => {
    harness = await startHarness();
    const daily = enqueueJob(harness.db, { kind: "turn", runAt: FAR, payload: { agentID: "ea", text: "Daily", dailyAt: "07:30" } });
    const every = enqueueJob(harness.db, { kind: "turn", runAt: FAR, payload: { agentID: "ea", text: "Often", everyMs: 3_600_000 } });
    const client = await harness.connect();
    client.send({ type: "job.list" });
    const jobs = (await client.next("job.list.ok")).jobs;
    const dailyInfo = jobs.find((entry) => entry.id === daily.id)!;
    expect(dailyInfo.dailyAt).toBe("07:30");
    expect(dailyInfo.days).toBeUndefined();
    const everyInfo = jobs.find((entry) => entry.id === every.id)!;
    expect(everyInfo).toMatchObject({ everyMs: 3_600_000, internal: false });
    expect(everyInfo.dailyAt).toBeUndefined();
  });

  test("housekeeping kinds are internal; the owner's kinds and unknown kinds are not", async () => {
    harness = await startHarness();
    const kinds = ["tagger", "memory.embed", "memory.consolidate", "summary.rollup", "rollover.summarize", "db.backup", "harness.review", "turn", "routine", "brief", "task.reminder", "something.new"];
    const ids = new Map(kinds.map((kind) => [enqueueJob(harness!.db, { kind, runAt: FAR }).id, kind]));
    const client = await harness.connect();
    client.send({ type: "job.list" });
    const jobs = (await client.next("job.list.ok")).jobs.filter((entry) => ids.has(entry.id));
    expect(jobs).toHaveLength(kinds.length);
    const internal = jobs.filter((entry) => entry.internal).map((entry) => entry.kind).sort();
    expect(internal).toEqual(["db.backup", "harness.review", "memory.consolidate", "memory.embed", "rollover.summarize", "summary.rollup", "tagger"]);
    expect(jobs.every((entry) => typeof entry.internal === "boolean")).toBe(true);
  });
});

/** A thread under the conversation with one assistant message from a turn that ended with `stopReason`. */
function seedTurn(database: Database, conversationID: string, options: { turnID: string; stopReason: string | null; createdAt: string; channel?: boolean }): void {
  database.run("INSERT OR IGNORE INTO threads (id, agent_id, conversation_id, created_at, updated_at) VALUES ('thr_1', 'ea', ?, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')", [conversationID]);
  database.run("INSERT INTO turns (id, thread_id, agent_id, state, stop_reason, started_at) VALUES (?, 'thr_1', 'ea', ?, ?, ?)", [options.turnID, options.stopReason === null ? "running" : "done", options.stopReason, options.createdAt]);
  database.run("INSERT INTO messages (id, thread_id, turn_id, role, text, created_at) VALUES (?, 'thr_1', ?, 'assistant', ?, ?)", [`msg_${options.turnID}`, options.turnID, `answer ${options.turnID}`, options.createdAt]);
}

describe("conversation history stopReason", () => {
  test("an assistant message names how its turn ended; a user message and a running turn name nothing", () => {
    db = openDatabase(":memory:");
    const conversation = ensureConversation(db, "ea");
    seedTurn(db, conversation.id, { turnID: "trn_done", stopReason: "end", createdAt: "2026-11-01T00:00:01.000Z" });
    seedTurn(db, conversation.id, { turnID: "trn_cut", stopReason: "timeout", createdAt: "2026-11-01T00:00:02.000Z" });
    seedTurn(db, conversation.id, { turnID: "trn_live", stopReason: null, createdAt: "2026-11-01T00:00:03.000Z" });
    db.run("INSERT INTO messages (id, thread_id, turn_id, role, text, created_at) VALUES ('msg_user', 'thr_1', 'trn_cut', 'user', 'question', '2026-11-01T00:00:02.000Z')");

    const messages = buildConversationHistory(db, conversation.id, 50);
    const byID = new Map(messages.map((message) => [message.id, message]));
    expect(byID.get("msg_trn_done")?.stopReason).toBe("end");
    expect(byID.get("msg_trn_cut")?.stopReason).toBe("timeout");
    expect(byID.get("msg_trn_live")?.stopReason).toBeUndefined();
    expect(byID.get("msg_user")?.stopReason).toBeUndefined();
  });

  test("a channel reply carries its turn's stop reason, and merging with its thread copy keeps it", () => {
    db = openDatabase(":memory:");
    const conversation = ensureConversation(db, "ea");
    seedTurn(db, conversation.id, { turnID: "trn_cut", stopReason: "timeout", createdAt: "2026-11-01T00:00:02.000Z" });
    // The same reply, as the channel stored it a moment later (what a turn does).
    db.run(
      `INSERT INTO channel_messages (id, channel_id, from_type, from_id, text, internal, compacted, salience, turn_id, created_at)
       VALUES ('chm_1', 'main', 'agent', 'ea', 'answer trn_cut', 0, 0, 'recent_turns', 'trn_cut', '2026-11-01T00:00:03.000Z')`,
    );
    const messages = buildConversationHistory(db, conversation.id, 50).filter((message) => message.text === "answer trn_cut");
    expect(messages).toHaveLength(1);
    expect(messages[0]?.stopReason).toBe("timeout");
  });
});

describe("thread.history stopReason", () => {
  test("is on the wire for an assistant message", async () => {
    harness = await startHarness();
    const conversation = ensureConversation(harness.db, "ea");
    seedTurn(harness.db, conversation.id, { turnID: "trn_cut", stopReason: "budget", createdAt: "2026-11-01T00:00:02.000Z" });
    const client = await harness.connect();
    client.send({ type: "thread.history", threadID: "thr_1" });
    const answer = await client.next("thread.history.ok");
    expect(answer.messages.find((message) => message.id === "msg_trn_cut")?.stopReason).toBe("budget");
  });
});
