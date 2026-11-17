/**
 * Sprint 3 fix round 9: the placeholders that carry a lossy number's digits through the walk.
 *
 * A scanner that skips string contents swaps each number literal a double cannot hold for a placeholder string
 * made with a nonce that is fresh for every call; the document is parsed, walked, redacted and serialized, and
 * the original digit literals go back into their placeholders. If a placeholder is missing, repeated or
 * altered afterwards (a registered value that collides with the placeholder, or a parser that drops the first
 * of two equal keys), nothing is spliced: the walked value is written as it is and the precision is lost.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { REDACTED, registerSecret } from "../src/util/redact";
import { clearSecretsForTests } from "../src/util/redact-core";
import { LOSSY_PLACEHOLDER_PREFIX, redactJSONText, swapLossyNumbers } from "../src/util/redact-json";

const SECRET = "lossy-secret-Zk93-tail";
const BIG = "12345678901234567890";
/** What a double makes of `BIG`: the value after the precision is lost. */
const BIG_AS_DOUBLE = "12345678901234567000";

afterEach(() => {
  clearSecretsForTests();
});

describe("swapLossyNumbers", () => {
  test("swaps a lossy literal for a placeholder string and keeps the digits aside", () => {
    const swapped = swapLossyNumbers(`{"id":${BIG},"n":1}`);
    expect(swapped.literals).toEqual([BIG]);
    expect(swapped.text).not.toContain(BIG);
    expect(swapped.text).toContain(`"${swapped.marker}0_"`);
    expect(JSON.parse(swapped.text)).toEqual({ id: `${swapped.marker}0_`, n: 1 });
  });

  test("leaves a number a double holds exactly alone, whatever its spelling", () => {
    const text = `{"a":1.0,"b":0.1,"c":1e2,"d":-0,"e":9007199254740991,"f":1e-7}`;
    const swapped = swapLossyNumbers(text);
    expect(swapped.literals).toEqual([]);
    expect(swapped.text).toBe(text);
  });

  test("does not look inside strings, escaped quotes included", () => {
    const text = `{"a":"id ${BIG}","b":"say \\"${BIG}\\" \\\\","c":${BIG}}`;
    const swapped = swapLossyNumbers(text);
    expect(swapped.literals).toEqual([BIG]);
    expect(JSON.parse(swapped.text).a).toBe(`id ${BIG}`);
    expect(JSON.parse(swapped.text).b).toBe(`say "${BIG}" \\`);
  });

  test("numbers every lossy literal in order: a decimal, an exponent that overflows, a negative id", () => {
    const swapped = swapLossyNumbers(`[3.141592653589793238462643,1e999,-${BIG}]`);
    expect(swapped.literals).toEqual(["3.141592653589793238462643", "1e999", `-${BIG}`]);
  });

  test("the nonce is fresh for every call, so two scans of one text carry different placeholders", () => {
    const text = `{"id":${BIG}}`;
    const first = swapLossyNumbers(text);
    const second = swapLossyNumbers(text);
    expect(first.marker).not.toBe(second.marker);
    expect(first.text).not.toBe(second.text);
    expect(first.marker.startsWith(LOSSY_PLACEHOLDER_PREFIX)).toBe(true);
    expect(first.marker.length).toBeGreaterThan(LOSSY_PLACEHOLDER_PREFIX.length + 16);
  });

  test("a hundred scans give a hundred different markers", () => {
    const markers = new Set(Array.from({ length: 100 }, () => swapLossyNumbers(`[${BIG}]`).marker));
    expect(markers.size).toBe(100);
  });
});

describe("a placeholder that does not come back intact fails closed", () => {
  test("a registered value equal to the placeholder prefix alters every placeholder: no splice, the double's value is written", () => {
    registerSecret(LOSSY_PLACEHOLDER_PREFIX);
    registerSecret(SECRET);
    const out = redactJSONText(`{"id":${BIG},"token":"${SECRET}"}`);
    expect(JSON.parse(out)).toEqual({ id: Number(BIG), token: REDACTED });
    expect(out).toContain(BIG_AS_DOUBLE);
    expect(out).not.toContain(BIG);
    expect(out).not.toContain(LOSSY_PLACEHOLDER_PREFIX);
    expect(out).not.toContain("Zk93");
  });

  test("the failed splice still masks a \\u-escaped secret and a duplicate-key secret", () => {
    registerSecret(LOSSY_PLACEHOLDER_PREFIX);
    registerSecret(SECRET);
    const out = redactJSONText(`{"id":${BIG},"a":"\\u006cossy-secret-Zk93-tail","k":"${SECRET}","k":"x"}`);
    expect(out).not.toContain("Zk93");
    expect(out).not.toContain(LOSSY_PLACEHOLDER_PREFIX);
    expect(JSON.parse(out)).toEqual({ id: Number(BIG), a: REDACTED, k: "x" });
  });

  test("the same at an inner layer: only the inner document loses its precision", () => {
    registerSecret(LOSSY_PLACEHOLDER_PREFIX);
    const out = redactJSONText(`{"outer":${BIG},"body":${JSON.stringify(`{"inner":${BIG}}`)}}`);
    expect(JSON.parse(out)).toEqual({ outer: Number(BIG), body: `{"inner":${BIG_AS_DOUBLE}}` });
  });

  test("a placeholder dropped by the parser (the first of two equal keys) counts as altered", () => {
    const out = redactJSONText(`{"id":${BIG},"id":2}`);
    expect(out).toBe(`{"id":2}`);
  });

  test("with no collision the digits are exact, so the collision above is what changed the result", () => {
    registerSecret(SECRET);
    expect(redactJSONText(`{"id":${BIG},"token":"${SECRET}"}`)).toBe(`{"id":${BIG},"token":"${REDACTED}"}`);
  });
});
