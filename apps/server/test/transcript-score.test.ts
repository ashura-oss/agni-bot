import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { appendChannelMessage, createChannel } from "../src/stores/channels";
import { searchTranscripts } from "../src/stores/transcripts";

/** W2-A item 8: bm25 is negative (more negative is better), so relevance must be built from its magnitude. */

let db: Database | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
});

describe("transcript search relevance", () => {
  test("a better match scores higher, and scores are not all 1", () => {
    db = openDatabase(":memory:");
    const main = createChannel(db, { type: "main", visibility: "public", name: "Main", agentID: "ea" });
    for (let index = 0; index < 20; index += 1) {
      appendChannelMessage(db, { channelID: main.id, fromType: "user", fromID: "u", text: `unrelated chatter number ${index} about lunch and weather` });
    }
    appendChannelMessage(db, { channelID: main.id, fromType: "user", fromID: "u", text: "the quarterly invoice invoice invoice is due" });
    appendChannelMessage(db, { channelID: main.id, fromType: "user", fromID: "u", text: "one invoice among a long message that goes on about lunch and the weather and many other things besides" });

    const hits = searchTranscripts(db, { query: "invoice", callerAgentID: "ea" });
    expect(hits.length).toBe(2);
    expect(hits[0]!.text).toContain("quarterly");
    for (const hit of hits) {
      expect(hit.score).toBeGreaterThan(0);
      expect(hit.score).toBeLessThan(1);
    }
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });
});
