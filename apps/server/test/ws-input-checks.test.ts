import { afterEach, describe, expect, test } from "bun:test";
import { startHarness, type Harness, type TestClient } from "./ws-harness";

/**
 * Input checks at the socket: S1-27 (size cap), S1-39 (empty text, unknown
 * agents) and S1-30 (errors answer one connection and take no seq).
 */

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

async function twoClients(): Promise<{ sender: TestClient; watcher: TestClient }> {
  harness = await startHarness();
  const sender = await harness.connect({ device: "phone" });
  const watcher = await harness.connect({ device: "laptop" });
  sender.send({ type: "agent.rename", agentId: "ea", name: "Agni" });
  await sender.next("agent.updated");
  await watcher.next("agent.updated");
  sender.drain();
  watcher.drain();
  return { sender, watcher };
}

const count = (sql: string): number => harness!.db.query<{ n: number }, []>(sql).get()!.n;

describe("S1-27: message size cap", () => {
  test("a message over 100,000 characters is refused to the sender only and never stored", async () => {
    const { sender, watcher } = await twoClients();
    const before = count("SELECT count(*) AS n FROM channel_messages");
    sender.send({ type: "msg.send", channelId: "main", text: "x".repeat(100_001) });
    const error = await sender.next("error");
    expect(error.message).toContain("100,000");
    await Bun.sleep(150);
    expect(watcher.seen()).toEqual([]);
    expect(count("SELECT count(*) AS n FROM channel_messages")).toBe(before);
    expect(count("SELECT count(*) AS n FROM queued_messages")).toBe(0);
  });

  test("the cap counts every part of a batched message", async () => {
    const { sender } = await twoClients();
    sender.send({ type: "msg.send", channelId: "main", text: "first", texts: ["a".repeat(60_000), "b".repeat(60_000)] });
    expect((await sender.next("error")).message).toContain("100,000");
    expect(count("SELECT count(*) AS n FROM queued_messages")).toBe(0);
  });

  test("a message of exactly 100,000 characters is accepted", async () => {
    const { sender } = await twoClients();
    sender.send({ type: "msg.send", channelId: "main", text: "y".repeat(100_000) });
    await sender.next("turn.start", { timeoutMs: 5000 });
    expect(sender.seen().filter((frame) => frame.type === "error")).toEqual([]);
  });
});

describe("S1-39: empty text and unknown agents", () => {
  test("a batch of empty parts is refused instead of storing an empty message", async () => {
    const { sender, watcher } = await twoClients();
    const before = count("SELECT count(*) AS n FROM channel_messages");
    sender.send({ type: "msg.send", channelId: "main", text: "x", texts: [""] });
    expect((await sender.next("error")).code).toBe("bad_frame");
    await Bun.sleep(100);
    expect(watcher.seen().filter((frame) => frame.type === "msg.new" || frame.type === "turn.start")).toEqual([]);
    expect(count("SELECT count(*) AS n FROM channel_messages")).toBe(before);
  });

  test("a message to an unknown agent is refused and creates no conversation or room", async () => {
    const { sender } = await twoClients();
    sender.send({ type: "msg.send", toAgentId: "ghost", text: "hello?" });
    expect((await sender.next("error")).code).toBe("unknown_agent");
    await Bun.sleep(100);
    expect(count("SELECT count(*) AS n FROM conversations WHERE agent_id = 'ghost'")).toBe(0);
    expect(count("SELECT count(*) AS n FROM channels WHERE id = 'dm:ghost'")).toBe(0);
    expect(count("SELECT count(*) AS n FROM queued_messages")).toBe(0);
  });

  test("a direct message addressed by channel to an unknown agent is refused too", async () => {
    const { sender } = await twoClients();
    sender.send({ type: "msg.send", channelId: "dm:ghost", toAgentId: "ghost", text: "hello?" });
    expect((await sender.next("error")).code).toBe("unknown_agent");
    expect(count("SELECT count(*) AS n FROM conversations WHERE agent_id = 'ghost'")).toBe(0);
  });

  test("conversation.open for an unknown agent is refused and creates no conversation", async () => {
    const { sender } = await twoClients();
    sender.send({ type: "conversation.open", conversationID: "", agentID: "ghost2" });
    expect((await sender.next("error")).code).toBe("unknown_agent");
    expect(count("SELECT count(*) AS n FROM conversations WHERE agent_id = 'ghost2'")).toBe(0);
  });

  test("conversation.open for a real agent still works", async () => {
    const { sender } = await twoClients();
    sender.send({ type: "conversation.open", conversationID: "", agentID: "ea" });
    expect((await sender.next("conversation.ok")).agentID).toBe("ea");
  });
});

describe("S1-30: errors answer one connection and take no seq", () => {
  test("a capture that fails answers its sender only, and the error takes no seq of its own", async () => {
    const { sender, watcher } = await twoClients();
    // "remember:" with nothing after it is a capture command that cannot be carried out.
    sender.send({ type: "msg.send", channelId: "main", text: "remember:" });
    const started = await sender.next("turn.start");
    const error = await sender.next("error");
    const ended = await sender.next("turn.end");
    expect(error.code).toBe("capture_failed");
    // The error reuses the current seq; the next stream frame is the very next number.
    expect(error.seq).toBe(started.seq);
    expect(ended.seq).toBe(started.seq + 1);
    await Bun.sleep(100);
    expect(watcher.seen().filter((frame) => frame.type === "error")).toEqual([]);
  });
});
