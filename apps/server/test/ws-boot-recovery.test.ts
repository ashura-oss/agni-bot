import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase, writeMeta } from "../src/db";
import { ensureConversation } from "../src/stores/conversations";
import { createTurn, createThread } from "../src/stores/threads";
import { createForm } from "../src/stores/forms";
import { recoverInterruptedTurns } from "../src/ws/boot-recovery";
import { startHarness, type Harness } from "./ws-harness";

/**
 * S1-03 (server side): nothing may stay `running` across a restart. A turn the
 * dead process was running is finished with an error stop, the cards it was
 * waiting on expire, and the conversation says what happened.
 */

const NOTICE = "This reply was interrupted by a restart.";

let harness: Harness | undefined;
let db: Database | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
  db?.close();
  db = undefined;
});

interface Seeded { conversationID: string; threadID: string; turnID: string; approvalID: string; formID: string }

/** What a crashed process leaves behind: a running turn parked on an approval and a question. */
function seedCrashedTurn(database: Database, agentID = "ea"): Seeded {
  const conversation = ensureConversation(database, agentID);
  const thread = createThread(database, agentID, "work", { conversationID: conversation.id });
  database.run("UPDATE conversations SET active_thread_id = ? WHERE id = ?", [thread.id, conversation.id]);
  const turnID = `trn_${agentID}_dead`;
  createTurn(database, { id: turnID, threadID: thread.id, agentID });
  const now = new Date().toISOString();
  database.run(
    `INSERT INTO agent_sessions (thread_id, turn_id, state, message_log, step_count, token_count, max_steps, max_tokens, created_at, updated_at)
     VALUES (?, ?, 'awaiting_approval', '[]', 1, 10, 0, 0, ?, ?)`,
    [thread.id, turnID, now, now],
  );
  const approvalID = `apr_${agentID}_dead`;
  database.run(
    "INSERT INTO approvals (id, thread_id, turn_id, action, preview, status, created_at) VALUES (?, ?, ?, 'bash', 'rm x', 'pending', ?)",
    [approvalID, thread.id, turnID, now],
  );
  const form = createForm(database, { threadID: thread.id, turnID, kind: "choice", question: "Which?", options: ["a", "b"] });
  return { conversationID: conversation.id, threadID: thread.id, turnID, approvalID, formID: form.id };
}

describe("recoverInterruptedTurns", () => {
  test("fails the stale session, finishes its turn with an error, expires its cards, and says so in the chat", () => {
    db = openDatabase(":memory:");
    const seeded = seedCrashedTurn(db);
    const emitted: Array<Record<string, unknown>> = [];

    const result = recoverInterruptedTurns(db, (body) => { emitted.push(body as unknown as Record<string, unknown>); return undefined as never; });

    expect(result).toMatchObject({ sessions: 1, approvals: 1, forms: 1 });
    expect(db.query("SELECT state FROM agent_sessions WHERE thread_id = ?").get(seeded.threadID)).toEqual({ state: "failed" });
    const turn = db.query<{ state: string; stop_reason: string; ended_at: string | null }, [string]>(
      "SELECT state, stop_reason, ended_at FROM turns WHERE id = ?",
    ).get(seeded.turnID)!;
    expect(turn.state).toBe("done");
    expect(turn.stop_reason).toBe("error");
    expect(turn.ended_at).not.toBeNull();
    expect(db.query("SELECT status FROM approvals WHERE id = ?").get(seeded.approvalID)).toEqual({ status: "expired" });
    expect(db.query("SELECT status FROM forms WHERE id = ?").get(seeded.formID)).toEqual({ status: "expired" });

    const notices = db.query<{ text: string; from_type: string; channel_id: string }, []>(
      "SELECT text, from_type, channel_id FROM channel_messages WHERE from_type = 'system'",
    ).all();
    expect(notices).toEqual([{ text: NOTICE, from_type: "system", channel_id: "main" }]);
    expect(emitted.some((frame) => frame.type === "msg.new" && frame.text === NOTICE && frame.fromType === "system")).toBe(true);
  });

  test("a bot's conversation gets its notice in that bot's DM, once, however many blocks were running", () => {
    db = openDatabase(":memory:");
    db.run("INSERT INTO agents (id, name, created_at, updated_at) VALUES ('rex', 'Rex', ?, ?)", [new Date().toISOString(), new Date().toISOString()]);
    const seeded = seedCrashedTurn(db, "rex");
    const second = createThread(db, "rex", "older", { conversationID: seeded.conversationID });
    createTurn(db, { id: "trn_rex_second", threadID: second.id, agentID: "rex" });
    db.run(
      `INSERT INTO agent_sessions (thread_id, turn_id, state, message_log, step_count, token_count, max_steps, max_tokens, created_at, updated_at)
       VALUES (?, 'trn_rex_second', 'running', '[]', 0, 0, 0, 0, ?, ?)`,
      [second.id, new Date().toISOString(), new Date().toISOString()],
    );

    expect(recoverInterruptedTurns(db, () => undefined as never).sessions).toBe(2);
    const notices = db.query<{ channel_id: string }, []>("SELECT channel_id FROM channel_messages WHERE text = 'This reply was interrupted by a restart.'").all();
    expect(notices).toEqual([{ channel_id: "dm:rex" }]);
  });

  test("leaves finished sessions, answered cards, and parked delegated sessions alone", () => {
    db = openDatabase(":memory:");
    const conversation = ensureConversation(db, "ea");
    const thread = createThread(db, "ea", "x", { conversationID: conversation.id });
    const now = new Date().toISOString();
    createTurn(db, { id: "trn_done", threadID: thread.id, agentID: "ea" });
    db.run("UPDATE turns SET state = 'done', stop_reason = 'end', ended_at = ? WHERE id = 'trn_done'", [now]);
    db.run(
      `INSERT INTO agent_sessions (thread_id, turn_id, state, message_log, step_count, token_count, max_steps, max_tokens, created_at, updated_at)
       VALUES (?, 'trn_done', 'waiting', '[]', 0, 0, 0, 0, ?, ?)`,
      [thread.id, now, now],
    );
    db.run("INSERT INTO approvals (id, thread_id, turn_id, action, preview, status, decision, created_at) VALUES ('apr_old', ?, 'trn_done', 'bash', 'x', 'decided', 'once', ?)", [thread.id, now]);

    expect(recoverInterruptedTurns(db, () => undefined as never)).toMatchObject({ sessions: 0, approvals: 0, forms: 0 });
    expect(db.query("SELECT state FROM agent_sessions WHERE thread_id = ?").get(thread.id)).toEqual({ state: "waiting" });
    expect(db.query("SELECT stop_reason FROM turns WHERE id = 'trn_done'").get()).toEqual({ stop_reason: "end" });
    expect(db.query("SELECT status FROM approvals WHERE id = 'apr_old'").get()).toEqual({ status: "decided" });
    expect(db.query("SELECT count(*) AS n FROM channel_messages WHERE from_type = 'system'").get()).toEqual({ n: 0 });
  });
});

