import { afterEach, describe, expect, test } from "bun:test";
import { createThread } from "../src/stores/threads";
import { createForm } from "../src/stores/forms";
import { sseToolCall, startHarness, toolThenText, toolsThenText, waitFor, type Harness, type TestClient } from "./ws-harness";

/**
 * S1-05 (dispatch side): approval and question cards mean what they say. Only
 * cards whose turn is still running are replayed, an answer closes the card on
 * every device, and an answer to a card that is gone is an error, not silence.
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

/** A turn that stops at an approval card: a shell command the gate will not run unasked. */
async function turnWaitingOnApproval(): Promise<{ first: TestClient; second: TestClient; requestID: string; turnID: string; threadID: string }> {
  // bash is a deferred tool: it must be loaded before it can be called.
  harness = await startHarness({
    fetch: toolsThenText([() => sseToolCall("load_tools", { names: ["bash"] }), () => sseToolCall("bash", { command: "rm -rf /tmp/agni-test-nothing" })], "stopped"),
  });
  const first = await harness.connect({ device: "phone" });
  const second = await harness.connect({ device: "laptop" });
  await skipOnboarding(first);
  first.send({ type: "msg.send", channelId: "main", text: "clean up please" });
  const started = await first.next("turn.start");
  const approval = await first.next("approval.request", { timeoutMs: 5000 });
  await second.next("approval.request");
  return { first, second, requestID: approval.requestID, turnID: started.turnID, threadID: started.threadID };
}

function insertDeadApproval(): void {
  const deadThread = createThread(harness!.db, "ea", "dead");
  harness!.db.run(
    "INSERT INTO approvals (id, thread_id, turn_id, action, preview, status, created_at) VALUES ('apr_dead', ?, 'trn_dead', 'bash', 'echo', 'pending', ?)",
    [deadThread.id, new Date().toISOString()],
  );
}

describe("approval replay on hello", () => {
  test("replays the card of a running turn, and not a card whose turn is gone", async () => {
    const { requestID } = await turnWaitingOnApproval();
    insertDeadApproval();

    const third = await harness!.connect({ device: "tablet" });
    const replayed = await third.next("approval.request");
    expect(replayed.requestID).toBe(requestID);
    await Bun.sleep(150);
    expect(third.seen().filter((frame) => frame.type === "approval.request" && frame.requestID === "apr_dead")).toEqual([]);
  });
});

describe("answering an approval", () => {
  test("closes the card on every device", async () => {
    const { first, second, requestID } = await turnWaitingOnApproval();
    second.send({ type: "approve.reply", requestID, decision: "reject" });
    const onSecond = await second.next("approval.closed");
    const onFirst = await first.next("approval.closed");
    expect(onFirst).toMatchObject({ requestID, kind: "approval", reason: "decided" });
    expect(onSecond).toMatchObject({ requestID, kind: "approval", reason: "decided" });
  });

  test("a late answer to a card that is no longer pending gets an expired error on that connection only", async () => {
    const { first, second, requestID } = await turnWaitingOnApproval();
    first.send({ type: "approve.reply", requestID, decision: "reject" });
    await first.next("approval.closed");
    await first.next("turn.end", { timeoutMs: 5000 });
    first.drain();
    second.drain();

    second.send({ type: "approve.reply", requestID, decision: "once" });
    const error = await second.next("error");
    expect(error.message.toLowerCase()).toContain("expired");
    await Bun.sleep(100);
    expect(first.seen().filter((frame) => frame.type === "error")).toEqual([]);
    // The recorded decision is still the first one.
    expect(harness!.db.query("SELECT decision FROM approvals WHERE id = ?").get(requestID)).toEqual({ decision: "reject" });
  });

  test("an answer to a pending card whose turn is gone is an error, is not recorded, and closes the card as expired", async () => {
    const { first, second } = await turnWaitingOnApproval();
    insertDeadApproval();
    second.send({ type: "approve.reply", requestID: "apr_dead", decision: "once" });
    const error = await second.next("error");
    expect(error.message.toLowerCase()).toContain("expired");
    const closed = await first.next("approval.closed", { match: (frame) => frame.requestID === "apr_dead" });
    expect(closed).toMatchObject({ kind: "approval", reason: "expired" });
    expect(harness!.db.query("SELECT status, decision FROM approvals WHERE id = 'apr_dead'").get()).toEqual({ status: "expired", decision: null });
  });
});

