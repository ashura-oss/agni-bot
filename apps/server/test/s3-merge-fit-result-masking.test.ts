/**
 * Sprint 3 merge fix round 2, item 2: `fitToolResult` masks a tool result's strings before it shrinks them, never after.
 *
 * A long result is cut step by step (strings to 1000, 400, 200, then 80 characters; at last a plain cut of the whole text). A registered key
 * that straddles one of those cuts is no longer a whole value afterwards, so `storeResult`'s `redact()` could not find it and the first
 * half of the key stayed in the stored copy and in the copy the model reads.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fitToolResult } from "../src/agent/task-loop";
import { redact, registerSecret } from "../src/util/redact";
import { clearSecretsForTests } from "../src/util/redact-core";

const KEY = "sk-fit-canary-0a1b2c3d4e5f6a7b8c9d";
/** Enough of the key that seeing it means it leaked, and short enough that a cut can leave it whole-but-for-its-end. */
const LEAK = KEY.slice(0, 9);

beforeEach(() => {
  clearSecretsForTests();
  registerSecret(KEY);
});
afterEach(() => clearSecretsForTests());

/** A long string in which the key starts `inside` characters before position `cut`, so that a cut at `cut` leaves its first `inside` characters. */
function straddling(cut: number, inside = 12): string {
  return `${"a".repeat(cut - inside)}${KEY}${"b".repeat(3_000)}`;
}

describe("fitToolResult masks before it cuts", () => {
  // The max is chosen so that this level, and no earlier one, is the first that fits.
  const LEVELS: Array<[string, number, number, number]> = [
    ["the 1000-character cut", 1_000, 2_500, 1_000],
    ["the 400-character cut", 400, 500, 1_000],
    ["the 200-character cut", 200, 300, 1_000],
    ["the 80-character cut", 80, 170, 1_000],
  ];
  for (const [what, cut, max, keepChars] of LEVELS) {
    test(`a key that straddles ${what} is masked, not left half-written`, () => {
      const text = fitToolResult({ page: straddling(cut) }, max, keepChars);
      expect(text.length).toBeLessThanOrEqual(max);
      expect(JSON.parse(text)).toMatchObject({ truncated: true });
      expect(text).not.toContain(LEAK);
      expect(text).not.toContain(KEY);
    });
  }

  test("the same holds for a string inside an array inside an object", () => {
    const text = fitToolResult({ results: [{ snippet: straddling(400) }] }, 500, 1_000);
    expect(JSON.parse(text)).toMatchObject({ truncated: true });
    expect(text).not.toContain(LEAK);
  });

  test("a key that straddles the plain cut of a very wide result is masked too", () => {
    const wide: Record<string, string> = {};
    for (let i = 0; i < 60; i += 1) wide[`k${i}`] = "x".repeat(10);
    wide.secret = KEY;
    for (let i = 60; i < 120; i += 1) wide[`k${i}`] = "y".repeat(10);
    const at = JSON.stringify(wide).indexOf(KEY);
    const text = fitToolResult(wide, at + 12);
    expect(text.length).toBeLessThanOrEqual(at + 12);
    expect(text).not.toContain(LEAK);
  });

  test("a result that fits is still masked, and the result is the same JSON a plain stringify gives otherwise", () => {
    expect(fitToolResult({ note: `token ${KEY} here`, n: 1 })).toBe(JSON.stringify({ note: redact(`token ${KEY} here`), n: 1 }));
    expect(fitToolResult({ ok: true })).toBe('{"ok":true}');
    expect(fitToolResult(undefined)).toBe("null");
  });

  test("an unrelated long result is shrunk exactly as before", () => {
    const result = { results: Array.from({ length: 50 }, (_, index) => ({ url: `https://example.com/${index}`, snippet: "s".repeat(500) })) };
    const parsed = JSON.parse(fitToolResult(result)) as { truncated: boolean; result: { results: unknown[] } };
    expect(parsed.truncated).toBe(true);
    expect(parsed.result.results.at(-1)).toMatch(/more$/);
  });
});
