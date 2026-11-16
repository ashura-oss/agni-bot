import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sseToolCall, startHarness, toolsThenText, type Harness, type TestClient } from "./ws-harness";

/**
 * W2-A item 3: a card replayed on reconnect offers the same buttons the
 * broker offered live. "Always" is never offered where `approvalTarget`
 * returns null: any shell command, run_privileged, a write outside scratch.
 * A rememberable call (overwriting a file inside scratch) keeps "always".
 */

let harness: Harness | undefined;
let scratch: string;
let savedScratch: string | undefined;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "agni-replay-"));
  savedScratch = process.env.AGNI_SCRATCH_DIR;
  process.env.AGNI_SCRATCH_DIR = scratch;
});

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
  if (savedScratch === undefined) delete process.env.AGNI_SCRATCH_DIR;
  else process.env.AGNI_SCRATCH_DIR = savedScratch;
  rmSync(scratch, { recursive: true, force: true });
});

async function skipOnboarding(client: TestClient): Promise<void> {
  client.send({ type: "agent.rename", agentId: "ea", name: "Agni" });
  await client.next("agent.updated");
}

/** A turn stopped at an approval card for one call of `tool`; returns what the live card offered. */
async function cardFor(tool: string, args: Record<string, unknown>): Promise<{ live: string[]; requestID: string; turnID: string }> {
  // bash and write_file are deferred tools: they must be loaded before they can be called.
  harness = await startHarness({
    fetch: toolsThenText([() => sseToolCall("load_tools", { names: [tool] }), () => sseToolCall(tool, args)], "stopped"),
  });
  const first = await harness.connect({ device: "phone" });
  await skipOnboarding(first);
  first.send({ type: "msg.send", channelId: "main", text: "do it" });
  const started = await first.next("turn.start");
  const card = await first.next("approval.request", { timeoutMs: 5000 });
  return { live: [...card.buttons], requestID: card.requestID, turnID: started.turnID };
}

describe("approval replay on reconnect offers the broker's buttons", () => {
  test("a command that runs code is replayed without Always", async () => {
    const { live, requestID, turnID } = await cardFor("bash", { command: "git status" });
    expect(live).toEqual(["once", "reject"]);

    const reconnected = await harness!.connect({ device: "laptop" });
    const replayed = await reconnected.next("approval.request", { match: (frame) => frame.requestID === requestID });
    expect(replayed.buttons).toEqual(["once", "reject"]);

    // Close the turn the supported way.
    reconnected.send({ type: "msg.cancel", turnID });
    await reconnected.next("turn.end", { timeoutMs: 5000 });
  });

  test("no shell command is ever remembered, so even a plain one is replayed without Always", async () => {
    const { live, requestID, turnID } = await cardFor("bash", { command: "rm -rf /tmp/agni-test-nothing" });
    expect(live).toEqual(["once", "reject"]);

    const reconnected = await harness!.connect({ device: "laptop" });
    const replayed = await reconnected.next("approval.request", { match: (frame) => frame.requestID === requestID });
    expect(replayed.buttons).toEqual(["once", "reject"]);

    reconnected.send({ type: "msg.cancel", turnID });
    await reconnected.next("turn.end", { timeoutMs: 5000 });
  });

  test("overwriting a file inside scratch can be remembered and is replayed with Always, as it was offered", async () => {
    const file = join(scratch, "notes.md");
    writeFileSync(file, "old");
    const { live, requestID, turnID } = await cardFor("write_file", { path: file, content: "new" });
    expect(live).toEqual(["once", "always", "reject"]);

    const reconnected = await harness!.connect({ device: "laptop" });
    const replayed = await reconnected.next("approval.request", { match: (frame) => frame.requestID === requestID });
    expect(replayed.buttons).toEqual(["once", "always", "reject"]);

    reconnected.send({ type: "msg.cancel", turnID });
    await reconnected.next("turn.end", { timeoutMs: 5000 });
  });

  test("a write outside scratch has no target and is replayed without Always", async () => {
    const outside = join(tmpdir(), `agni-outside-${Date.now()}.txt`);
    const { live, requestID, turnID } = await cardFor("write_file", { path: outside, content: "x" });
    expect(live).toEqual(["once", "reject"]);

    const reconnected = await harness!.connect({ device: "laptop" });
    const replayed = await reconnected.next("approval.request", { match: (frame) => frame.requestID === requestID });
    expect(replayed.buttons).toEqual(["once", "reject"]);

    reconnected.send({ type: "msg.cancel", turnID });
    await reconnected.next("turn.end", { timeoutMs: 5000 });
  });
});
