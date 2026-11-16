import { afterEach, describe, expect, test } from "bun:test";
import { gatedFetch, startHarness, type Harness, type TestClient } from "./ws-harness";

/** conversation.history.ok says which turn is running in the conversation, so a reload can show Writing and Stop at once. */
let harness: Harness | undefined;
afterEach(async () => { await harness?.stop(); harness = undefined; });

async function skipOnboarding(client: TestClient): Promise<void> {
  client.send({ type: "agent.rename", agentId: "ea", name: "Agni" });
  await client.next("agent.updated");
}

describe("conversation.history.ok runningTurn", () => {
  test("names the running turn while one runs, and is absent once it ended", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    harness = await startHarness({ fetch: gatedFetch(gate, ["done"]) });
    const client = await harness.connect();
    await skipOnboarding(client);
    client.send({ type: "msg.send", channelId: "main", text: "work on this" });
    const started = await client.next("turn.start");
    const conversationID = String(started.conversationID);

    client.send({ type: "conversation.history", conversationID });
    const during = await client.next("conversation.history.ok");
    expect(during.runningTurn).toEqual({ turnID: started.turnID, threadID: started.threadID, agentID: "ea" });

    release();
    await client.next("turn.end", { match: (frame) => frame.turnID === started.turnID });
    client.send({ type: "conversation.history", conversationID });
    const after = await client.next("conversation.history.ok", { match: (frame) => frame.runningTurn === undefined });
    expect(after.runningTurn).toBeUndefined();
  });
});
