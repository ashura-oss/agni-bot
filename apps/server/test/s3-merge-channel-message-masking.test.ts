/**
 * Sprint 3 merge fix round 3, item 1: the text of a channel message is stored masked. The owner can paste a saved key into chat
 * ("use this key: ..."), and a bot can echo it back; the row, the search index over the rows, the database file and its
 * write-ahead log must never hold the plaintext.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { appendChannelMessage, ensureDMChannel, listChannelMessages } from "../src/stores/channels";
import { registerSecret } from "../src/util/redact";

const KEY = "sk-chat-canary-7a6b5c4d3e2f1a0b9c8d";
let db: Database;
let channelID = "";
beforeEach(() => {
  db = openDatabase(":memory:");
  channelID = ensureDMChannel(db, "ea").id;
  registerSecret(KEY);
});
afterEach(() => db.close());

const allText = (): string => db.query<{ text: string }, []>("SELECT text FROM channel_messages").all().map((row) => row.text).join("\n");
const searchHits = (term: string): number =>
  db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM channel_messages_fts WHERE channel_messages_fts MATCH ?").get(term)!.n;

describe("channel_messages.text is masked at write time", () => {
  test("the owner's message with a saved key is stored with the key masked", () => {
    const row = appendChannelMessage(db, { channelID, fromType: "user", fromID: "dev1", text: `use this key: ${KEY} for the API` });
    expect(allText()).not.toContain(KEY);
    expect(allText()).toContain("use this key: [redacted] for the API");
    expect(row.text).not.toContain(KEY);
    expect(listChannelMessages(db, channelID).map((message) => message.text).join("\n")).not.toContain(KEY);
  });

  test("a bot reply that echoes the key is stored masked", () => {
    appendChannelMessage(db, { channelID, fromType: "agent", fromID: "ea", text: `You gave me ${KEY}, thanks.` });
    expect(allText()).not.toContain(KEY);
    expect(allText()).toContain("You gave me [redacted], thanks.");
  });

  test("the search index never sees the key, and still finds the words around it", () => {
    appendChannelMessage(db, { channelID, fromType: "user", fromID: "dev1", text: `remember the zebrafish setup ${KEY}` });
    expect(searchHits('"sk-chat-canary-7a6b5c4d3e2f1a0b9c8d"')).toBe(0);
    expect(searchHits("canary")).toBe(0);
    expect(searchHits("zebrafish")).toBe(1);
    expect(searchHits("redacted")).toBe(1);
  });

  test("a message with no secret is stored as written", () => {
    appendChannelMessage(db, { channelID, fromType: "user", fromID: "dev1", text: "  plain words, nothing to hide  " });
    expect(allText()).toBe("  plain words, nothing to hide  ");
  });
});
