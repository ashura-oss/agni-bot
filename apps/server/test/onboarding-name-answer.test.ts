import { afterEach, describe, expect, test } from "bun:test";
import { ensureConversation } from "../src/stores/conversations";
import { looksLikeNameAnswer } from "../src/ws/name-answer";
import { startHarness, type Harness } from "./ws-harness";

/**
 * W2-A item 9: while a new bot waits for its first name, the owner's next
 * message in #main was taken as the name and dropped (never echoed, gone on
 * reload). A name answer is now stored and echoed like any owner message, and
 * a message that is not a name (a question, a sentence) is not made the name.
 */

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

describe("looksLikeNameAnswer", () => {
  test("accepts short names", () => {
    for (const text of ["Agni", "Friday", "  Max  ", "Dr Watson", "Baahu Bot", "Jarvis 2"]) expect(looksLikeNameAnswer(text)).toBe(true);
  });

  test("rejects questions, sentences, long text and multi-line text", () => {
    for (const text of [
      "Can you help me with my taxes?",
      "what's the weather like today",
      "I would like to call you Agni please",
      "x".repeat(40),
      "Agni\nand then some",
      "",
      "   ",
    ]) expect(looksLikeNameAnswer(text)).toBe(false);
  });
});

describe("a message sent while the bot waits for its first name", () => {
  test("a name is echoed and stored as the owner's message, then applied", async () => {
    harness = await startHarness();
    const client = await harness.connect();
    await client.next("msg.new", { match: (frame) => frame.uiHint === "onboarding_name_prompt" });

    client.send({ type: "msg.send", channelId: "main", text: "Friday" });
    const echo = await client.next("msg.new", { match: (frame) => frame.fromType === "user" });
    expect(echo).toMatchObject({ channelId: "main", text: "Friday" });
    const updated = await client.next("agent.updated");
    expect(updated).toMatchObject({ agentId: "ea", displayName: "Friday", onboarded: true });

    // It survives a reload: the stored channel history still has the owner's line.
    expect(harness.db.query("SELECT text FROM channel_messages WHERE id = ?").get(echo.id)).toEqual({ text: "Friday" });
    client.send({ type: "conversation.history", conversationID: ensureConversation(harness.db, "ea").id, limit: 50 });
    const history = await client.next("conversation.history.ok");
    expect(history.messages.some((message) => message.role === "user" && message.text === "Friday")).toBe(true);
  });

  test("a question is not made the name: it is echoed, stored, and answered as a normal message", async () => {
    harness = await startHarness();
    const client = await harness.connect();
    await client.next("msg.new", { match: (frame) => frame.uiHint === "onboarding_name_prompt" });

    const question = "Can you help me plan my week?";
    client.send({ type: "msg.send", channelId: "main", text: question });
    const echo = await client.next("msg.new", { match: (frame) => frame.fromType === "user" });
    expect(echo.text).toBe(question);
    await client.next("turn.start", { timeoutMs: 5000 });
    await client.next("turn.end", { timeoutMs: 5000 });

    expect(harness.db.query("SELECT onboarded FROM agents WHERE id = 'ea'").get()).toEqual({ onboarded: 0 });
    expect(harness.db.query<{ display_name: string | null }, []>("SELECT display_name FROM agents WHERE id = 'ea'").get()?.display_name).not.toBe(question);
    expect(harness.db.query("SELECT text FROM channel_messages WHERE id = ?").get(echo.id)).toEqual({ text: question });
  });
});
