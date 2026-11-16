/**
 * Carried from Sprint 1: characters that draw nothing but can still pad, hide or reorder what the
 * owner reads on a card are shown as visible escapes. This round adds the Hangul fillers, the
 * combining grapheme joiner and the variation selectors.
 */
import { describe, expect, test } from "bun:test";
import { entry, escapeUnsafe, quoted } from "../src/agent/card-text";

const HIDDEN: Array<[string, string]> = [
  ["U+115F", "ᅟ"], ["U+1160", "ᅠ"], ["U+3164", "ㅤ"], ["U+FFA0", "ﾠ"],
  ["U+034F", "͏"],
  ["U+FE00", "︀"], ["U+FE0F", "️"],
  ["U+E0100", "\u{e0100}"], ["U+E01EF", "\u{e01ef}"],
];

describe("characters that draw nothing are escaped on a card", () => {
  for (const [name, ch] of HIDDEN) {
    test(`${name} is shown as an escape, never as itself`, () => {
      const shown = escapeUnsafe(`pay${ch}ment`);
      expect(shown).not.toContain(ch);
      expect(shown).toMatch(/pay\\u\{?[0-9A-F]+\}?ment/);
      expect(entry(`a${ch}b`)).not.toContain(ch);
      expect(quoted(`a${ch}b`, 200)).not.toContain(ch);
    });
  }

  test("a run of fillers cannot push the real text out of sight", () => {
    const padded = `safe${"ㅤ".repeat(200)}rm -rf /`;
    const shown = escapeUnsafe(padded);
    expect(shown).not.toContain("ㅤ");
    expect(shown).toContain("rm -rf /");
  });

  test("ordinary text, accents, emoji without a selector and non-Latin scripts are untouched", () => {
    for (const text of ["café", "naïve façade", "日本語のテキスト", "한국어 텍스트", "plain ascii", "👍"]) expect(escapeUnsafe(text)).toBe(text);
  });
});
