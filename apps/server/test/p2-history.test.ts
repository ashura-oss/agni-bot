/**
 * conversation history pairs a message stored on both the thread and the
 * channel one-to-one, never by text alone, and shows every row once in order.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { ensureConversation, openSession } from "../src/stores/conversations";
import { buildConversationHistory } from "../src/ws/history";
import { createTurn } from "../src/stores/threads";

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

const T0 = Date.parse("2026-11-16T10:00:00.000Z");
const at = (ms: number): string => new Date(T0 + ms).toISOString();

function seed(): { conversationID: string; threadID: string } {
  db = openDatabase(":memory:");
  const conversation = ensureConversation(db, "ea");
  const thread = openSession(db, conversation, "manual", null);
  return { conversationID: conversation.id, threadID: thread.id };
}
function threadRow(threadID: string, id: string, turnID: string | null, role: string, text: string, ms: number): void {
  db!.run("INSERT INTO messages (id, thread_id, turn_id, role, text, created_at) VALUES (?, ?, ?, ?, ?, ?)", [id, threadID, turnID, role, text, at(ms)]);
}
function channelRow(id: string, turnID: string | null, fromType: string, fromID: string, text: string, ms: number): void {
  db!.run(
    "INSERT INTO channel_messages (id, channel_id, from_type, from_id, text, internal, compacted, salience, turn_id, created_at) VALUES (?, 'main', ?, ?, ?, 0, 0, 'recent_turns', ?, ?)",
    [id, fromType, fromID, text, turnID, at(ms)],
  );
}

describe("a repeated identical question", () => {
  test("two identical user messages with an interrupted turn between them: every row once, in order, the notice between", () => {
    const { conversationID, threadID } = seed();
    createTurn(db!, { id: "trn_1", threadID, agentID: "ea" });
    createTurn(db!, { id: "trn_2", threadID, agentID: "ea" });
    const Q = "what files are in the folder?";
    // First ask: stored on the thread and the channel a few ms apart, then the server was killed.
    threadRow(threadID, "msg_q1", "trn_1", "user", Q, 0);
    channelRow("chm_q1", "trn_1", "user", "device_a", Q, 4);
    channelRow("chm_notice", null, "system", "ea", "This reply was interrupted by a restart.", 3_000);
    // The same question again ten seconds later, answered.
    threadRow(threadID, "msg_q2", "trn_2", "user", Q, 10_000);
    channelRow("chm_q2", "trn_2", "user", "device_a", Q, 10_004);
    threadRow(threadID, "msg_a2", "trn_2", "assistant", "Three files.", 12_000);
    channelRow("chm_a2", "trn_2", "agent", "ea", "Three files.", 12_003);

    const history = buildConversationHistory(db!, conversationID, 200);
    expect(history.map((message) => `${message.role}: ${message.text}`)).toEqual([
      `user: ${Q}`,
      "system: This reply was interrupted by a restart.",
      `user: ${Q}`,
      "assistant: Three files.",
    ]);
    // Each paired message is one message, and the two questions are not the same row.
    const ids = history.map((message) => message.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).not.toBe(ids[2]);
    expect(history.map((message) => message.createdAt)).toEqual([...history.map((message) => message.createdAt)].sort());
  });

  test("with no turn id on either side, the nearest in time is paired, one to one", () => {
    const { conversationID, threadID } = seed();
    threadRow(threadID, "msg_a", null, "user", "again", 0);
    threadRow(threadID, "msg_b", null, "user", "again", 8_000);
    channelRow("chm_a", null, "user", "device_a", "again", 5);
    channelRow("chm_b", null, "user", "device_a", "again", 8_005);
    const history = buildConversationHistory(db!, conversationID, 200);
    expect(history).toHaveLength(2);
    expect(history.map((message) => message.createdAt)).toEqual([at(5), at(8_005)]);
  });

  test("an unpaired thread row and an unpaired channel row both stay", () => {
    const { conversationID, threadID } = seed();
    threadRow(threadID, "msg_only_thread", null, "user", "thread only", 0);
    channelRow("chm_only_channel", null, "user", "device_a", "channel only", 100);
    const history = buildConversationHistory(db!, conversationID, 200);
    expect(history.map((message) => message.text)).toEqual(["thread only", "channel only"]);
  });
});

describe("rows from different turns are never one message", () => {
  test("identical text, both rows name a turn, the turns differ: two messages, even a few ms apart", () => {
    const { conversationID, threadID } = seed();
    createTurn(db!, { id: "trn_1", threadID, agentID: "ea" });
    createTurn(db!, { id: "trn_2", threadID, agentID: "ea" });
    threadRow(threadID, "msg_thread", "trn_1", "user", "same words", 0);
    channelRow("chm_channel", "trn_2", "user", "device_a", "same words", 4);
    const history = buildConversationHistory(db!, conversationID, 200);
    expect(history.map((message) => message.id).sort()).toEqual(["chm_channel", "msg_thread"]);
  });

  test("when one side has no turn id, the nearest in time still pairs them", () => {
    const { conversationID, threadID } = seed();
    createTurn(db!, { id: "trn_1", threadID, agentID: "ea" });
    threadRow(threadID, "msg_thread", "trn_1", "user", "same words", 0);
    channelRow("chm_channel", null, "user", "device_a", "same words", 4);
    expect(buildConversationHistory(db!, conversationID, 200)).toHaveLength(1);
  });
});
