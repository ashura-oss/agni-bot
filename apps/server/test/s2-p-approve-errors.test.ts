/**
 * Sprint 2, fix round P (items 1 and 2): an approve.reply that is refused names its card.
 *
 * 1. A card whose full text came back `cut: true` was allowed once the text was "opened", though the owner read only the first part of it.
 *    The server now refuses an allow to such a card (`approval_text_cut`); Deny still works.
 * 2. Every error that answers an approve.reply carries the card's `requestID`, so a client with several cards waiting knows which one the
 *    refusal is about (`unknown_request` did not say, and the frame carried nothing but a code and a text).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { FULL_TEXT_MAX_CHARS } from "../src/ws/approval-full";
import { noopAuditSink, setAuditSink } from "../src/policy/audit-sink";
import { sseToolCall, startHarness, toolsThenText, type Harness, type TestClient } from "./ws-harness";

let harness: Harness | undefined;
afterEach(async () => {
  setAuditSink(noopAuditSink);
  await harness?.stop();
  harness = undefined;
});

async function cardFor(command: string): Promise<{ first: TestClient; requestID: string }> {
  harness = await startHarness({
    fetch: toolsThenText([() => sseToolCall("load_tools", { names: ["bash"] }), () => sseToolCall("bash", { command })], "stopped"),
  });
  const first = await harness.connect({ device: "phone" });
  first.send({ type: "agent.rename", agentId: "ea", name: "Agni" });
  await first.next("agent.updated");
  first.send({ type: "msg.send", channelId: "main", text: "clean up please" });
  const approval = await first.next("approval.request", { timeoutMs: 15000 });
  return { first, requestID: approval.requestID };
}

const LONG = `rm -rf /tmp/agni-test-nothing # ${"x".repeat(2_500)}`;
const HUGE = `rm -rf /tmp/agni-test-nothing # ${"y".repeat(FULL_TEXT_MAX_CHARS + 500)}`;

/**
 * A card whose full text comes back cut. A call too big for a card is never drawn (`CardNotShown`, 20,000 characters), so a card gets here
 * when its preview is clipped and the stored call behind it is larger than the full-text limit. The harness cannot make a model send that
 * through a card, so the rows are edited to the state such a card would have: a cut preview and a stored call over the limit.
 */
async function cutCard(): Promise<{ first: TestClient; requestID: string }> {
  const card = await cardFor(LONG);
  harness!.db.run("UPDATE approvals SET preview = preview || char(10) || 'Arguments given: (clipped)' WHERE id = ?", [card.requestID]);
  harness!.db.run("UPDATE tool_calls SET args = ? WHERE tool_name = 'bash'", [JSON.stringify({ command: HUGE })]);
  return card;
}
const statusOf = (requestID: string): string | undefined => harness!.db.query<{ status: string }, [string]>("SELECT status FROM approvals WHERE id = ?").get(requestID)?.status;

describe("a card whose full text was cut", () => {
  test("is refused an allow even after the full text was answered, and keeps waiting", async () => {
    const { first, requestID } = await cutCard();
    first.send({ type: "approval.full", requestID });
    const full = await first.next("approval.full.ok", { timeoutMs: 15000 });
    expect(full.cut, "the full text was not cut; the test is out of step").toBe(true);
    for (const decision of ["once", "always"] as const) {
      first.send({ type: "approve.reply", requestID, decision });
      const error = await first.next("error");
      expect({ decision, code: error.code, requestID: error.requestID }).toEqual({ decision, code: "approval_text_cut", requestID });
      expect(error.message).toMatch(/cut|whole|all of it/i);
      expect({ decision, status: statusOf(requestID) }).toEqual({ decision, status: "pending" });
    }
  }, 60000);

  test("can still be denied", async () => {
    const { first, requestID } = await cutCard();
    first.send({ type: "approval.full", requestID });
    await first.next("approval.full.ok", { timeoutMs: 15000 });
    first.send({ type: "approve.reply", requestID, decision: "reject" });
    expect(await first.next("approval.closed")).toMatchObject({ requestID, reason: "decided" });
  }, 60000);

  test("a long card that was not cut is allowed once opened, as before", async () => {
    const { first, requestID } = await cardFor(LONG);
    first.send({ type: "approval.full", requestID });
    expect((await first.next("approval.full.ok")).cut).toBeUndefined();
    first.send({ type: "approve.reply", requestID, decision: "once" });
    expect(await first.next("approval.closed")).toMatchObject({ requestID, reason: "decided" });
  });
});

describe("errors that answer approve.reply carry the card", () => {
  test("approval_not_opened", async () => {
    const { first, requestID } = await cardFor(LONG);
    first.send({ type: "approve.reply", requestID, decision: "once" });
    const error = await first.next("error");
    expect(error).toMatchObject({ code: "approval_not_opened", requestID });
  });

  test("unknown_request for an id nobody raised", async () => {
    harness = await startHarness();
    const client = await harness.connect({ device: "phone" });
    client.send({ type: "approve.reply", requestID: "apr_nobody", decision: "once" });
    expect(await client.next("error")).toMatchObject({ code: "unknown_request", requestID: "apr_nobody" });
  });

  test("unknown_request for a card that was already answered", async () => {
    const { first, requestID } = await cardFor("rm -rf /tmp/agni-test-nothing");
    first.send({ type: "approve.reply", requestID, decision: "reject" });
    await first.next("approval.closed");
    first.send({ type: "approve.reply", requestID, decision: "once" });
    expect(await first.next("error")).toMatchObject({ code: "unknown_request", requestID });
  });

  test("internal when the audit log is down", async () => {
    const { first, requestID } = await cardFor("rm -rf /tmp/agni-test-nothing");
    setAuditSink({ record() { throw new Error("audit store down"); } });
    first.send({ type: "approve.reply", requestID, decision: "once" });
    expect(await first.next("error")).toMatchObject({ code: "internal", requestID });
    expect(statusOf(requestID)).toBe("pending");
  });
});