describe("server boot", () => {
  test("a server that boots over a crashed turn recovers it before serving, and the next message starts a fresh turn", async () => {
    db = openDatabase(":memory:");
    const seeded = seedCrashedTurn(db);
    harness = await startHarness({ db });
    db = undefined; // the harness owns it now

    expect(harness.db.query("SELECT state FROM agent_sessions WHERE thread_id = ?").get(seeded.threadID)).toEqual({ state: "failed" });
    expect(harness.db.query("SELECT stop_reason FROM turns WHERE id = ?").get(seeded.turnID)).toEqual({ stop_reason: "error" });

    const client = await harness.connect();
    client.send({ type: "agent.rename", agentId: "ea", name: "Agni" });
    await client.next("agent.updated");
    client.send({ type: "msg.send", conversationID: seeded.conversationID, text: "hello again" });
    const started = await client.next("turn.start");
    // Not the dead turn's ID: the new message is its own turn.
    expect(started.turnID).not.toBe(seeded.turnID);
    await client.next("turn.end", { match: (frame) => frame.turnID === started.turnID });
  });

  test("S1-31: a server that boots over a crashed counter resumes above every seq it could have sent", async () => {
    db = openDatabase(":memory:");
    // The previous process persisted 64 and then crashed after sending up to 95.
    writeMeta(db, "seq", "64");
    harness = await startHarness({ db });
    db = undefined;
    const client = await harness.connect();
    expect(client.maxSeq).toBeGreaterThan(95);
  });

  test("S1-31: a clean restart keeps the counter, so a caught-up client does not reload", async () => {
    const first = await startHarness();
    const before = await first.connect();
    before.send({ type: "agent.rename", agentId: "ea", name: "Agni" });
    await before.next("agent.updated");
    await Bun.sleep(100); // the follow-up onboarding message too: the client is fully caught up
    const caughtUp = before.maxSeq;
    before.close();
    await first.server.stop(); // a clean shutdown: the database stays, the process ends

    harness = await startHarness({ db: first.db });
    const after = await harness.connect({ resyncFrom: caughtUp });
    expect(after.maxSeq).toBeGreaterThan(caughtUp);
    expect(after.maxSeq).toBeLessThan(caughtUp + 16); // no +32 jump
    expect(after.seen().filter((frame) => frame.type === "error")).toEqual([]);
  });

  test("S1-31: a restart after a crash (no clean-shutdown marker) still skips ahead", async () => {
    const first = await startHarness();
    const before = await first.connect();
    before.send({ type: "agent.rename", agentId: "ea", name: "Agni" });
    await before.next("agent.updated");
    const caughtUp = before.maxSeq;
    before.close();
    await first.server.stop();
    // Simulate the crash: the marker a clean stop leaves is not there.
    first.db.run("DELETE FROM meta WHERE key = 'seq_clean'");

    harness = await startHarness({ db: first.db });
    const after = await harness.connect({ resyncFrom: caughtUp });
    expect(after.maxSeq).toBeGreaterThanOrEqual(caughtUp + 32);
  });
});
