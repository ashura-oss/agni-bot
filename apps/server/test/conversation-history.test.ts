import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mintToken } from "../src/auth/tokens";
import { openDatabase } from "../src/db";
import { ensureConversation } from "../src/stores/conversations";
import { buildConversationHistory } from "../src/ws/history";

/** S1-32: `conversation.history` honours `limit` for channel messages and does not query once per row. */

let db: Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

/** `count` owner/agent messages in #main, one second apart, ids m001.. in time order. */
function seedChannel(database: Database, count: number): string {
  const conversation = ensureConversation(database, "ea");
  const start = Date.parse("2026-11-01T00:00:00.000Z");
  for (let index = 1; index <= count; index += 1) {
    const id = `m${String(index).padStart(3, "0")}`;
    const fromType = index % 2 === 0 ? "agent" : "user";
    database.run(
      `INSERT INTO channel_messages (id, channel_id, from_type, from_id, text, internal, compacted, salience, created_at)
       VALUES (?, 'main', ?, ?, ?, 0, 0, 'recent_turns', ?)`,
      [id, fromType, fromType === "agent" ? "ea" : "user", `message ${index}`, new Date(start + index * 1000).toISOString()],
    );
  }
  return conversation.id;
}

describe("buildConversationHistory", () => {
  test("returns the newest N channel messages, oldest first", () => {
    db = openDatabase(":memory:");
    const conversationID = seedChannel(db, 60);
    const messages = buildConversationHistory(db, conversationID, 10);
    expect(messages.map((message) => message.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `m${String(51 + index).padStart(3, "0")}`),
    );
  });

  test("a limit larger than the history returns all of it", () => {
    db = openDatabase(":memory:");
    const conversationID = seedChannel(db, 5);
    expect(buildConversationHistory(db, conversationID, 500)).toHaveLength(5);
  });

  test("does not run an attachment query per message", async () => {
    db = openDatabase(":memory:");
    const conversationID = seedChannel(db, 40);
    const { device } = await mintToken(db, "history-test");
    db.run("INSERT INTO attachments (id, device_id, name, mime_type, size, kind, path, created_at) VALUES ('att_1', ?, 'notes.txt', 'text/plain', 5, 'text', '/x', ?)", [device.id, new Date().toISOString()]);
    db.run("INSERT INTO message_attachments (message_id, attachment_id, position) VALUES ('m038', 'att_1', 0)");

    const real = db.query.bind(db) as (sql: string) => unknown;
    let attachmentQueries = 0;
    (db as unknown as { query: (sql: string) => unknown }).query = (sql: string) => {
      if (sql.includes("message_attachments")) attachmentQueries += 1;
      return real(sql);
    };
    const messages = buildConversationHistory(db, conversationID, 30);
    expect(attachmentQueries).toBeLessThanOrEqual(2);
    expect(messages.find((message) => message.id === "m038")?.attachments?.map((file) => file.id)).toEqual(["att_1"]);
    expect(messages.find((message) => message.id === "m039")?.attachments).toEqual([]);
  });

  test("a thread copy and a channel copy of the same message are one message", () => {
    db = openDatabase(":memory:");
    const conversationID = seedChannel(db, 4);
    const conversation = ensureConversation(db, "ea");
    db.run("INSERT INTO threads (id, agent_id, conversation_id, created_at, updated_at) VALUES ('thr_1', 'ea', ?, ?, ?)", [conversation.id, "2026-11-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z"]);
    // The same words as m002, stored on the thread a second later (as a turn does).
    db.run("INSERT INTO messages (id, thread_id, turn_id, role, text, created_at) VALUES ('msg_1', 'thr_1', NULL, 'assistant', 'message 2', ?)", ["2026-11-01T00:00:03.000Z"]);
    const messages = buildConversationHistory(db, conversationID, 50);
    expect(messages.filter((message) => message.text === "message 2")).toHaveLength(1);
    expect(messages).toHaveLength(4);
  });

  test("system-role thread rows (job instructions, wake text) are not owner messages and do not use up the limit", () => {
    db = openDatabase(":memory:");
    const conversationID = seedChannel(db, 4);
    const conversation = ensureConversation(db, "ea");
    db.run("INSERT INTO threads (id, agent_id, conversation_id, created_at, updated_at) VALUES ('thr_1', 'ea', ?, ?, ?)", [conversation.id, "2026-11-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z"]);
    db.run("INSERT INTO messages (id, thread_id, turn_id, role, text, created_at) VALUES ('msg_job', 'thr_1', NULL, 'system', 'Scheduled job: send the weekly summary', '2026-11-01T00:00:09.000Z')");
    db.run("INSERT INTO messages (id, thread_id, turn_id, role, text, created_at) VALUES ('msg_wake', 'thr_1', NULL, 'system', 'A delegated task finished: result inside', '2026-11-01T00:00:10.000Z')");
    const messages = buildConversationHistory(db, conversationID, 4);
    expect(messages.map((message) => message.id)).toEqual(["m001", "m002", "m003", "m004"]);
    expect(messages.some((message) => message.text.includes("Scheduled job"))).toBe(false);
  });

  test("a system notice the app posted to the channel is still shown", () => {
    db = openDatabase(":memory:");
    const conversationID = seedChannel(db, 2);
    db.run(
      `INSERT INTO channel_messages (id, channel_id, from_type, from_id, text, internal, compacted, salience, created_at)
       VALUES ('m_note', 'main', 'system', 'ea', 'That reply was interrupted.', 0, 0, 'recent_turns', '2026-11-01T00:00:09.000Z')`,
    );
    const messages = buildConversationHistory(db, conversationID, 50);
    expect(messages.find((message) => message.id === "m_note")).toMatchObject({ role: "system" });
  });
});
