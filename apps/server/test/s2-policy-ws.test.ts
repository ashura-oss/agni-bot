/**
 * S2-12 / S2-13 / S2-08 over a real socket: pause-all, per-bot off, held
 * messages, spend frames, the full text behind a card, and the audit trail of
 * what the owner decides.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { bindPauseStore, unbindPauseStore } from "../src/policy/pause";
import { setAuditSink } from "../src/policy/audit-sink";
import { installAuditSink, listAuditEvents, verifyAuditChain } from "../src/stores/audit";
import { saveCardMeta } from "../src/agent/pending-cards";
import { setSpendProvider } from "../src/ws/policy-frames";
import { gatedFetch, sseResponse, sseToolCall, startHarness, toolsThenText, waitFor, type Harness, type TestClient } from "./ws-harness";

let harness: Harness | undefined;

beforeEach(() => {
  setSpendProvider(null);
});

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
  unbindPauseStore();
  setSpendProvider(null);
  setAuditSink({ record() {} });
});

async function start(options: Parameters<typeof startHarness>[0] = {}): Promise<{ client: TestClient; h: Harness }> {
  const h = await startHarness(options);
  harness = h;
  installAuditSink(h.db);
  bindPauseStore(h.db);
  const client = await h.connect();
  // Skip the first-run name prompt so a plain message is a message.
  client.send({ type: "agent.rename", agentId: "ea", name: "Agni" });
  await client.next("agent.updated");
  return { client, h };
}

describe("policy.pause", () => {
  test("pausing answers everyone with the state, stores it, and audits it", async () => {
    const { client, h } = await start();
    client.send({ type: "policy.pause", paused: true });
    const ok = await client.next("policy.pause.ok");
    expect(ok.paused).toBe(true);
    expect(ok.stopped).toBe(0);
    expect(ok.bots.find((bot) => bot.agentID === "ea")).toMatchObject({ enabled: true });
    expect(h.db.query("SELECT paused FROM pause_state").get()).toEqual({ paused: 1 });
    expect(listAuditEvents(h.db, { kind: "pause.set" })[0]).toMatchObject({ detail: { paused: true } });
    expect(verifyAuditChain(h.db).ok).toBe(true);
  });

  test("a frame with no fields only reads the state", async () => {
    const { client, h } = await start();
    client.send({ type: "policy.pause" });
    expect((await client.next("policy.pause.ok")).paused).toBe(false);
    expect(listAuditEvents(h.db, { kind: "pause.set" })).toHaveLength(0);
  });

  test("a running turn is stopped, gets a notice in its channel, and the count says how many", async () => {
    const gate = new Promise<void>(() => undefined); // never opens: the turn is mid-model-call
    const { client } = await start({ fetch: gatedFetch(gate) });
    client.send({ type: "msg.send", channelId: "main", text: "think for a long time" });
    await client.next("turn.start");
    client.send({ type: "policy.pause", paused: true });
    const ok = await client.next("policy.pause.ok");
    expect(ok.stopped).toBe(1);
    const end = await client.next("turn.end", { timeoutMs: 5000 });
    expect(end.stopReason).toBe("cancelled");
    const notice = await client.next("status.update", { match: (frame) => frame.text.startsWith("Stopped: you paused all bots") });
    expect(notice).toMatchObject({ channelId: "main", agentId: "ea", transient: false });
    expect(notice.text).toContain("Work done so far is kept.");
  });

  test("a message sent while paused waits, says so, and is answered after resume, in order", async () => {
    // What the model was asked: the last user message of each call.
    const seenPrompts: string[] = [];
    const fetcher = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ role: string; content: string }> };
      seenPrompts.push([...(body.messages ?? [])].reverse().find((message) => message.role === "user")?.content ?? "");
      return sseResponse("done");
    }) as unknown as typeof fetch;
    const { client, h } = await start({ fetch: fetcher });
    client.send({ type: "policy.pause", paused: true });
    await client.next("policy.pause.ok");

    client.send({ type: "msg.send", channelId: "main", text: "first question" });
    client.send({ type: "msg.send", channelId: "main", text: "second question" });
    const waiting = await client.next("status.update", { match: (frame) => frame.text.startsWith("Waiting: bots are paused") });
    expect(waiting.transient).toBe(true);
    await Bun.sleep(150);
    expect(seenPrompts).toHaveLength(0);
    expect(client.seen().some((frame) => frame.type === "turn.start")).toBe(false);
    // The owner's words are on disk, so a restart while paused does not lose them.
    expect(h.db.query<{ n: number }, []>("SELECT count(*) AS n FROM queued_messages").get()!.n).toBe(2);

    client.send({ type: "policy.pause", paused: false });
    expect((await client.next("policy.pause.ok")).paused).toBe(false);
    await client.next("turn.start");
    await waitFor(() => seenPrompts.length >= 2, 8000, "both held messages to run");
    expect(seenPrompts[0]).toContain("first question");
    expect(seenPrompts[1]).toContain("second question");
  });

  test("a client that connects while paused is told the state without asking", async () => {
    const { client, h } = await start();
    client.send({ type: "policy.pause", paused: true });
    await client.next("policy.pause.ok");
    const other = await h.connect({ device: "laptop" });
    expect((await other.next("policy.pause.ok")).paused).toBe(true);
  });

  test("resuming does not turn on a bot that was off", async () => {
    const { client, h } = await start();
    client.send({ type: "agent.enabled.set", agentID: "researcher", enabled: false });
    await client.next("policy.pause.ok");
    client.send({ type: "policy.pause", paused: true });
    await client.next("policy.pause.ok");
    client.send({ type: "policy.pause", paused: false });
    const ok = await client.next("policy.pause.ok");
    expect(ok.bots.find((bot) => bot.agentID === "researcher")).toMatchObject({ enabled: false });
    expect(h.db.query("SELECT disabled FROM agents WHERE id = 'researcher'").get()).toEqual({ disabled: 1 });
  });
});

describe("agent.enabled.set", () => {
  test("turning a bot off answers with the state and a roster that says so, and audits it", async () => {
    const { client, h } = await start();
    client.send({ type: "agent.enabled.set", agentID: "researcher", enabled: false });
    const ok = await client.next("policy.pause.ok");
    expect(ok.paused).toBe(false);
    expect(ok.bots.find((bot) => bot.agentID === "researcher")).toMatchObject({ enabled: false });
    const roster = await client.next("agents.update");
    expect(roster.mentions?.find((agent) => agent.id === "researcher")?.enabled).toBe(false);
    expect(roster.agents.find((agent) => agent.id === "ea")?.enabled).toBeUndefined();
    expect(listAuditEvents(h.db, { kind: "agent.enabled" })[0]).toMatchObject({ detail: { agentID: "researcher", enabled: false } });
  });

  test("an unknown bot is an error and changes nothing", async () => {
    const { client, h } = await start();
    client.send({ type: "agent.enabled.set", agentID: "nobody", enabled: false });
    expect((await client.next("error")).code).toBe("unknown_agent");
    expect(listAuditEvents(h.db, { kind: "agent.enabled" })).toHaveLength(0);
  });

  test("a message to a bot that is off is refused and not stored; turning it on lets messages through", async () => {
    const { client, h } = await start();
    client.send({ type: "agent.enabled.set", agentID: "researcher", enabled: false });
    await client.next("policy.pause.ok");
    client.send({ type: "msg.send", text: "hello there", toAgentId: "researcher", channelId: "dm:researcher" });
    const error = await client.next("error");
    expect(error.code).toBe("agent_off");
    expect(error.message).toContain("is off");
    await Bun.sleep(100);
    expect(h.db.query<{ n: number }, []>("SELECT count(*) AS n FROM queued_messages").get()!.n).toBe(0);
    expect(client.seen().some((frame) => frame.type === "turn.start")).toBe(false);

    client.send({ type: "agent.enabled.set", agentID: "researcher", enabled: true });
    await client.next("policy.pause.ok");
    client.send({ type: "msg.send", text: "hello again", toAgentId: "researcher", channelId: "dm:researcher" });
    const began = await client.next("turn.start");
    expect(began.agentID).toBe("researcher");
  });

  test("turning a bot off stops its running turn and no one else's", async () => {
    const gate = new Promise<void>(() => undefined);
    const { client } = await start({ fetch: gatedFetch(gate) });
    client.send({ type: "msg.send", channelId: "main", text: "think for a long time" });
    await client.next("turn.start");
    client.send({ type: "agent.enabled.set", agentID: "researcher", enabled: false });
    expect((await client.next("policy.pause.ok")).stopped).toBe(0);
    await Bun.sleep(100);
    expect(client.seen().some((frame) => frame.type === "turn.end")).toBe(false);
    client.send({ type: "agent.enabled.set", agentID: "ea", enabled: false });
    const ok = await client.next("policy.pause.ok", { match: (frame) => frame.stopped > 0 });
    expect(ok.stopped).toBe(1);
    expect((await client.next("turn.end", { timeoutMs: 5000 })).stopReason).toBe("cancelled");
    const notice = await client.next("status.update", { match: (frame) => frame.text.startsWith("Stopped: you turned") });
    expect(notice.text).toContain("off. Work done so far is kept.");
  });

  test("policy.pause with an agentID is the same switch", async () => {
    const { client, h } = await start();
    client.send({ type: "policy.pause", paused: true, agentID: "researcher" });
    const ok = await client.next("policy.pause.ok");
    expect(ok.paused).toBe(false);
    expect(ok.bots.find((bot) => bot.agentID === "researcher")?.enabled).toBe(false);
    expect(h.db.query("SELECT disabled FROM agents WHERE id = 'researcher'").get()).toEqual({ disabled: 1 });
  });

  test("a failing audit log stops a turn-on and leaves the bot off", async () => {
    const { client, h } = await start();
    client.send({ type: "agent.enabled.set", agentID: "researcher", enabled: false });
    await client.next("policy.pause.ok");
    setAuditSink({ record() { throw new Error("audit down"); } });
    client.send({ type: "agent.enabled.set", agentID: "researcher", enabled: true });
    expect((await client.next("error")).code).toBe("internal");
    expect(h.db.query("SELECT disabled FROM agents WHERE id = 'researcher'").get()).toEqual({ disabled: 1 });
  });
});

describe("spend frames", () => {
  const status = {
    day: "2026-11-16", resetsAt: "2026-11-17T00:00:00.000Z", timeZone: "UTC",
    caps: { dayUsd: 2, perBotDayUsd: 1, perJobUsd: 0.5 }, daySpentUsd: 0.42,
    bots: [{ agentID: "ea", spentUsd: 0.42, capUsd: 1 }], unpricedCalls: 0,
  };

  test("with no ledger in the build both frames say so", async () => {
    const { client } = await start();
    client.send({ type: "spend.status" });
    expect((await client.next("error")).code).toBe("spend_unavailable");
    client.send({ type: "spend.caps.set", dayUsd: 3 });
    expect((await client.next("error")).code).toBe("spend_unavailable");
  });

  test("spend.status answers the requester with today's numbers", async () => {
    const { client } = await start();
    setSpendProvider({ status: () => status, setCaps: (_db, caps) => ({ ...status.caps, ...caps }) });
    client.send({ type: "spend.status" });
    expect(await client.next("spend.status.ok")).toMatchObject({ day: "2026-11-16", daySpentUsd: 0.42, caps: { dayUsd: 2 } });
  });

  test("spend.caps.set records the old and new caps first, applies them, and tells everyone", async () => {
    const { client, h } = await start();
    let caps: { dayUsd: number | null; perBotDayUsd: number | null; perJobUsd: number | null } = { ...status.caps };
    setSpendProvider({ status: () => ({ ...status, caps }), setCaps: (_db, change) => (caps = { ...caps, ...change }) });
    client.send({ type: "spend.caps.set", dayUsd: 5 });
    expect((await client.next("spend.status.ok")).caps.dayUsd).toBe(5);
    expect(listAuditEvents(h.db, { kind: "spend.caps.set" })[0]!.detail).toMatchObject({ before: { dayUsd: 2 }, after: { dayUsd: 5 } });
  });

  test("a bot's cap above the daily cap is refused as bad_cap and nothing is recorded", async () => {
    const { client, h } = await start();
    let applied = false;
    setSpendProvider({ status: () => status, setCaps: () => { applied = true; return status.caps; } });
    client.send({ type: "spend.caps.set", perBotDayUsd: 9 });
    const error = await client.next("error");
    expect(error.code).toBe("bad_cap");
    expect(error.message).toContain("cannot be more than the daily limit");
    expect(applied).toBe(false);
    expect(listAuditEvents(h.db, { kind: "spend.caps.set" })).toHaveLength(0);
  });

  test("a failing audit log stops a change to the caps", async () => {
    const { client } = await start();
    let applied = false;
    setSpendProvider({ status: () => status, setCaps: () => { applied = true; return status.caps; } });
    setAuditSink({ record() { throw new Error("audit down"); } });
    client.send({ type: "spend.caps.set", dayUsd: 5 });
    expect((await client.next("error")).code).toBe("internal");
    expect(applied).toBe(false);
  });
});

/** A turn that stops at an approval card: a shell command the gate will not run unasked. */
async function turnWaitingOnApproval(): Promise<{ client: TestClient; h: Harness; requestID: string; turnID: string }> {
  const fetcher = toolsThenText([() => sseToolCall("load_tools", { names: ["bash"] }), () => sseToolCall("bash", { command: "rm -rf /tmp/agni-test-nothing && echo ​done" })], "stopped");
  const { client, h } = await start({ fetch: fetcher });
  client.send({ type: "msg.send", channelId: "main", text: "clean up please" });
  const started = await client.next("turn.start");
  const approval = await client.next("approval.request", { timeoutMs: 5000 });
  return { client, h, requestID: approval.requestID, turnID: started.turnID };
}

