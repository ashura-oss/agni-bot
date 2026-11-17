/**
 * S2-6: the approval card in the reducer. A card the server marked `truncated` cannot be allowed
 * until its full text was opened; a refused Allow gives the card back; the expiry reads as words.
 */
import { describe, expect, test } from "vitest";
import {
  Conversation,
  allowLocked,
  answerNeedsFullText,
  expiryOf,
  type IncomingFrame,
} from "../src";

function wire(object: Record<string, unknown>): IncomingFrame {
  return object as unknown as IncomingFrame;
}

function request(extra: Record<string, unknown> = {}): IncomingFrame {
  return wire({
    type: "approval.request",
    seq: 10,
    requestID: "apr_long",
    action: "run a command",
    preview: "line one\nline two",
    buttons: ["once", "reject"],
    ...extra,
  });
}

describe("approval.request fields", () => {
  test("a card carries what the server sent: truncated, expiry, tier and source", () => {
    const conversation = new Conversation("ea");
    const source = [{ kind: "web", label: "example.com/offers" }];
    conversation.apply(request({ truncated: true, expiresAt: "2026-11-17T10:00:00.000Z", tier: 2, source }));
    const row = conversation.openApprovals[0]!;
    expect(row.truncated).toBe(true);
    expect(row.expiresAt).toBe("2026-11-17T10:00:00.000Z");
    expect(row.tier).toBe(2);
    expect(row.source).toEqual(source);
    expect(row.full?.state).toBe("idle");
  });

  test("a card from an older server has none of them and is never locked", () => {
    const conversation = new Conversation("ea");
    conversation.apply(request());
    const row = conversation.openApprovals[0]!;
    expect(row.truncated).toBe(false);
    expect(row.expiresAt).toBeNull();
    expect(allowLocked(row)).toBe(false);
  });
});

describe("Allow is locked until the full text is open", () => {
  test("a truncated card is locked; Deny is never locked", () => {
    const conversation = new Conversation("ea");
    conversation.apply(request({ truncated: true }));
    const row = conversation.openApprovals[0]!;
    expect(allowLocked(row)).toBe(true);
    expect(answerNeedsFullText(row, "once")).toBe(true);
    expect(answerNeedsFullText(row, "always")).toBe(true);
    expect(answerNeedsFullText(row, "reject")).toBe(false);
  });

  test("asking for the full text marks the card loading, and still locked", () => {
    const conversation = new Conversation("ea");
    conversation.apply(request({ truncated: true }));
    conversation.beginApprovalFull("apr_long");
    const row = conversation.openApprovals[0]!;
    expect(row.full?.state).toBe("loading");
    expect(allowLocked(row)).toBe(true);
  });

  test("approval.full.ok shows the returned text and unlocks Allow", () => {
    const conversation = new Conversation("ea");
    conversation.apply(request({ truncated: true }));
    conversation.beginApprovalFull("apr_long");
    conversation.apply(wire({ type: "approval.full.ok", seq: 11, requestID: "apr_long", text: "the whole call\nsecond line" }));
    const row = conversation.openApprovals[0]!;
    expect(row.full).toEqual({ state: "open", text: "the whole call\nsecond line", cut: false });
    expect(allowLocked(row)).toBe(false);
    expect(row.notice).toBeNull();
  });

  test("a full text that was itself cut keeps Allow locked", () => {
    const conversation = new Conversation("ea");
    conversation.apply(request({ truncated: true }));
    conversation.apply(wire({ type: "approval.full.ok", seq: 11, requestID: "apr_long", text: "x".repeat(10), cut: true }));
    const row = conversation.openApprovals[0]!;
    expect(row.full?.cut).toBe(true);
    expect(allowLocked(row)).toBe(true);
  });

  test("a full text for a card this chat does not hold changes nothing", () => {
    const conversation = new Conversation("ea");
    conversation.apply(request({ truncated: true }));
    expect(() => conversation.apply(wire({ type: "approval.full.ok", seq: 11, requestID: "apr_other", text: "x" }))).not.toThrow();
    expect(allowLocked(conversation.openApprovals[0]!)).toBe(true);
  });

  test("a full text that failed to load leaves the card locked and says so", () => {
    const conversation = new Conversation("ea");
    conversation.apply(request({ truncated: true }));
    conversation.beginApprovalFull("apr_long");
    conversation.failApprovalFull("apr_long");
    const row = conversation.openApprovals[0]!;
    expect(row.full?.state).toBe("failed");
    expect(allowLocked(row)).toBe(true);
    expect(row.notice).toMatch(/Could not load the full text/);
  });

  test("a card that is replaced by the server's re-send starts locked again", () => {
    const conversation = new Conversation("ea");
    conversation.apply(request({ truncated: true }));
    conversation.apply(wire({ type: "approval.full.ok", seq: 11, requestID: "apr_long", text: "whole" }));
    conversation.apply(request({ truncated: true }));
    expect(allowLocked(conversation.openApprovals[0]!)).toBe(true);
  });
});

describe("a refused Allow gives the card back", () => {
  test("reopening a card that was answered shows it again, locked, with the reason", () => {
    const conversation = new Conversation("ea");
    conversation.apply(request({ truncated: true }));
    conversation.apply(wire({ type: "approval.full.ok", seq: 11, requestID: "apr_long", text: "whole" }));
    conversation.resolveApproval("apr_long", "once");
    expect(conversation.openApprovals).toHaveLength(0);

    conversation.reopenApproval("apr_long");
    const row = conversation.openApprovals[0]!;
    expect(row.decision).toBeNull();
    expect(allowLocked(row)).toBe(true);
    expect(row.full?.state).toBe("idle");
    expect(row.notice).toMatch(/open the full text/i);
  });

  test("reopening a card the server has closed does nothing", () => {
    const conversation = new Conversation("ea");
    conversation.apply(request({ truncated: true }));
    conversation.resolveApproval("apr_long", "once");
    conversation.apply(wire({ type: "approval.closed", seq: 12, requestID: "apr_long", kind: "approval", reason: "decided" }));
    conversation.reopenApproval("apr_long");
    expect(conversation.openApprovals).toHaveLength(0);
  });
});

describe("expiry", () => {
  const now = Date.parse("2026-11-17T10:00:00.000Z");
  test("says minutes while there are more than one", () => {
    expect(expiryOf("2026-11-17T10:09:00.000Z", now)).toMatchObject({ kind: "left", text: "Expires in 9 min" });
    expect(expiryOf("2026-11-17T10:01:30.000Z", now)).toMatchObject({ kind: "left", text: "Expires in 2 min" });
  });
  test("says under 1 min in the last minute", () => {
    expect(expiryOf("2026-11-17T10:00:50.000Z", now)).toMatchObject({ kind: "left", text: "Expires in under 1 min" });
  });
  test("a time already past is expired at once; a missing or unreadable one shows nothing", () => {
    expect(expiryOf("2026-11-17T09:59:00.000Z", now)).toEqual({ kind: "expired" });
    expect(expiryOf(undefined, now)).toEqual({ kind: "none" });
    expect(expiryOf("not a time", now)).toEqual({ kind: "none" });
  });
});
