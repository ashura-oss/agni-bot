/**
 * The transcript reducer: what a person sees when frames arrive. These tests
 * are written against the frames the daemon really emits (see
 * packages/protocol/fixtures/frames.json).
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { MessageInfo } from "@agni/protocol";
import {
  Conversation,
  isComplete,
  isFailed,
  isStreaming,
  isStopped,
  stopExplanation,
  type IncomingFrame,
} from "../src";

const fixtureURL = new URL("../../../packages/protocol/fixtures/frames.json", import.meta.url);

function fixtureFrame(type: string): IncomingFrame {
  const root = JSON.parse(readFileSync(fixtureURL, "utf8")) as { server: Array<Record<string, unknown>> };
  const object = root.server.find((frame) => frame.type === type);
  if (!object) throw new Error(`no ${type} fixture`);
  return object as unknown as IncomingFrame;
}

function wire(object: Record<string, unknown>): IncomingFrame {
  return object as unknown as IncomingFrame;
}

function tokenFrame(turnID: string, threadID: string, delta: string, seq = 100): IncomingFrame {
  return wire({ type: "token", seq, turnID, threadID, delta });
}

function startFrame(turnID: string, threadID: string, agentID = "agni", conversationID?: string): IncomingFrame {
  const object: Record<string, unknown> = {
    type: "turn.start",
    seq: 90,
    turnID,
    threadID,
    agentID,
  };
  if (conversationID) object.conversationID = conversationID;
  return wire(object);
}

function endFrame(
  turnID: string,
  threadID: string,
  reason: string,
  options: { usage?: Record<string, unknown>; conversationID?: string } = {},
): IncomingFrame {
  const object: Record<string, unknown> = {
    type: "turn.end",
    seq: 120,
    turnID,
    threadID,
    stopReason: reason,
  };
  if (options.usage) object.usage = options.usage;
  if (options.conversationID) object.conversationID = options.conversationID;
  return wire(object);
}

function errorFrame(code: string, message: string): IncomingFrame {
  return wire({ type: "error", seq: 110, code, message });
}

function sessionStart(sessionID: string, conversationID = "cnv_1", reason = "manual"): IncomingFrame {
  return wire({ type: "session.start", seq: 70, conversationID, sessionID, reason });
}

function info(partial: Partial<MessageInfo> & Pick<MessageInfo, "id" | "role" | "text">): MessageInfo {
  return {
    createdAt: "2026-10-16T12:00:00.000Z",
    ...partial,
  };
}

describe("transcript", () => {
  test("a turn streams into one bubble and closes with its usage", () => {
    const conversation = new Conversation("agni", "thr_1");
    conversation.apply(startFrame("trn_1", "thr_1"));
    expect(conversation.isStreaming).toBe(true);

    for (const delta of ["Call ", "the ", "plumber."]) {
      conversation.apply(tokenFrame("trn_1", "thr_1", delta));
    }
    expect(conversation.messages.length).toBe(1);
    expect(conversation.messages[0]?.text).toBe("Call the plumber.");
    expect(isStreaming(conversation.messages[0]!)).toBe(true);

    const effects = conversation.apply(
      endFrame("trn_1", "thr_1", "end", {
        usage: {
          provider: "groq",
          model: "llama-3.1-8b-instant",
          latencyMs: 412,
          outputTokens: 24,
        },
      }),
    );
    expect(isComplete(conversation.messages[0]!)).toBe(true);
    expect(conversation.messages[0]?.usage?.latencyMs).toBe(412);
    expect(conversation.isStreaming).toBe(false);
    expect(effects).toContainEqual({ kind: "refreshThreadList" });
  });

  test("a reset token clears tool-step narration from the bubble", () => {
    const conversation = new Conversation("agni", "thr_1");
    conversation.apply(startFrame("trn_1", "thr_1"));
    conversation.apply(tokenFrame("trn_1", "thr_1", "Checking the list."));
    conversation.apply(wire({ type: "token", seq: 101, turnID: "trn_1", threadID: "thr_1", delta: "", reset: true }));
    conversation.apply(tokenFrame("trn_1", "thr_1", "No open tasks.", 102));
    expect(conversation.messages.length).toBe(1);
    expect(conversation.messages[0]?.text).toBe("No open tasks.");
  });

  test("a progress update is its own bubble during a streamed turn", () => {
    const conversation = new Conversation("agni", "thr_1");
    conversation.apply(startFrame("trn_1", "thr_1"));
    conversation.apply(tokenFrame("trn_1", "thr_1", "Working on it."));
    conversation.apply(wire({
      type: "msg.new",
      seq: 95,
      id: "msg_progress",
      channelId: "main",
      fromType: "agent",
      fromId: "agni",
      senderName: "Agni",
      text: "Checking the installer first.",
      internal: false,
      uiHint: "progress",
      createdAt: "2026-10-21T03:00:00.000Z",
    }));

    expect(conversation.messages).toHaveLength(2);
    expect(conversation.messages[0]).toMatchObject({
      id: "msg_progress",
      text: "Checking the installer first.",
      uiHint: "progress",
    });
    expect(conversation.messages[1]?.text).toBe("Working on it.");
  });

  test("each step is sealed as its own bubble, not one growing reply", () => {
    const conversation = new Conversation("agni", "thr_1");
    conversation.apply(startFrame("trn_steps", "thr_1"));
    conversation.apply(tokenFrame("trn_steps", "thr_1", "Checking the installer."));
    conversation.apply(wire({
      type: "msg.new", seq: 95, id: "msg_step1", channelId: "main",
      fromType: "agent", fromId: "agni", senderName: "Agni",
      text: "Checking the installer.", internal: false, uiHint: "normal",
      createdAt: "2026-10-22T11:00:01.000Z",
    }));
    conversation.apply(tokenFrame("trn_steps", "thr_1", "All set.", 96));
    conversation.apply(wire({
      type: "msg.new", seq: 97, id: "msg_step2", channelId: "main",
      fromType: "agent", fromId: "agni", senderName: "Agni",
      text: "All set.", internal: false, uiHint: "normal",
      createdAt: "2026-10-22T11:00:02.000Z",
    }));
    conversation.apply(endFrame("trn_steps", "thr_1", "end"));

    expect(conversation.messages.map((message) => [message.id, message.text])).toEqual([
      ["msg_step1", "Checking the installer."],
      ["msg_step2", "All set."],
    ]);
    expect(conversation.messages.every((message) => isComplete(message))).toBe(true);
    expect(conversation.isStreaming).toBe(false);
  });

  test("progress stays separate from the sealed answers", () => {
    const conversation = new Conversation("agni", "thr_1");
    conversation.apply(startFrame("trn_mix", "thr_1"));
    conversation.apply(tokenFrame("trn_mix", "thr_1", "Checking."));
    conversation.apply(wire({
      type: "msg.new", seq: 95, id: "msg_a", channelId: "main",
      fromType: "agent", fromId: "agni", senderName: "Agni",
      text: "Checking.", internal: false, uiHint: "normal",
      createdAt: "2026-10-22T11:00:01.000Z",
    }));
    conversation.apply(wire({
      type: "msg.new", seq: 96, id: "msg_progress", channelId: "main",
      fromType: "agent", fromId: "agni", senderName: "Agni",
      text: "Looking at the list.", internal: false, uiHint: "progress",
      createdAt: "2026-10-22T11:00:02.000Z",
    }));
    conversation.apply(tokenFrame("trn_mix", "thr_1", "All done.", 97));
    conversation.apply(wire({
      type: "msg.new", seq: 98, id: "msg_b", channelId: "main",
      fromType: "agent", fromId: "agni", senderName: "Agni",
      text: "All done.", internal: false, uiHint: "normal",
      createdAt: "2026-10-22T11:00:03.000Z",
    }));
    conversation.apply(endFrame("trn_mix", "thr_1", "end"));

    expect(conversation.messages.map((message) => message.id)).toEqual(["msg_a", "msg_progress", "msg_b"]);
  });

  test("a cancelled turn marks its sealed answer stopped", () => {
    const conversation = new Conversation("agni", "thr_1");
    conversation.apply(startFrame("trn_2", "thr_1"));
    conversation.apply(tokenFrame("trn_2", "thr_1", "half a thought"));
    conversation.apply(wire({
      type: "msg.new", seq: 95, id: "msg_half", channelId: "main",
      fromType: "agent", fromId: "agni", senderName: "Agni",
      text: "half a thought", internal: false, uiHint: "normal",
      createdAt: "2026-10-22T11:00:01.000Z",
    }));
    conversation.apply(endFrame("trn_2", "thr_1", "cancelled"));

    expect(conversation.messages).toHaveLength(1);
    expect(isStopped(conversation.messages[0]!, "cancelled")).toBe(true);
    expect(stopExplanation(conversation.messages[0]!)).toBe("Stopped");
  });

  test("a cancelled turn says so and keeps the partial text", () => {
    const conversation = new Conversation("agni", "thr_1");
    conversation.apply(startFrame("trn_2", "thr_1"));
    conversation.apply(tokenFrame("trn_2", "thr_1", "half a thought"));
    conversation.apply(endFrame("trn_2", "thr_1", "cancelled"));

    expect(conversation.messages[0]?.text).toBe("half a thought");
    expect(isStopped(conversation.messages[0]!, "cancelled")).toBe(true);
    expect(stopExplanation(conversation.messages[0]!)).toBe("Stopped");
  });

  test("a turn that dies mid-provider keeps the reason the daemon gave", () => {
    const conversation = new Conversation("agni", "thr_1");
    conversation.apply(startFrame("trn_4", "thr_1"));
    conversation.apply(errorFrame("provider_failed", "no provider in tier instant"));

    expect(conversation.messages.length).toBe(1);
    expect(conversation.messages[0]?.text).toBe("");

    conversation.apply(endFrame("trn_4", "thr_1", "error"));
    expect(isFailed(conversation.messages[0]!, "no provider in tier instant")).toBe(true);
  });

  test("a failed turn short on reasons does not invent one", () => {
    const conversation = new Conversation("agni", "thr_1");
    conversation.apply(startFrame("trn_5", "thr_1"));
    conversation.apply(endFrame("trn_5", "thr_1", "error"));

    expect(isStopped(conversation.messages[0]!, "error")).toBe(true);
    expect(stopExplanation(conversation.messages[0]!)).toBe("Failed");
  });

  test("one turn's failure does not stain the next", () => {
    const conversation = new Conversation("agni", "thr_1");
    conversation.apply(startFrame("trn_6", "thr_1"));
    conversation.apply(errorFrame("provider_failed", "upstream 500"));
    conversation.apply(endFrame("trn_6", "thr_1", "error"));

    conversation.apply(startFrame("trn_7", "thr_1"));
    conversation.apply(tokenFrame("trn_7", "thr_1", "second time lucky"));
    conversation.apply(endFrame("trn_7", "thr_1", "end"));

    const last = conversation.messages[conversation.messages.length - 1]!;
    expect(last.text).toBe("second time lucky");
    expect(isComplete(last)).toBe(true);
  });

  test("local echo appears immediately and survives history reload", () => {
    const conversation = new Conversation("agni");
    const localID = conversation.appendLocalUserMessage("remind me at 5", new Date("2026-10-16T11:59:57.000Z"));
    expect(conversation.messages.length).toBe(1);
    expect(conversation.messages[0]?.isLocalEcho).toBe(true);

    conversation.apply(startFrame("trn_3", "thr_9"));
    expect(conversation.threadID).toBe("thr_9");

    conversation.loadHistory("thr_9", "reminder", "agni", [
      info({
        id: "msg_1",
        role: "user",
        text: "remind me at 5",
        createdAt: "2026-10-16T11:59:58.000Z",
      }),
      info({
        id: "msg_2",
        role: "assistant",
        text: "Set for 17:00.",
        turnID: "trn_3",
      }),
    ]);
    expect(conversation.messages.length, "the durable copy replaces the echo, it does not duplicate it").toBe(2);
    expect(conversation.messages.map((message) => message.text)).toEqual(["remind me at 5", "Set for 17:00."]);
    expect(conversation.messages.every((message) => !message.isLocalEcho)).toBe(true);
    expect(localID.startsWith("local_")).toBe(true);
  });

  test("tool activity attaches to the reply it belongs to", () => {
    const conversation = new Conversation("agni", "thr_1");
    conversation.apply(startFrame("trn_4", "thr_1"));
    conversation.apply(fixtureFrame("tool.start"));
    conversation.apply(fixtureFrame("tool.update"));
    conversation.apply(fixtureFrame("tool.end"));

    const tools = conversation.messages[0]?.tools ?? [];
    expect(tools.length).toBe(1);
    expect(tools[0]?.name).toBe("memory.search");
    expect(tools[0]?.state).toBe("ok");
    expect(tools[0]?.preview).toBe("3 matches");
  });

  test("approvals and forms are tracked until answered", () => {
    const conversation = new Conversation("agni", "thr_1");
    const approvalEffects = conversation.apply(fixtureFrame("approval.request"));
    expect(conversation.openApprovals.length).toBe(1);
    expect(conversation.openApprovals[0]?.decisions).toEqual(["once", "always", "reject"]);
    // The product name is never a bot's name: with no turn in flight the
    // requester is unknown, so the wording is neutral.
    expect(approvalEffects).toContainEqual({
      kind: "notify",
      title: "Approval needed",
      body: "shell: git push origin main",
      sound: true,
      need: "approval",
      agentID: null,
    });

    conversation.apply(fixtureFrame("form.request"));
    expect(conversation.openForms.length).toBe(1);
    expect(conversation.needsYou).toBe(true);

    conversation.resolveApproval("apr_01hq", "once");
    conversation.resolveForm("frm_01hq", "both");
    expect(conversation.openApprovals.length).toBe(0);
    expect(conversation.openForms.length).toBe(0);
    expect(conversation.needsYou).toBe(false);
  });

  test("the requesting bot is the one whose turn is in flight (S1-40)", () => {
    const conversation = new Conversation("agni", "thr_1");
    conversation.apply(startFrame("trn_9", "thr_1", "researcher"));
    const effects = conversation.apply(fixtureFrame("approval.request"));
    expect(conversation.openApprovals[0]?.agentID).toBe("researcher");
    expect(effects).toContainEqual(expect.objectContaining({ kind: "notify", need: "approval", agentID: "researcher" }));
    for (const effect of effects) {
      if (effect.kind === "notify") expect(effect.title).not.toMatch(/agni/i);
    }
    conversation.apply(fixtureFrame("form.request"));
    expect(conversation.openForms[0]?.agentID).toBe("researcher");
    conversation.apply(endFrame("trn_9", "thr_1", "end"));
    conversation.apply(wire({ type: "secret.request", seq: 5, requestID: "sec_1", purpose: "sudo", command: "ls", kind: "password", expiresAt: "2030-01-01T00:00:00.000Z" }));
    const secret = conversation.apply(wire({ type: "secret.request", seq: 6, requestID: "sec_2", purpose: "sudo", command: "ls", kind: "password", expiresAt: "2030-01-01T00:00:00.000Z" }));
    for (const effect of secret) {
      if (effect.kind === "notify") expect(effect.title).not.toMatch(/agni/i);
    }
  });

  test("approval.closed removes the approval card and only that one (S1-closed)", () => {
    const conversation = new Conversation("agni", "thr_1");
    conversation.apply(fixtureFrame("approval.request"));
    conversation.apply(wire({ type: "approval.request", seq: 51, requestID: "apr_other", action: "shell: ls", preview: "", buttons: ["once"] }));
    conversation.apply(fixtureFrame("form.request"));
    expect(conversation.openApprovals.map((a) => a.id)).toEqual(["apr_01hq", "apr_other"]);

    // A form with the same id must not be touched by an approval close.
    conversation.apply(wire({ type: "approval.closed", seq: 60, requestID: "apr_01hq", kind: "approval", reason: "decided" }));
    expect(conversation.approvals.map((a) => a.id)).toEqual(["apr_other"]);
    expect(conversation.openForms.length).toBe(1);

    conversation.apply(wire({ type: "approval.closed", seq: 61, requestID: "frm_01hq", kind: "form", reason: "expired" }));
    expect(conversation.forms.length).toBe(0);
    expect(conversation.openApprovals.map((a) => a.id)).toEqual(["apr_other"]);
  });

  test("approval.closed removes an already answered card and ignores an unknown id", () => {
    const conversation = new Conversation("agni", "thr_1");
    conversation.apply(fixtureFrame("approval.request"));
    conversation.resolveApproval("apr_01hq", "once");
    conversation.apply(wire({ type: "approval.closed", seq: 60, requestID: "apr_01hq", kind: "approval", reason: "decided" }));
    expect(conversation.approvals.length).toBe(0);
    expect(() => conversation.apply(wire({ type: "approval.closed", seq: 61, requestID: "nope", kind: "form", reason: "cancelled" }))).not.toThrow();
    // An approval id never closes a form of the same id, and vice versa.
    conversation.apply(fixtureFrame("form.request"));
    conversation.apply(wire({ type: "approval.closed", seq: 62, requestID: "frm_01hq", kind: "approval", reason: "cancelled" }));
    expect(conversation.forms.length).toBe(1);
  });

  test("messages for another thread become an unread mark, not a bubble", () => {
    const conversation = new Conversation("agni", "thr_1");
    const effects = conversation.apply(startFrame("trn_5", "thr_other"));
    expect(effects).toContainEqual({ kind: "unread", threadID: "thr_other" });
    expect(conversation.messages.length).toBe(0);
    expect(conversation.isStreaming).toBe(false);

    conversation.apply(tokenFrame("trn_5", "thr_other", "background noise"));
    expect(conversation.messages.length).toBe(0);
  });

  test("a reply picked up mid-stream is marked as a continuation until its full text lands (S1-40)", () => {
    const conversation = new Conversation("agni", "thr_1");
    // The owner switched away and back: the turn began before this view existed.
    conversation.apply(tokenFrame("trn_mid", "thr_1", "the rest of the sentence"));
    const bubble = conversation.messages[0];
    expect(bubble?.isContinuation).toBe(true);

    conversation.apply(wire({
      type: "msg.new", seq: 130, id: "msg_full", channelId: "main", fromType: "agent", fromId: "agni",
      senderName: "Agni", text: "The whole sentence, start to finish.", createdAt: "2026-10-16T12:00:00.000Z",
    }));
    const sealed = conversation.messages.find((message) => message.id === "msg_full");
    expect(sealed?.text).toBe("The whole sentence, start to finish.");
    expect(sealed?.isContinuation).toBe(false);
  });

  test("a reply picked up mid-stream asks for the durable copy when the turn ends", () => {
    const conversation = new Conversation("agni", "thr_1");
    conversation.apply(tokenFrame("trn_mid", "thr_1", "the rest"));
    const effects = conversation.apply(endFrame("trn_mid", "thr_1", "end"));
    expect(effects).toContainEqual({ kind: "reloadDurableState" });
    // A normal turn does not.
    const whole = new Conversation("agni", "thr_1");
    whole.apply(startFrame("trn_w", "thr_1"));
    whole.apply(tokenFrame("trn_w", "thr_1", "all of it"));
    expect(whole.apply(endFrame("trn_w", "thr_1", "end"))).not.toContainEqual({ kind: "reloadDurableState" });
  });

  test("history rows carry how their turn ended, so the marker survives a reload (W2-C)", () => {
    const conversation = new Conversation("agni", "thr_1");
    conversation.loadHistory("thr_1", null, "agni", [
      info({ id: "msg_a", role: "assistant", text: "Roses are", turnID: "trn_s", stopReason: "cancelled" }),
      info({ id: "msg_b", role: "assistant", text: "Fine.", turnID: "trn_ok", stopReason: "end" }),
      info({ id: "msg_c", role: "assistant", text: "Old row", turnID: "trn_old" }),
      info({ id: "msg_u", role: "user", text: "write", turnID: "trn_s" }),
    ]);
    const stopped = conversation.messages.find((message) => message.id === "msg_a");
    expect(stopped?.state).toEqual({ kind: "stopped", reason: "cancelled" });
    expect(conversation.messages.find((message) => message.id === "msg_b")?.state.kind).toBe("complete");
    expect(conversation.messages.find((message) => message.id === "msg_c")?.state.kind).toBe("complete");
    expect(conversation.messages.find((message) => message.id === "msg_u")?.state.kind).toBe("complete");
  });

  test("the local stop record only fills in rows the server did not describe", () => {
    const conversation = new Conversation("agni", "thr_1");
    conversation.loadHistory("thr_1", null, "agni", [
      info({ id: "msg_a", role: "assistant", text: "told", turnID: "trn_a", stopReason: "end" }),
      info({ id: "msg_b", role: "assistant", text: "silent", turnID: "trn_b" }),
    ]);
    conversation.restoreStops({ trn_a: "cancelled", trn_b: "cancelled" });
    expect(conversation.messages.find((message) => message.id === "msg_a")?.state.kind).toBe("complete");
    expect(conversation.messages.find((message) => message.id === "msg_b")?.state).toEqual({ kind: "stopped", reason: "cancelled" });
  });

  test("a local echo can be discarded when the daemon refuses the message", () => {
    const conversation = new Conversation("agni", "thr_1");
    const id = conversation.appendLocalUserMessage("x".repeat(10));
    conversation.discardLocalEcho(id);
    expect(conversation.messages).toHaveLength(0);
  });

  test("the rules frames change no transcript", () => {
    const conversation = new Conversation("agni", "thr_1");
    expect(conversation.apply(wire({ type: "approval.rules.list.ok", seq: 1, rules: [] }))).toEqual([]);
    expect(conversation.apply(wire({ type: "approval.rule.revoke.ok", seq: 2, id: "rul_1" }))).toEqual([]);
  });

  test("another bot's streaming reply never shows in this chat (exit test P2)", () => {
    // Open chat: bot B, bound to its conversation, block not yet known.
    const chat = new Conversation("bot_b");
    chat.bind("cnv_b", "bot_b", null);
    // Bot A's turn streams. Tokens carry a turn and a block id but no conversation.
    chat.apply(startFrame("trn_a", "thr_a", "bot_a", "cnv_a"));
    chat.apply(tokenFrame("trn_a", "thr_a", "half a sentence"));
    chat.apply(tokenFrame("trn_a", "thr_a", " and more"));
    expect(chat.messages).toHaveLength(0);
    expect(chat.isStreaming).toBe(false);
    chat.apply(endFrame("trn_a", "thr_a", "end", { conversationID: "cnv_a" }));
    expect(chat.messages).toHaveLength(0);

    // The same when this view was created after A's turn began: no turn.start was ever seen.
    const late = new Conversation("bot_b");
    late.bind("cnv_b", "bot_b", null);
    late.apply(tokenFrame("trn_x", "thr_x", "stray fragment"));
    expect(late.messages).toHaveLength(0);

    // A chat that knows its own block still takes the tail of its own turn.
    const own = new Conversation("bot_b");
    own.bind("cnv_b", "bot_b", "thr_b");
    own.apply(tokenFrame("trn_b", "thr_b", "tail of mine"));
    expect(own.messages[0]?.text).toBe("tail of mine");
  });

  test("a turn of this conversation whose tokens were held back asks for the durable reply at its end", () => {
    const chat = new Conversation("bot_b");
    chat.bind("cnv_b", "bot_b", null);
    chat.apply(tokenFrame("trn_b", "thr_b", "unseen"));
    expect(chat.messages).toHaveLength(0);
    expect(chat.apply(endFrame("trn_b", "thr_b", "end", { conversationID: "cnv_b" }))).toContainEqual({ kind: "reloadDurableState" });
    // Another bot's turn asks for nothing.
    chat.apply(startFrame("trn_a", "thr_a", "bot_a", "cnv_a"));
    expect(chat.apply(endFrame("trn_a", "thr_a", "end", { conversationID: "cnv_a" }))).not.toContainEqual({ kind: "reloadDurableState" });
  });

  test("a reload mid-turn: the replayed turn.start arrives before the chat is bound (final round)", () => {
    const chat = new Conversation("ea");
    // Replay first: conversation.open has not answered, so the chat does not know its conversation yet.
    chat.apply(startFrame("trn_1", "thr_1", "ea", "cnv_1"));
    chat.apply(tokenFrame("trn_1", "thr_1", "dropped before bind"));
    expect(chat.messages).toHaveLength(0);

    chat.bind("cnv_1", "ea", "thr_1");
    expect(chat.isStreaming).toBe(true);
    expect(chat.inFlightTurnID).toBe("trn_1");
    expect(chat.messages[0]?.isContinuation).toBe(true);

    chat.apply(tokenFrame("trn_1", "thr_1", "tokens after bind"));
    expect(chat.messages[0]?.text).toBe("tokens after bind");
    const effects = chat.apply(endFrame("trn_1", "thr_1", "end", { conversationID: "cnv_1" }));
    expect(effects).toContainEqual({ kind: "reloadDurableState" });
    expect(chat.isStreaming).toBe(false);
  });

  test("a turn replayed before bind that belongs to another bot is declined once the chat is bound", () => {
    const chat = new Conversation("bot_b");
    chat.apply(startFrame("trn_a", "thr_a", "bot_a", "cnv_a"));
    chat.bind("cnv_b", "bot_b", "thr_b");
    expect(chat.isStreaming).toBe(false);
    chat.apply(tokenFrame("trn_a", "thr_a", "must stay out"));
    expect(chat.messages).toHaveLength(0);
  });

  test("a turn that ended before the bind is not adopted", () => {
    const chat = new Conversation("ea");
    chat.apply(startFrame("trn_1", "thr_1", "ea", "cnv_1"));
    chat.apply(endFrame("trn_1", "thr_1", "end", { conversationID: "cnv_1" }));
    chat.bind("cnv_1", "ea", "thr_1");
    expect(chat.isStreaming).toBe(false);
    expect(chat.messages).toHaveLength(0);
  });

  test("a routine turn that streams nothing asks for the durable reply when it ends (int11)", () => {
    const chat = new Conversation("ea");
    chat.bind("cnv_1", "ea", "thr_active");
    chat.apply(startFrame("trn_r", "thr_routine", "ea", "cnv_1"));
    const effects = chat.apply(endFrame("trn_r", "thr_routine", "end", { conversationID: "cnv_1" }));
    expect(chat.messages).toHaveLength(0);
    expect(effects).toContainEqual({ kind: "reloadDurableState" });
  });

  test("history that names a running turn shows Writing and takes its tokens at once (int11)", () => {
    const chat = new Conversation("ea");
    chat.bind("cnv_1", "ea", "thr_1");
    chat.loadConversationHistory("cnv_1", "ea", [info({ id: "m1", role: "user", text: "long task", turnID: "trn_1", sessionID: "thr_1" })], {
      turnID: "trn_1", threadID: "thr_1", agentID: "ea",
    });
    expect(chat.isStreaming).toBe(true);
    expect(chat.inFlightTurnID).toBe("trn_1");
    const bubble = chat.messages.find((message) => message.id === Conversation.assistantID("trn_1"));
    expect(bubble?.state.kind).toBe("streaming");
    chat.apply(tokenFrame("trn_1", "thr_1", "partial"));
    expect(chat.messages.find((message) => message.id === Conversation.assistantID("trn_1"))?.text).toBe("partial");
    // Loading the history again does not stack a second bubble.
    chat.loadConversationHistory("cnv_1", "ea", [info({ id: "m1", role: "user", text: "long task", turnID: "trn_1", sessionID: "thr_1" })], {
      turnID: "trn_1", threadID: "thr_1", agentID: "ea",
    });
    expect(chat.messages.filter((message) => message.turnID === "trn_1" && message.role === "assistant")).toHaveLength(1);
  });

  test("a turn that already ended is not brought back by a late history answer (int11)", () => {
    const chat = new Conversation("ea");
    chat.bind("cnv_1", "ea", "thr_1");
    chat.apply(startFrame("trn_1", "thr_1", "ea", "cnv_1"));
    chat.apply(endFrame("trn_1", "thr_1", "end", { conversationID: "cnv_1" }));
    chat.loadConversationHistory("cnv_1", "ea", [], { turnID: "trn_1", threadID: "thr_1", agentID: "ea" });
    expect(chat.isStreaming).toBe(false);
  });

  test("a running turn of another conversation is not adopted", () => {
    const chat = new Conversation("ea");
    chat.bind("cnv_1", "ea", "thr_1");
    chat.loadConversationHistory("cnv_1", "ea", [], { turnID: "trn_x", threadID: "thr_x", agentID: "other_bot" });
    expect(chat.isStreaming).toBe(false);
  });

  test("a routine turn in a chat that has no block yet is still background work (int11)", () => {
    const chat = new Conversation("ea");
    chat.bind("cnv_1", "ea", null);
    chat.apply(startFrame("trn_r", "thr_routine", "ea", "cnv_1"));
    expect(chat.messages[0]?.isBackground).toBe(true);
    // The routine's block is not the chat's own block.
    expect(chat.threadID).toBeNull();
    const effects = chat.apply(endFrame("trn_r", "thr_routine", "end", { conversationID: "cnv_1" }));
    expect(chat.messages).toHaveLength(0);
    expect(effects).toContainEqual({ kind: "reloadDurableState" });
  });

  test("the owner's first message in a chat with no block yet is not background", () => {
    const chat = new Conversation("ea");
    chat.bind("cnv_1", "ea", null);
    chat.appendLocalUserMessage("hello");
    chat.apply(startFrame("trn_1", "thr_new", "ea", "cnv_1"));
    expect(chat.messages.find((message) => message.turnID === "trn_1")?.isBackground).toBe(false);
    expect(chat.threadID).toBe("thr_new");
  });

  describe("identical messages keep their own places (p2-order)", () => {
    const Q = "What is 7 times 8?";
    const history = (): MessageInfo[] => [
      info({ id: "msg_q1", role: "user", text: Q, createdAt: "2026-11-16T10:00:00.000Z", turnID: "trn_1", sessionID: "thr_1" }),
      info({ id: "msg_a1", role: "assistant", text: "[This request was interrupted by a restart and was not completed.]", createdAt: "2026-11-16T10:00:05.000Z", turnID: "trn_1", sessionID: "thr_1", stopReason: "error" }),
      info({ id: "msg_n1", role: "system", text: "This reply was interrupted by a restart.", createdAt: "2026-11-16T10:00:06.000Z", turnID: "trn_1", sessionID: "thr_1" }),
      info({ id: "msg_q2", role: "user", text: Q, createdAt: "2026-11-16T10:05:00.000Z", turnID: "trn_2", sessionID: "thr_1" }),
      info({ id: "msg_a2", role: "assistant", text: "56", createdAt: "2026-11-16T10:05:03.000Z", turnID: "trn_2", sessionID: "thr_1", stopReason: "end" }),
    ];
    const order = (chat: Conversation) => chat.messages.map((message) => message.id);
    const loaded = () => {
      const chat = new Conversation("agni");
      chat.bind("cnv_1", "agni", "thr_1");
      chat.loadConversationHistory("cnv_1", "agni", history());
      return chat;
    };
    const newRow = (id: string, createdAt: string) =>
      info({ id, role: "user", text: Q, createdAt, turnID: "trn_3", sessionID: "thr_1" });

    test("a pending send is not answered by older rows that were already on screen", () => {
      const chat = loaded();
      const echoID = chat.appendLocalUserMessage(Q);
      chat.loadConversationHistory("cnv_1", "agni", history());
      expect(order(chat)).toEqual(["msg_q1", "msg_a1", "msg_n1", "msg_q2", "msg_a2", echoID]);
    });

    test("a row that is new since the send answers it, whatever either clock says", () => {
      const chat = loaded();
      // The daemon's clock is ten minutes behind the browser's.
      chat.appendLocalUserMessage(Q, new Date("2026-11-16T10:20:00.000Z"));
      chat.loadConversationHistory("cnv_1", "agni", [...history(), newRow("msg_q3", "2026-11-16T10:10:00.000Z")]);
      expect(order(chat)).toEqual(["msg_q1", "msg_a1", "msg_n1", "msg_q2", "msg_a2", "msg_q3"]);
      expect(chat.messages.some((message) => message.isLocalEcho)).toBe(false);
    });

    test("each new row answers one send, oldest pending first", () => {
      const chat = loaded();
      const first = chat.appendLocalUserMessage(Q);
      const second = chat.appendLocalUserMessage(Q);
      chat.loadConversationHistory("cnv_1", "agni", [...history(), newRow("msg_q3", "2026-11-16T10:10:00.000Z")]);
      expect(order(chat)).toEqual(["msg_q1", "msg_a1", "msg_n1", "msg_q2", "msg_a2", "msg_q3", second]);
      expect(order(chat)).not.toContain(first);
    });

    test("a live echo keeps its place and the rows stay in DB order after a live msg.new", () => {
      const chat = loaded();
      chat.appendLocalUserMessage(Q);
      chat.apply(wire({ type: "msg.new", seq: 40, id: "chm_q3", channelId: "main", fromType: "user", fromId: "owner", senderName: "You", text: Q, createdAt: "2026-11-16T10:10:00.500Z" }));
      expect(order(chat)).toEqual(["msg_q1", "msg_a1", "msg_n1", "msg_q2", "msg_a2", "chm_q3"]);
      chat.apply(wire({ type: "msg.new", seq: 41, id: "chm_a3", channelId: "main", fromType: "agent", fromId: "agni", senderName: "Agni", text: "56", createdAt: "2026-11-16T10:10:04.000Z" }));
      expect(order(chat).slice(-2)).toEqual(["chm_q3", "chm_a3"]);
      chat.loadConversationHistory("cnv_1", "agni", history());
      expect(order(chat).slice(0, 5)).toEqual(["msg_q1", "msg_a1", "msg_n1", "msg_q2", "msg_a2"]);
    });

    test("a streaming reply stays below its question when the browser clock is behind the daemon's", () => {
      const chat = new Conversation("agni");
      chat.bind("cnv_1", "agni", "thr_1");
      // The daemon says 2031; this browser says now.
      const rows = [info({ id: "msg_q", role: "user", text: "later question", createdAt: "2031-01-01T00:00:00.000Z", turnID: "trn_9", sessionID: "thr_1" })];
      chat.loadConversationHistory("cnv_1", "agni", rows);
      chat.apply(startFrame("trn_9", "thr_1", "agni", "cnv_1"));
      chat.apply(tokenFrame("trn_9", "thr_1", "partial"));
      chat.loadConversationHistory("cnv_1", "agni", rows);
      expect(order(chat)).toEqual(["msg_q", Conversation.assistantID("trn_9")]);
    });

    test("a survivor follows the durable row it followed, not the clock", () => {
      const chat = loaded();
      const echoID = chat.appendLocalUserMessage(Q);
      // A new system note arrives in the history after the send; the echo still follows what it followed.
      chat.loadConversationHistory("cnv_1", "agni", [
        ...history(),
        info({ id: "msg_n2", role: "system", text: "A note.", createdAt: "2026-11-16T10:00:00.000Z", sessionID: "thr_1" }),
      ]);
      expect(order(chat)).toEqual(["msg_q1", "msg_a1", "msg_n1", "msg_q2", "msg_a2", echoID, "msg_n2"]);
    });
  });

  test("a turn this chat declined at its start stays declined even if its block is later adopted", () => {
    const chat = new Conversation("bot_b");
    chat.bind("cnv_b", "bot_b", null);
    chat.apply(startFrame("trn_a", "thr_a", "bot_a", "cnv_a"));
    // The open chat then learns of a block with the same id (it cannot, but a stale id must not leak).
    chat.startSession("thr_a", "cnv_b");
    chat.apply(tokenFrame("trn_a", "thr_a", "must stay out"));
    expect(chat.messages).toHaveLength(0);
  });

  test("a server restart clears turn state, bubbles and dead cards, but keeps cards re-sent since (exit test P1)", () => {
    const chat = new Conversation("agni");
    chat.bind("cnv_1", "agni", "thr_1");
    chat.apply(startFrame("trn_1", "thr_1", "agni", "cnv_1"));
    chat.apply(tokenFrame("trn_1", "thr_1", "dies with the server"));
    chat.apply(fixtureFrame("approval.request"));
    chat.apply(fixtureFrame("form.request"));
    chat.apply(wire({ type: "secret.request", seq: 9, requestID: "sec_old", purpose: "p", command: "c", kind: "password", expiresAt: "2030-01-01T00:00:00.000Z" }));
    chat.appendLocalUserMessage("still mine");
    expect(chat.isStreaming).toBe(true);

    chat.resetLive({ keepCards: new Set(["frm_01hq"]) });
    expect(chat.isStreaming).toBe(false);
    expect(chat.inFlightTurnID).toBeNull();
    expect(chat.messages.some((message) => message.state.kind === "streaming")).toBe(false);
    expect(chat.messages.some((message) => message.isLocalEcho)).toBe(true);
    expect(chat.approvals).toHaveLength(0);
    expect(chat.forms.map((form) => form.id)).toEqual(["frm_01hq"]);
    expect(chat.secrets).toHaveLength(0);

    // A turn that comes back to life later starts clean.
    chat.apply(startFrame("trn_2", "thr_1", "agni", "cnv_1"));
    chat.apply(tokenFrame("trn_2", "thr_1", "fresh"));
    expect(chat.messages.find((message) => message.turnID === "trn_2")?.text).toBe("fresh");
    expect(chat.isStreaming).toBe(true);
  });

  test("a turn seen from its start is never a continuation", () => {
    const conversation = new Conversation("agni", "thr_1");
    conversation.apply(startFrame("trn_whole", "thr_1"));
    conversation.apply(tokenFrame("trn_whole", "thr_1", "from the start"));
    expect(conversation.messages[0]?.isContinuation).toBe(false);
  });

  test("a stopped turn keeps its marker after the history reloads (S1-40)", () => {
    const conversation = new Conversation("agni", "thr_1");
    const durable: MessageInfo[] = [
      info({ id: "msg_q", role: "user", text: "write a poem", createdAt: "2026-10-16T11:00:00.000Z", turnID: "trn_s" }),
      info({ id: "msg_a", role: "assistant", text: "Roses are", createdAt: "2026-10-16T11:00:01.000Z", turnID: "trn_s" }),
      info({ id: "msg_b", role: "assistant", text: "Fine.", createdAt: "2026-10-16T11:05:00.000Z", turnID: "trn_ok" }),
    ];
    conversation.loadHistory("thr_1", null, "agni", durable);
    expect(conversation.messages.every((message) => message.state.kind === "complete")).toBe(true);

    conversation.restoreStops({ trn_s: "cancelled" });
    const stopped = conversation.messages.find((message) => message.id === "msg_a");
    expect(stopped?.state).toEqual({ kind: "stopped", reason: "cancelled" });
    expect(stopExplanation(stopped!)).not.toBeNull();
    // Neither the owner's message nor another turn's answer changes.
    expect(conversation.messages.find((message) => message.id === "msg_q")?.state.kind).toBe("complete");
    expect(conversation.messages.find((message) => message.id === "msg_b")?.state.kind).toBe("complete");
  });

  test("replayed deltas without their start still render", () => {
    const conversation = new Conversation("agni", "thr_1");
    conversation.apply(tokenFrame("trn_6", "thr_1", "resumed "));
    expect(conversation.messages.length).toBe(1);
    expect(isStreaming(conversation.messages[0]!)).toBe(true);
  });

  test("errors and notices land in the notice list", () => {
    const conversation = new Conversation("agni", "thr_1");
    const effects = conversation.apply(fixtureFrame("notify"));
    expect(conversation.notices.length).toBe(1);
    expect(effects).toContainEqual({
      kind: "notify",
      title: "Agni · standup in 10",
      body: "You asked to be nudged before the 09:30 standup.",
      sound: true,
      threadID: "thr_01hq",
    });

    const gap = wire({ type: "error", seq: 200, code: "resync_gap", message: "cannot replay from 1" });
    const gapEffects = conversation.apply(gap);
    expect(gapEffects).toContainEqual({ kind: "reloadDurableState" });
    expect(conversation.notices[conversation.notices.length - 1]?.kind).toBe("failure");
  });

  test("history reload keeps a stream that is still running", () => {
    const conversation = new Conversation("agni", "thr_1");
    conversation.apply(startFrame("trn_7", "thr_1"));
    conversation.apply(tokenFrame("trn_7", "thr_1", "still writing"));

    conversation.loadHistory("thr_1", null, "agni", [
      info({ id: "msg_9", role: "user", text: "an older question", createdAt: "2026-10-16T11:00:00.000Z" }),
    ]);
    expect(conversation.messages.length).toBe(2);
    expect(conversation.messages[1]?.text).toBe("still writing");
    expect(isStreaming(conversation.messages[1]!)).toBe(true);
  });
});

describe("session seams", () => {
  test("history across blocks keeps each message's block", () => {
    const conversation = new Conversation("agni");
    conversation.bind("cnv_1", "agni", "thr_block1");
    conversation.loadConversationHistory("cnv_1", "agni", [
      info({
        id: "msg_a",
        role: "user",
        text: "older block message",
        createdAt: "2026-10-16T11:00:00.000Z",
        sessionID: "thr_block1",
      }),
      info({
        id: "msg_b",
        role: "assistant",
        text: "newer block message",
        createdAt: "2026-10-16T12:00:00.000Z",
        turnID: "trn_a",
        sessionID: "thr_block2",
      }),
    ]);
    expect(conversation.messages.map((message) => message.sessionID)).toEqual(["thr_block1", "thr_block2"]);
  });

  test("a seam reroutes the next turn into the new block", () => {
    const conversation = new Conversation("agni");
    conversation.bind("cnv_1", "agni", "thr_block1");
    conversation.apply(sessionStart("thr_block2"));

    conversation.apply(startFrame("trn_x", "thr_block2", "agni", "cnv_1"));
    expect(conversation.messages.length).toBe(1);
    expect(conversation.messages[0]?.sessionID).toBe("thr_block2");
  });

  test("a local echo after the seam stamps the new block", () => {
    const conversation = new Conversation("agni");
    conversation.bind("cnv_1", "agni", "thr_block1");
    conversation.apply(sessionStart("thr_block2"));

    conversation.appendLocalUserMessage("after the fold");
    expect(conversation.messages[0]?.sessionID).toBe("thr_block2");
  });

  test("a background turn shared by conversation streams into the surface", () => {
    const conversation = new Conversation("agni");
    conversation.bind("cnv_1", "agni", "thr_active");

    const effects = conversation.apply(startFrame("trn_job", "thr_brief", "agni", "cnv_1"));
    expect(effects.length).toBe(0);

    conversation.apply(tokenFrame("trn_job", "thr_brief", "7:55: rain around noon."));
    expect(conversation.messages.length).toBe(1);
    expect(conversation.messages[0]?.sessionID).toBe("thr_brief");
    expect(conversation.isStreaming).toBe(true);

    conversation.apply(endFrame("trn_job", "thr_brief", "end", { conversationID: "cnv_1" }));
    expect(isComplete(conversation.messages[0]!)).toBe(true);
    expect(conversation.isStreaming).toBe(false);
  });

  test("a background job that says nothing leaves no failed empty reply in the open chat (S1-23)", () => {
    const conversation = new Conversation("agni");
    conversation.bind("cnv_1", "agni", "thr_active");

    conversation.apply(startFrame("trn_job", "thr_job", "agni", "cnv_1"));
    conversation.apply(endFrame("trn_job", "thr_job", "end", { conversationID: "cnv_1" }));
    expect(conversation.messages.length).toBe(0);
    expect(conversation.isStreaming).toBe(false);

    // The same turn kind in the open block is the owner's own: an empty
    // answer there still reads as "produced no reply".
    conversation.apply(startFrame("trn_own", "thr_active", "agni", "cnv_1"));
    conversation.apply(endFrame("trn_own", "thr_active", "end", { conversationID: "cnv_1" }));
    expect(conversation.messages.length).toBe(1);
    expect(conversation.messages[0]?.isBackground).toBe(false);
  });

  test("a background job that failed or timed out is not silently dropped (review)", () => {
    for (const reason of ["error", "timeout"]) {
      const conversation = new Conversation("agni");
      conversation.bind("cnv_1", "agni", "thr_active");
      conversation.apply(startFrame("trn_f", "thr_job", "agni", "cnv_1"));
      conversation.apply(endFrame("trn_f", "thr_job", reason, { conversationID: "cnv_1" }));
      const kept = conversation.messages.find((message) => message.turnID === "trn_f");
      expect(kept?.isBackground).toBe(true);
      expect(kept?.state.kind).not.toBe("complete");
      expect(kept?.state.kind).not.toBe("streaming");
    }
  });

  test("a background job that spoke keeps its text; one that only ran tools is flagged, not failed", () => {
    const conversation = new Conversation("agni");
    conversation.bind("cnv_1", "agni", "thr_active");
    conversation.apply(startFrame("trn_a", "thr_job", "agni", "cnv_1"));
    conversation.apply(tokenFrame("trn_a", "thr_job", "Time to stretch."));
    conversation.apply(endFrame("trn_a", "thr_job", "end", { conversationID: "cnv_1" }));
    expect(conversation.messages[0]?.text).toBe("Time to stretch.");

    conversation.apply(startFrame("trn_b", "thr_job2", "agni", "cnv_1"));
    conversation.apply(wire({ type: "tool.start", seq: 130, callID: "c1", name: "notify", turnID: "trn_b" }));
    conversation.apply(endFrame("trn_b", "thr_job2", "end", { conversationID: "cnv_1" }));
    const quiet = conversation.messages.find((m) => m.turnID === "trn_b");
    expect(quiet?.isBackground).toBe(true);
    expect(quiet?.text).toBe("");
  });

  test("turns of another conversation stay out", () => {
    const conversation = new Conversation("agni");
    conversation.bind("cnv_1", "agni", "thr_active");
    const effects = conversation.apply(startFrame("trn_other", "thr_other", "agni", "cnv_other"));
    expect(effects).toContainEqual({ kind: "unread", threadID: "thr_other" });
    expect(conversation.messages.length).toBe(0);
  });

  test("a seam pins the surface even when history carries no blocks", () => {
    const conversation = new Conversation("agni");
    conversation.bind("cnv_1", "agni", null);
    expect(conversation.threadID).toBeNull();
    conversation.apply(sessionStart("thr_first"));
    expect(conversation.threadID).toBe("thr_first");
  });
});

describe("the stop marker on the owner's own row (S2-6)", () => {
  const owner = (partial: Partial<MessageInfo> = {}) =>
    info({ id: "m1", role: "user", text: "do the big thing", turnID: "trn_1", sessionID: "thr_1", ...partial });

  test("a user row that names how its turn ended gets 'No reply, stopped' after it, from history alone", () => {
    const chat = new Conversation("ea");
    chat.loadConversationHistory("cnv_1", "ea", [owner({ stopReason: "cancelled" })]);
    expect(chat.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    const marker = chat.messages[1]!;
    expect(marker.text).toBe("");
    expect(marker.turnID).toBe("trn_1");
    expect(isStopped(marker, "cancelled")).toBe(true);
    expect(stopExplanation(marker)).toBe("Stopped");
  });

  test("a spend stop reads as out of budget", () => {
    const chat = new Conversation("ea");
    chat.loadConversationHistory("cnv_1", "ea", [owner({ stopReason: "budget" })]);
    expect(stopExplanation(chat.messages[1]!)).toBe("Out of budget");
  });

  test("a turn that ended well, or is waiting for the owner, adds nothing", () => {
    for (const stopReason of ["end", "needs_input"]) {
      const chat = new Conversation("ea");
      chat.loadConversationHistory("cnv_1", "ea", [owner({ stopReason })]);
      expect(chat.messages).toHaveLength(1);
    }
  });

  test("a user row with no stopReason adds nothing", () => {
    const chat = new Conversation("ea");
    chat.loadConversationHistory("cnv_1", "ea", [owner()]);
    expect(chat.messages).toHaveLength(1);
  });

  test("a turn that did write a reply gets no extra marker", () => {
    const chat = new Conversation("ea");
    chat.loadConversationHistory("cnv_1", "ea", [
      owner({ stopReason: "cancelled" }),
      info({ id: "a1", role: "assistant", text: "half an answer", turnID: "trn_1", sessionID: "thr_1", stopReason: "cancelled" }),
    ]);
    expect(chat.messages.map((message) => message.id)).toEqual(["m1", "a1"]);
  });

  test("the marker keeps its place when the history is loaded again", () => {
    const chat = new Conversation("ea");
    const history = [owner({ stopReason: "timeout" }), info({ id: "m2", role: "user", text: "next", turnID: "trn_2", sessionID: "thr_1" })];
    chat.loadConversationHistory("cnv_1", "ea", history);
    chat.loadConversationHistory("cnv_1", "ea", history);
    expect(chat.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(isStopped(chat.messages[1]!, "timeout")).toBe(true);
  });
});