describe("approvals", () => {
  test("an answer is on the audit record before it takes effect", async () => {
    const { client, h, requestID } = await turnWaitingOnApproval();
    client.send({ type: "approve.reply", requestID, decision: "reject" });
    await client.next("approval.closed");
    const event = listAuditEvents(h.db, { kind: "approval.decided" })[0]!;
    expect(event).toMatchObject({ detail: { requestID, decision: "reject", toolName: "bash" } });
    expect(event.actor).toBeTruthy();
    expect(verifyAuditChain(h.db).ok).toBe(true);
  });

  test("a failing audit log leaves the card waiting instead of letting an unrecorded answer through", async () => {
    const { client, h, requestID } = await turnWaitingOnApproval();
    setAuditSink({ record() { throw new Error("audit down"); } });
    client.send({ type: "approve.reply", requestID, decision: "once" });
    expect((await client.next("error")).code).toBe("internal");
    expect(h.db.query("SELECT status FROM approvals WHERE id = ?").get(requestID)).toEqual({ status: "pending" });
  });

  test("approval.full returns the whole call, with invisible characters escaped", async () => {
    const { client, requestID } = await turnWaitingOnApproval();
    client.send({ type: "approval.full", requestID });
    const full = await client.next("approval.full.ok");
    expect(full.requestID).toBe(requestID);
    expect(full.text).toContain("rm -rf /tmp/agni-test-nothing");
    expect(full.text).toContain("\\u200B");
    expect(full.text).not.toContain("​");
  });

  test("approval.full for a card that is gone is not_found", async () => {
    const { client } = await start();
    client.send({ type: "approval.full", requestID: "apr_nope" });
    expect((await client.next("error")).code).toBe("not_found");
  });

  test("a card replayed on reconnect carries the source, tier, expiry and truncated flag it was raised with", async () => {
    const { client, h, requestID } = await turnWaitingOnApproval();
    const meta = { source: [{ kind: "web" as const, label: "example.com/offers" }], tier: 3 as const, expiresAt: new Date(Date.now() + 600_000).toISOString(), truncated: true };
    saveCardMeta(h.db, requestID, meta);
    const other = await h.connect({ device: "tablet" });
    const replayed = await other.next("approval.request");
    expect(replayed).toMatchObject({ requestID, ...meta });
    expect(client).toBeDefined();
  });

  test("a card with nothing saved is replayed as it always was, with no invented expiry", async () => {
    const { h } = await turnWaitingOnApproval();
    const other = await h.connect({ device: "tablet" });
    const replayed = await other.next("approval.request");
    expect(replayed.expiresAt).toBeUndefined();
    expect(replayed.tier).toBeUndefined();
  });
});

