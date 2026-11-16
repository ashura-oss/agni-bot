import { describe, expect, test } from "vitest";
import { safeLine, safeText } from "../src";

// Invisible characters are built from code points so no hidden character sits in this file.
const RLO = String.fromCodePoint(0x202e);
const ZWSP = String.fromCodePoint(0x200b);
const BEL = String.fromCodePoint(7);
const TAG_A = String.fromCodePoint(0xe0041);

describe("safe text for cards", () => {
  test("shows control, bidi and invisible characters as visible escapes", () => {
    expect(safeLine("rm -rf /\nnext")).toBe("rm -rf /\\nnext");
    expect(safeLine("a" + RLO + "b")).toBe("a\\u202Eb");
    expect(safeLine("x" + ZWSP + "y")).toBe("x\\u200By");
    expect(safeLine("tab\there\r")).toBe("tab\\there\\r");
    expect(safeLine("\u{E0041}")).toBe("\\u{E0041}");
    expect(safeLine("bell\u0007")).toBe("bell\\u0007");
  });

  test("leaves ordinary text, including other scripts and emoji, alone", () => {
    expect(safeLine("café 東京 🙂 <b>bold</b> **x** [a](b)")).toBe("café 東京 🙂 <b>bold</b> **x** [a](b)");
  });

  test("caps a long entry and says how much is missing", () => {
    const long = "a".repeat(500);
    expect(safeLine(long, 320)).toBe(`${"a".repeat(320)}… (+180 chars)`);
    expect(safeLine("short", 320)).toBe("short");
  });

  test("safeText keeps line breaks, and is idempotent", () => {
    expect(safeText("one\ntwo" + RLO + "")).toBe("one\ntwo\\u202E");
    const once = safeLine("a" + RLO + "b\nc");
    expect(safeLine(once)).toBe(once);
  });
});
