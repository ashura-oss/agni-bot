/**
 * Sprint 2 security round, item 1: every owner-facing card field goes through the card text escape.
 * A page title or a sender name is outside text; it must not add a line, reorder what the owner reads,
 * or hide behind zero-width characters, on the frame, in the saved card_meta, or on a replay.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { ApprovalSourceSchema, type ServerFrameBody } from "@agni/protocol";
import { ApprovalBroker } from "../src/agent/approval-broker";
import { loadCardMeta, saveCardMeta } from "../src/agent/pending-cards";
import { openDatabase } from "../src/db";
import type { ApprovalCard } from "../src/policy/types";
import { addApprovalRule } from "../src/stores/approval-rules";
import { startHarness, type Harness } from "./ws-harness";

let db: Database | undefined;
let harness: Harness | undefined;
afterEach(async () => {
  db?.close(); db = undefined;
  await harness?.stop(); harness = undefined;
});

const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/;

const TITLES: Array<[string, string]> = [
  ["a newline", "Weekly report\nRisk: nothing at all, safe to allow"],
  ["a bidi override", "invoice \u202Efdp.exe"],
  ["a zero-width space", "pay\u200Bpal.com"],
];

function cardWith(label: string): ApprovalCard {
  return {
    tier: 2, risk: "egress", verb: "send an email", canRemember: false, unnamedDestinations: [], resources: [], operation: "send",
    sources: [{ kind: "web", label, at: "2026-11-16T10:00:00Z" }, { kind: "email", label, at: "2026-11-16T10:00:00Z" }, { kind: "peer", label, at: "2026-11-16T10:00:00Z" }],
  };
}

function brokerFor(database: Database): { broker: ApprovalBroker; frames: Array<Extract<ServerFrameBody, { type: "approval.request" }>> } {
  const frames: Array<Extract<ServerFrameBody, { type: "approval.request" }>> = [];
  const broker = new ApprovalBroker({
    db: database,
    emit: (frame) => { frames.push(frame as Extract<ServerFrameBody, { type: "approval.request" }>); },
    waitForDecision: async () => "reject",
  });
  return { broker, frames };
}

describe("a source label from outside text is shown as visible escapes", () => {
  for (const [name, title] of TITLES) {
    test(`${name} in a page title cannot change the card, the frame or the saved meta`, async () => {
      db = openDatabase(":memory:");
      const { broker, frames } = brokerFor(db);
      await broker.request("thr", "trn", "mail_send", "call_1", { to: ["x@y.z"], subject: "s", body: "b" }, new AbortController().signal, { card: cardWith(title), agentID: "ea", botName: "Ava" });
      const frame = frames[0]!;
      for (const source of frame.source!) {
        expect(source.label).not.toMatch(UNSAFE);
        expect(ApprovalSourceSchema.safeParse(source).success).toBe(true);
      }
      // The card's own lead lines are the only lines that start with these words.
      const leadLines = frame.preview.split("\n").filter((line) => line.startsWith("Risk:"));
      expect(leadLines).toHaveLength(1);
      // Source line, risk line and the "always" line: the title added no line of its own.
      expect(frame.preview.split("\n\n")[0]!.split("\n")).toHaveLength(3);
      expect(frame.preview).not.toMatch(new RegExp("[\u202e\u200b\u2028]"));
      const saved = loadCardMeta(db, frame.requestID);
      for (const source of saved!.source!) expect(source.label).not.toMatch(UNSAFE);
      const raw = db.query<{ card_meta: string }, [string]>("SELECT card_meta FROM approvals WHERE id = ?").get(frame.requestID)!.card_meta;
      expect(raw).not.toMatch(/[\u202e\u200b]/);
    });
  }

  test("a long escaped label still fits the protocol's 300 characters", async () => {
    db = openDatabase(":memory:");
    const { broker, frames } = brokerFor(db);
    await broker.request("thr", "trn", "mail_send", "call_1", { to: ["x@y.z"], subject: "s", body: "b" }, new AbortController().signal, { card: cardWith("\u202E".repeat(300)), agentID: "ea" });
    for (const source of frames[0]!.source!) {
      expect(source.label!.length).toBeLessThanOrEqual(300);
      expect(source.label).not.toContain("\u202E");
    }
  });

  test("a card saved with raw characters (an older row, or a damaged one) is cleaned when it is replayed", () => {
    db = openDatabase(":memory:");
    db.run("INSERT INTO approvals (id, thread_id, turn_id, action, preview, status, created_at) VALUES ('apr_x', 't', 'u', 'a', 'p', 'pending', ?)", [new Date().toISOString()]);
    saveCardMeta(db, "apr_x", { source: [{ kind: "web", label: "a\nb\u202Ec" }], expiresAt: "soon\nRisk: none", tier: 2 });
    const meta = loadCardMeta(db, "apr_x")!;
    expect(meta.source![0]!.label).not.toMatch(UNSAFE);
    // An expiry that is not a time is not shown at all.
    expect(meta.expiresAt).toBeUndefined();
  });

  test("a good expiry survives the replay", () => {
    db = openDatabase(":memory:");
    db.run("INSERT INTO approvals (id, thread_id, turn_id, action, preview, status, created_at) VALUES ('apr_y', 't', 'u', 'a', 'p', 'pending', ?)", [new Date().toISOString()]);
    const when = new Date(Date.now() + 600_000).toISOString();
    saveCardMeta(db, "apr_y", { expiresAt: when });
    expect(loadCardMeta(db, "apr_y")!.expiresAt).toBe(when);
  });
});

describe("a rule summary the owner reads is escaped too", () => {
  test("the rules list shows a target with its hidden characters as escapes", async () => {
    harness = await startHarness();
    addApprovalRule(harness.db, { agentID: "ea", toolName: "mcp_files_delete", target: "c:/x/\u200By.txt" });
    const client = await harness.connect();
    client.send({ type: "approval.rules.list" });
    const answer = await client.next("approval.rules.list.ok");
    for (const rule of answer.rules) {
      expect(rule.target).not.toMatch(UNSAFE);
      expect(rule.toolName).not.toMatch(UNSAFE);
    }
  });
});