describe("approval rules list", () => {
  test("a rule made by pattern shows its pattern", async () => {
    const { client, h } = await start();
    const { addApprovalRule } = await import("../src/stores/approval-rules");
    addApprovalRule(h.db, { agentID: "ea", toolName: "mail_send", target: "", resourcePattern: "*@example.com" });
    client.send({ type: "approval.rules.list" });
    const list = await client.next("approval.rules.list.ok");
    expect(list.rules[0]).toMatchObject({ toolName: "mail_send", resourcePattern: "*@example.com" });
  });
});

describe("pause made from another process (the CLI)", () => {
  test("held messages start when the watcher sees the pause lifted", async () => {
    const seen: string[] = [];
    const fetcher = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ role: string; content: string }> };
      seen.push([...(body.messages ?? [])].reverse().find((message) => message.role === "user")?.content ?? "");
      return sseResponse("done");
    }) as unknown as typeof fetch;
    const { client, h } = await start({ fetch: fetcher });
    const { setAllPaused } = await import("../src/policy/pause");
    const { pauseWatcherTick } = await import("../src/startup/s2-audit");
    setAllPaused(h.db, true, { actor: "cli" });
    client.send({ type: "msg.send", channelId: "main", text: "wait for me" });
    await client.next("status.update", { match: (frame) => frame.text.startsWith("Waiting: bots are paused") });
    await Bun.sleep(100);
    expect(seen).toHaveLength(0);
    // Still paused: a tick starts nothing.
    pauseWatcherTick({ db: h.db });
    await Bun.sleep(100);
    expect(seen).toHaveLength(0);
    setAllPaused(h.db, false, { actor: "cli" });
    pauseWatcherTick({ db: h.db });
    await waitFor(() => seen.length === 1, 5000, "the held message to run");
    expect(seen[0]).toContain("wait for me");
  });

  test("a stop typed while paused has nothing to stop and is not kept to be answered later", async () => {
    const { client, h } = await start();
    client.send({ type: "policy.pause", paused: true });
    await client.next("policy.pause.ok");
    client.send({ type: "msg.send", channelId: "main", text: "stop" });
    await Bun.sleep(150);
    expect(h.db.query<{ n: number }, []>("SELECT count(*) AS n FROM queued_messages").get()!.n).toBe(0);
    client.send({ type: "policy.pause", paused: false });
    await client.next("policy.pause.ok");
    await Bun.sleep(200);
    expect(client.seen().some((frame) => frame.type === "turn.start")).toBe(false);
  });
});
