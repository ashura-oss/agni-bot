/**
 * S2-08: approval cards expire after 10 minutes in chat and 30 in a
 * background job, expiry is a denial and is audited, and a card keeps the
 * source / tier / expiry the engine gave it so a replay shows the same card.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { ServerFrameBody } from "@agni/protocol";
import { openDatabase } from "../src/db";
import {
  BACKGROUND_OWNER_WAIT_MS,
  OWNER_WAIT_CEILING_MS,
  cardExpiresAt,
  expireCard,
  loadCardMeta,
  ownerWaitMsFor,
  saveCardMeta,
} from "../src/agent/pending-cards";
import { setAuditSink, type AuditEvent } from "../src/policy/audit-sink";

let db: Database;
let events: AuditEvent[];

beforeEach(() => {
  db = openDatabase(":memory:");
  events = [];
  setAuditSink({ record: (event) => { events.push(event); } });
});

afterEach(() => {
  setAuditSink({ record() {} });
  db.close();
});

function pendingCard(id = "apr_1"): string {
  db.run("INSERT INTO approvals (id, action, preview, status, created_at) VALUES (?, 'a', 'p', 'pending', ?)", [id, new Date().toISOString()]);
  return id;
}

describe("how long a card waits", () => {
  test("chat stays 10 minutes and a background job gets 30", () => {
    expect(OWNER_WAIT_CEILING_MS).toBe(600_000);
    expect(BACKGROUND_OWNER_WAIT_MS).toBe(1_800_000);
    expect(ownerWaitMsFor(false)).toBe(600_000);
    expect(ownerWaitMsFor(true)).toBe(1_800_000);
  });

  test("expiresAt is that long after the card is raised", () => {
    const from = Date.parse("2026-11-16T12:00:00.000Z");
    expect(cardExpiresAt(false, from)).toBe("2026-11-16T12:10:00.000Z");
    expect(cardExpiresAt(true, from)).toBe("2026-11-16T12:30:00.000Z");
  });
});

describe("what a card remembers", () => {
  test("source, tier, expiry and truncated come back as they were saved", () => {
    const id = pendingCard();
    const meta = { source: [{ kind: "web" as const, label: "example.com/offers" }], tier: 2 as const, expiresAt: "2026-11-16T12:10:00.000Z", truncated: true };
    saveCardMeta(db, id, meta);
    expect(loadCardMeta(db, id)).toEqual(meta);
  });

  test("a card with nothing saved has no meta, and an unknown card has none", () => {
    expect(loadCardMeta(db, pendingCard())).toBeNull();
    expect(loadCardMeta(db, "apr_missing")).toBeNull();
  });

  test("damaged or foreign meta is dropped field by field, never trusted", () => {
    const id = pendingCard();
    db.run("UPDATE approvals SET card_meta = ? WHERE id = ?", [JSON.stringify({ source: [{ kind: "carrier-pigeon" }, { kind: "email", label: "from a@b.c" }], tier: 9, expiresAt: 5, truncated: "yes" }), id]);
    expect(loadCardMeta(db, id)).toEqual({ source: [{ kind: "email", label: "from a@b.c" }] });
    db.run("UPDATE approvals SET card_meta = ? WHERE id = ?", ["{not json", id]);
    expect(loadCardMeta(db, id)).toBeNull();
  });
});

describe("expiry is a denial and is recorded", () => {
  test("an expired card closes as expired, tells clients, and is audited", () => {
    const id = pendingCard();
    const frames: ServerFrameBody[] = [];
    expireCard(db, "approval", id, "expired", (frame) => frames.push(frame));
    expect(db.query<{ status: string }, [string]>("SELECT status FROM approvals WHERE id = ?").get(id)!.status).toBe("expired");
    expect(frames).toEqual([{ type: "approval.closed", requestID: id, kind: "approval", reason: "expired" }]);
    expect(events).toEqual([{ kind: "approval.expired", actor: "system", detail: { requestID: id, kind: "approval", reason: "expired" } }]);
  });

  test("a card that was already answered is left alone and nothing is recorded", () => {
    const id = pendingCard();
    db.run("UPDATE approvals SET status = 'decided', decision = 'once' WHERE id = ?", [id]);
    const frames: ServerFrameBody[] = [];
    expireCard(db, "approval", id, "expired", (frame) => frames.push(frame));
    expect(frames).toEqual([]);
    expect(events).toEqual([]);
  });

  test("a card closed because its turn was cancelled is recorded as cancelled", () => {
    const id = pendingCard();
    expireCard(db, "approval", id, "cancelled", () => undefined);
    expect(events[0]).toMatchObject({ kind: "approval.cancelled", detail: { requestID: id } });
  });

  test("a failing audit sink never keeps a dead card open", () => {
    const id = pendingCard();
    setAuditSink({ record() { throw new Error("audit down"); } });
    expect(() => expireCard(db, "approval", id, "expired", () => undefined)).not.toThrow();
    expect(db.query<{ status: string }, [string]>("SELECT status FROM approvals WHERE id = ?").get(id)!.status).toBe("expired");
  });
});
