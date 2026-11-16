import { afterEach, describe, expect, test } from "bun:test";
import { sseToolCall, startHarness, toolsThenText, type Harness, type TestClient } from "./ws-harness";

/**
 * W2-A item 3: a card replayed on reconnect offers the same buttons the
 * broker offered live. "Always" is never offered where `approvalTarget`
 * returns null (a command that runs code, run_privileged).
 */

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

async function skipOnboarding(client: TestClient): Promise<void> {
  client.send({ type: "agent.rename", agentId: "ea", name: "Agni" });
  await client.next("agent.updated");
}

/** A turn stopped at a bash approval card for `command`; returns what the live card offered. */
async function cardFor(command: string): Promise<{ live: string[]; requestID: string; turnID: string }> {
  harness = await startHarness({
    fetch: toolsThenText([() => sseToolCall("load_tools", { names: ["bash"] }), () => sseToolCall("bash", { command })], "stopped"),
  });
  const first = await harness.connect({ device: "phone" });
  await skipOnboarding(first);
  first.send({ type: "msg.send", channelId: "main", text: "do it" });
  const started = await first.next("turn.start");
  const card = await first.next("approval.request", { timeoutMs: 5000 });
  return { live: [...card.buttons], requestID: card.requestID, turnID: started.turnID };
}

describe("approval replay on reconnect offers the broker's buttons", () => {
  test("a command that cannot be remembered is replayed without Always", async () => {
    const { live, requestID, turnID } = await cardFor("git status");
    expect(live).toEqual(["once", "reject"]);

    const reconnected = await harness!.connect({ device: "laptop" });
    const replayed = await reconnected.next("approval.request", { match: (frame) => frame.requestID === requestID });
    expect(replayed.buttons).toEqual(["once", "reject"]);

    // Close the turn the supported way.
    reconnected.send({ type: "msg.cancel", turnID });
    await reconnected.next("turn.end", { timeoutMs: 5000 });
  });

  test("a command that can be remembered is replayed with Always, as it was offered", async () => {
    const { live, requestID, turnID } = await cardFor("rm -rf /tmp/agni-test-nothing");
    expect(live).toEqual(["once", "always", "reject"]);

    const reconnected = await harness!.connect({ device: "laptop" });
    const replayed = await reconnected.next("approval.request", { match: (frame) => frame.requestID === requestID });
    expect(replayed.buttons).toEqual(["once", "always", "reject"]);

    reconnected.send({ type: "msg.cancel", turnID });
    await reconnected.next("turn.end", { timeoutMs: 5000 });
  });
});