describe("answering a question", () => {
  async function turnWaitingOnForm() {
    harness = await startHarness({ fetch: toolThenText(() => sseToolCall("ask", { question: "Which one?", options: ["Revenue", "Headcount"] }), "Chosen.") });
    const first = await harness.connect({ device: "phone" });
    const second = await harness.connect({ device: "laptop" });
    await skipOnboarding(first);
    first.send({ type: "msg.send", channelId: "main", text: "ask me something" });
    const form = await first.next("form.request", { timeoutMs: 5000 });
    await second.next("form.request");
    return { first, second, requestID: form.requestID };
  }

  test("closes the card on every device and a second answer is an expired error", async () => {
    const { first, second, requestID } = await turnWaitingOnForm();
    second.send({ type: "form.answer", requestID, answer: "Headcount" });
    expect(await first.next("approval.closed")).toMatchObject({ requestID, kind: "form", reason: "decided" });
    expect(await second.next("approval.closed")).toMatchObject({ requestID, kind: "form", reason: "decided" });
    await first.next("turn.end", { timeoutMs: 5000 });

    second.send({ type: "form.answer", requestID, answer: "Revenue" });
    const error = await second.next("error");
    expect(error.message.toLowerCase()).toContain("expired");
    expect(harness!.db.query("SELECT answer FROM forms WHERE id = ?").get(requestID)).toEqual({ answer: "Headcount" });
  });

  test("an answer to a pending question whose turn is gone is an error and is not recorded", async () => {
    const { first, second } = await turnWaitingOnForm();
    const deadThread = createThread(harness!.db, "ea", "dead");
    const dead = createForm(harness!.db, { threadID: deadThread.id, turnID: "trn_dead", kind: "choice", question: "Old?", options: ["a"] });
    second.send({ type: "form.answer", requestID: dead.id, answer: "a" });
    const error = await second.next("error");
    expect(error.message.toLowerCase()).toContain("expired");
    expect(await first.next("approval.closed", { match: (frame) => frame.requestID === dead.id })).toMatchObject({ kind: "form", reason: "expired" });
    await waitFor(() => harness!.db.query<{ status: string }, [string]>("SELECT status FROM forms WHERE id = ?").get(dead.id)?.status === "expired", 1000, "form expiry");
    expect(harness!.db.query("SELECT answer FROM forms WHERE id = ?").get(dead.id)).toEqual({ answer: null });
  });
});

describe("a dead card is not revived by a newer turn on the same thread", () => {
  test("an approval from an earlier turn is refused while a later turn runs in its thread", async () => {
    const { first, second, threadID, requestID } = await turnWaitingOnApproval();
    // Turn A's card, left pending when A was cancelled; turn B (the live one) now owns the thread.
    harness!.db.run(
      "INSERT INTO approvals (id, thread_id, turn_id, action, preview, status, created_at) VALUES ('apr_old', ?, 'trn_cancelled', 'bash', 'echo', 'pending', ?)",
      [threadID, new Date().toISOString()],
    );
    const third = await harness!.connect({ device: "tablet" });
    await third.next("approval.request", { match: (frame) => frame.requestID === requestID });
    await Bun.sleep(150);
    expect(third.seen().filter((frame) => frame.type === "approval.request" && frame.requestID === "apr_old")).toEqual([]);

    second.send({ type: "approve.reply", requestID: "apr_old", decision: "once" });
    expect((await second.next("error")).message.toLowerCase()).toContain("expired");
    expect(await first.next("approval.closed", { match: (frame) => frame.requestID === "apr_old" })).toMatchObject({ reason: "expired" });
    expect(harness!.db.query("SELECT status, decision FROM approvals WHERE id = 'apr_old'").get()).toEqual({ status: "expired", decision: null });
    // The live card still works.
    first.send({ type: "approve.reply", requestID, decision: "reject" });
    expect(await first.next("approval.closed", { match: (frame) => frame.requestID === requestID })).toMatchObject({ reason: "decided" });
  });

  test("a question from an earlier turn is refused while a later turn runs in its thread", async () => {
    harness = await startHarness({ fetch: toolThenText(() => sseToolCall("ask", { question: "Which one?", options: ["a", "b"] }), "ok") });
    const first = await harness.connect({ device: "phone" });
    await skipOnboarding(first);
    first.send({ type: "msg.send", channelId: "main", text: "ask me something" });
    const started = await first.next("turn.start");
    const live = await first.next("form.request", { timeoutMs: 5000 });
    const old = createForm(harness.db, { threadID: started.threadID, turnID: "trn_cancelled", kind: "choice", question: "Old?", options: ["a"] });
    first.send({ type: "form.answer", requestID: old.id, answer: "a" });
    expect((await first.next("error")).message.toLowerCase()).toContain("expired");
    expect(harness.db.query("SELECT status, answer FROM forms WHERE id = ?").get(old.id)).toEqual({ status: "expired", answer: null });
    first.send({ type: "form.answer", requestID: live.requestID, answer: "b" });
    expect(await first.next("approval.closed", { match: (frame) => frame.requestID === live.requestID })).toMatchObject({ reason: "decided" });
  });
});
