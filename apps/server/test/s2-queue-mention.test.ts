/**
 * Carried from Sprint 1: a queued message that starts with an @mention keeps
 * its routing when an earlier message is queued with it. Merging them used to
 * put the mention in the middle of the text, so the whole burst was answered by
 * whichever bot the second message's channel belonged to.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { gatedFetch, startHarness, type Harness, type TestClient } from "./ws-harness";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

async function setup(): Promise<{ client: TestClient; open: () => void; bodies: string[] }> {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const bodies: string[] = [];
  const gated = gatedFetch(gate, ["ok"]);
  const fetcher = (async (url: string, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ""));
    return gated(url, init);
  }) as unknown as typeof fetch;
  harness = await startHarness({ fetch: fetcher });
  const client = await harness.connect();
  client.send({ type: "agent.rename", agentId: "ea", name: "Agni" });
  await client.next("agent.updated");
  return { client, open, bodies };
}

describe("queued @mention routing", () => {
  test("a mention queued behind a plain message to the same bot is its own turn, answered by that bot", async () => {
    const { client, open } = await setup();
    // A turn with the researcher is running; the next two messages queue behind it.
    client.send({ type: "msg.send", channelId: "dm:researcher", toAgentId: "researcher", text: "start the long job" });
    const first = await client.next("turn.start");
    expect(first.agentID).toBe("researcher");
    client.send({ type: "msg.send", channelId: "dm:researcher", toAgentId: "researcher", text: "also check the second file" });
    client.send({ type: "msg.send", channelId: "main", text: "@researcher and summarise it for me" });
    await Bun.sleep(100);
    open();

    const secondStart = await client.next("turn.start", { timeoutMs: 8000 });
    expect(secondStart.agentID).toBe("researcher");
    await client.next("turn.end", { match: (frame) => frame.turnID === secondStart.turnID, timeoutMs: 8000 });
    const thirdStart = await client.next("turn.start", { timeoutMs: 8000 });
    // Before the fix the two were merged into one turn answered by the main assistant.
    expect(thirdStart.agentID).toBe("researcher");
    const messages = harness!.db.query<{ text: string; channel_id: string }, []>("SELECT text, channel_id FROM channel_messages WHERE from_type = 'user' ORDER BY created_at, rowid").all();
    const mention = messages.find((row) => row.text.includes("summarise it for me"));
    expect(mention?.channel_id).toBe("dm:researcher");
    expect(mention?.text).not.toContain("also check the second file");
  });

  test("plain messages queued together still merge into one turn", async () => {
    const { client, open } = await setup();
    client.send({ type: "msg.send", channelId: "dm:researcher", toAgentId: "researcher", text: "start the long job" });
    await client.next("turn.start");
    client.send({ type: "msg.send", channelId: "dm:researcher", toAgentId: "researcher", text: "one more thing" });
    client.send({ type: "msg.send", channelId: "dm:researcher", toAgentId: "researcher", text: "and another" });
    await Bun.sleep(100);
    open();
    await client.next("turn.start", { timeoutMs: 8000 });
    await client.next("turn.end", { timeoutMs: 8000 });
    await client.next("turn.end", { timeoutMs: 8000 });
    await Bun.sleep(300);
    expect(client.seen().filter((frame) => frame.type === "turn.start")).toHaveLength(0);
    const rows = harness!.db.query<{ text: string }, []>("SELECT text FROM channel_messages WHERE from_type = 'user' ORDER BY created_at, rowid").all();
    expect(rows.some((row) => row.text.includes("one more thing") && row.text.includes("and another"))).toBe(true);
  });
});
