/**
 * Sprint 3 merge fix round 1, item 5: what the owner typed is stored masked. A message can hold a key the owner pasted
 * ("use this key: ..."), and `owner_words` keeps up to 8,000 characters of it for the egress check. The key is masked before the
 * text is cut and stored; the addresses and hosts in the same message are still found, because masking changes only the secret.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { hostsNamedIn, ownerNamed } from "../src/policy/egress";
import { ownerWordsOf, recordOwnerWords } from "../src/policy/owner-words";
import { createThread } from "../src/stores/threads";
import { registerSecret } from "../src/util/redact";

const KEY = "sk-owner-canary-5e4d3c2b1a0f9e8d7c6b";
let db: Database;
let threadID = "";
beforeEach(() => {
  db = openDatabase(":memory:");
  threadID = createThread(db, "ea").id;
  registerSecret(KEY);
});
afterEach(() => db.close());

const stored = (): string => db.query<{ text: string }, [string]>("SELECT text FROM owner_words WHERE thread_id = ?").all(threadID).map((row) => row.text).join("\n");

describe("owner_words holds the owner's message with a saved secret masked", () => {
  test("a key in the message is not in the table", () => {
    recordOwnerWords(db, threadID, `use this key for the API: ${KEY}`);
    expect(stored()).not.toContain(KEY);
    expect(stored()).toContain("use this key for the API: [redacted]");
  });

  test("a key that straddles the 8,000-character cut leaves no part of itself", () => {
    recordOwnerWords(db, threadID, `${"a ".repeat(3_990)}${KEY} and more after it`);
    expect(stored()).not.toContain(KEY.slice(0, 12));
    expect(stored().length).toBeLessThanOrEqual(8_000);
  });

  test("the addresses and sites in the same message are still named", () => {
    recordOwnerWords(db, threadID, `mail ann@example.com about https://docs.example.org/guide, the key is ${KEY}`);
    const words = ownerWordsOf(db, threadID);
    expect(hostsNamedIn(words).has("docs.example.org")).toBe(true);
    const run = { ownerText: words };
    expect(ownerNamed(run, { kind: "recipient", value: "ann@example.com" }, [])).toBe(true);
    expect(ownerNamed(run, { kind: "host", value: "docs.example.org" }, [])).toBe(true);
    expect(ownerNamed(run, { kind: "recipient", value: "eve@evil.example" }, [])).toBe(false);
  });

  test("a message with no secret is stored as it was written (trimmed)", () => {
    recordOwnerWords(db, threadID, "  hello there  ");
    expect(ownerWordsOf(db, threadID)).toEqual(["hello there"]);
  });
});
