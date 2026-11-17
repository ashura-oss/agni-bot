/**
 * Sprint 2, fix round L (D): a card marked `truncated` cannot be allowed until its full text was opened.
 *
 * The card is marked when its preview hides part of the call, or is too long to take in at a glance. The owner is meant to open the text
 * (`approval.full`) before Allow (the web app's lock comes with S2-6), but the server took any `approve.reply`, so a client that skipped
 * it, or a script, could allow a call nobody had read. The server now records, per request, when `approval.full` was answered, and refuses an allowing `approve.reply`
 * to a truncated card that was never opened: a clear error, the card still waiting. Deny always works.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { loadCardMeta } from "../src/agent/pending-cards";
import { sseToolCall, startHarness, toolsThenText, type Harness, type TestClient } from "./ws-harness";

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

/** A turn stopped at a card for this shell command, with two devices connected. */
async function cardFor(command: string): Promise<{ first: TestClient; second: TestClient; requestID: string; truncated: boolean | undefined }> {
  harness = await startHarness({
    fetch: toolsThenText([() => sseToolCall("load_tools", { names: ["bash"] }), () => sseToolCall("bash", { command })], "stopped"),
  });
  const first = await harness.connect({ device: "phone" });
  const second = await harness.connect({ device: "laptop" });
  first.send({ type: "agent.rename", agentId: "ea", name: "Agni" });
  await first.next("agent.updated");
  first.send({ type: "msg.send", channelId: "main", text: "clean up please" });
  const approval = await first.next("approval.request", { timeoutMs: 5000 });
  await second.next("approval.request");
  return { first, second, requestID: approval.requestID, truncated: approval.truncated };
}

const LONG = `rm -rf /tmp/agni-test-nothing # ${"x".repeat(2_500)}`;
const SHORT = "rm -rf /tmp/agni-test-nothing";
const statusOf = (requestID: string): string | undefined => harness!.db.query<{ status: string }, [string]>("SELECT status FROM approvals WHERE id = ?").get(requestID)?.status;

describe("a truncated card", () => {
  test("is refused an allow that came before its full text was opened, and keeps waiting", async () => {
    const { first, requestID, truncated } = await cardFor(LONG);
    expect(truncated, "the card was not marked truncated; the test is out of step").toBe(true);
    for (const decision of ["once", "always"] as const) {
      first.send({ type: "approve.reply", requestID, decision });
      const error = await first.next("error");
      expect({ decision, code: error.code }).toEqual({ decision, code: "approval_not_opened" });
      expect(error.message).toMatch(/full text/i);
      expect({ decision, status: statusOf(requestID) }).toEqual({ decision, status: "pending" });
    }
    expect(first.seen().filter((frame) => frame.type === "approval.closed")).toEqual([]);
  });

  test("is allowed once its full text was opened", async () => {
    const { first, requestID } = await cardFor(LONG);
    first.send({ type: "approval.full", requestID });
    await first.next("approval.full.ok");
    first.send({ type: "approve.reply", requestID, decision: "once" });
    expect(await first.next("approval.closed")).toMatchObject({ requestID, reason: "decided" });
    expect(statusOf(requestID)).toBe("decided");
  });

  test("opened on one device may be allowed from another", async () => {
    const { first, second, requestID } = await cardFor(LONG);
    first.send({ type: "approval.full", requestID });
    await first.next("approval.full.ok");
    second.send({ type: "approve.reply", requestID, decision: "once" });
    expect(await second.next("approval.closed")).toMatchObject({ requestID, reason: "decided" });
  });

  test("can always be denied, opened or not", async () => {
    const { first, requestID } = await cardFor(LONG);
    first.send({ type: "approve.reply", requestID, decision: "reject" });
    expect(await first.next("approval.closed")).toMatchObject({ requestID, reason: "decided" });
  });

  test("whose saved flag cannot be read is judged from its own preview, so it is still locked", async () => {
    const { first, requestID } = await cardFor(LONG);
    harness!.db.run("UPDATE approvals SET card_meta = 'not json' WHERE id = ?", [requestID]);
    expect(loadCardMeta(harness!.db, requestID)).toBeNull();
    first.send({ type: "approve.reply", requestID, decision: "once" });
    expect((await first.next("error")).code).toBe("approval_not_opened");
  });
});

describe("a card that is not truncated", () => {
  test("is allowed at once, as before", async () => {
    const { first, requestID, truncated } = await cardFor(SHORT);
    expect(truncated).toBe(false);
    first.send({ type: "approve.reply", requestID, decision: "once" });
    expect(await first.next("approval.closed")).toMatchObject({ requestID, reason: "decided" });
  });
});
