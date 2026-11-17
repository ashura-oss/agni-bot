/**
 * `expand` on a range of channel messages (audit M20): the time window compares
 * times, the range is bounded, and another bot's channel goes through
 * `redactForCaller` like every other path that carries a bot's text.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { createAgentPersona } from "../src/agent/creation";
import { PERSONAS } from "../src/agent/personas";
import { SUMMARY_MAX_CHARS } from "../src/agent/visibility";
import { ToolRegistry } from "../src/tools/registry";
import { registerExpandTool } from "../src/tools/expand-tool";
import { appendChannelMessage, createGroupChannel, ensureDMChannel } from "../src/stores/channels";

type Handler = { handler: (args: Record<string, unknown>, ctx: unknown) => Promise<unknown> };
type Expanded = { redacted: boolean; messages: Array<{ id: string; text: string }> };

let db: Database | undefined;
const INITIAL_ROSTER = PERSONAS.length;
afterEach(() => {
  db?.close();
  db = undefined;
  PERSONAS.length = INITIAL_ROSTER;
});

const ctx = { threadID: "thr_x", turnID: "trn_x", signal: new AbortController().signal };

function expandAs(database: Database, caller: string, args: Record<string, unknown>): Promise<Expanded> {
  const registry = new ToolRegistry();
  registerExpandTool(registry, { db: database, currentAgentID: caller });
  return (registry.get("expand") as unknown as Handler).handler(args, ctx) as Promise<Expanded>;
}

const AT = Date.parse("2026-03-01T12:00:00.000Z");
const iso = (minutesFromAnchor: number): string => new Date(AT + minutesFromAnchor * 60_000).toISOString();

/** A message in the channel at a chosen time. */
function say(database: Database, channelID: string, text: string, minutesFromAnchor: number, fromID = "user"): string {
  const row = appendChannelMessage(database, { channelID, fromType: fromID === "user" ? "user" : "agent", fromID, text });
  database.run("UPDATE channel_messages SET created_at = ? WHERE id = ?", [iso(minutesFromAnchor), row.id]);
  return row.id;
}

describe("expand(kind=messages): the time window", () => {
  test("returns the messages near the anchor and leaves out the ones far from it", async () => {
    db = openDatabase(":memory:");
    const channel = ensureDMChannel(db, "ea");
    const before = say(db, channel.id, "two minutes before", -2, "ea");
    const anchor = say(db, channel.id, "the anchor", 0);
    const after = say(db, channel.id, "three minutes after", 3, "ea");
    const far = say(db, channel.id, "an hour away", 60, "ea");

    const view = await expandAs(db, "ea", { kind: "messages", id: anchor, around: 5 });
    expect(view.messages.map((m) => m.id)).toEqual([before, anchor, after]);
    expect(view.messages.map((m) => m.id)).not.toContain(far);
  });

  test("never returns more than 50 rows, whatever the window holds", async () => {
    db = openDatabase(":memory:");
    const channel = ensureDMChannel(db, "ea");
    const anchor = say(db, channel.id, "the anchor", 0);
    for (let i = 1; i <= 80; i++) say(db, channel.id, `chatter ${i}`, 0, "ea");
    const view = await expandAs(db, "ea", { kind: "messages", id: anchor, around: 20 });
    expect(view.messages.length).toBe(50);
  });
});

describe("expand(kind=messages): another bot's channel", () => {
  const long = `${"private working detail ".repeat(30)}END-OF-WORKING`;

  function setup(visibility: "private" | "summary" | "shared") {
    db = openDatabase(":memory:");
    createAgentPersona(db, { name: "Kid", prompt: "p", visibility }, []);
    const channel = ensureDMChannel(db, "kid");
    const anchor = say(db, channel.id, long, 0, "kid");
    return { database: db, anchor, channel };
  }

  test("a summary bot's channel gives another bot one-line summaries, never the full text", async () => {
    const { database, anchor } = setup("summary");
    const view = await expandAs(database, "ea", { kind: "messages", id: anchor });
    expect(view.messages.length).toBe(1);
    expect(view.messages[0]!.text).not.toContain("END-OF-WORKING");
    expect(view.messages[0]!.text.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS + 1);
  });

  test("a private bot's channel gives another bot nothing but the fact it was redacted", async () => {
    const { database, anchor } = setup("private");
    const view = await expandAs(database, "ea", { kind: "messages", id: anchor });
    expect(view.redacted).toBe(true);
    expect(view.messages).toEqual([]);
  });

  test("the owner of the channel reads it in full", async () => {
    const { database, anchor } = setup("summary");
    const view = await expandAs(database, "kid", { kind: "messages", id: anchor });
    expect(view.redacted).toBe(false);
    expect(view.messages[0]!.text).toContain("END-OF-WORKING");
  });

  test("a shared bot's channel is readable in full by another bot", async () => {
    const { database, anchor } = setup("shared");
    const view = await expandAs(database, "ea", { kind: "messages", id: anchor });
    expect(view.messages[0]!.text).toContain("END-OF-WORKING");
  });

  test("a member of a group channel reads the owner's line in full, and a summary bot's line as one line, whoever the group's primary bot is", async () => {
    db = openDatabase(":memory:");
    createAgentPersona(db, { name: "Kid", prompt: "p", visibility: "summary" }, []);
    const group = createGroupChannel(db, "team", ["kid", "ea"]);
    const theirs = say(db, group.id, long, 0, "kid");
    const mine = say(db, group.id, long, 600);
    const kidLine = await expandAs(db, "ea", { kind: "messages", id: theirs });
    expect(kidLine.messages[0]!.text).not.toContain("END-OF-WORKING");
    expect(kidLine.messages[0]!.text.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS + 1);
    const ownerLine = await expandAs(db, "ea", { kind: "messages", id: mine });
    expect(ownerLine.messages[0]!.text).toContain("END-OF-WORKING");
  });
});
