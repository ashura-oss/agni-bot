/**
 * Sprint 3 fix round 10: at the depth where `redactJSONText` stops opening JSON inside strings, text that
 * parses as JSON is withheld, not masked as plain text. Plain-text masking misses a `\u`-escaped secret, so
 * anyone able to wrap a document in six string layers could carry one through.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { REDACTED, registerSecret } from "../src/util/redact";
import { clearSecretsForTests } from "../src/util/redact-core";
import { redactJSONText } from "../src/util/redact-json";

const SECRET = "depth-secret-Zk93-tail";
/** The secret written with a `\u` escape for its first letter: a JSON reader sees the secret, the raw text does not contain it. */
const ESCAPED = String.fromCharCode(92) + "u0064epth-secret-Zk93-tail";

afterEach(() => {
  clearSecretsForTests();
});

/** `inner` as a string inside `layers` levels of JSON string: `redactJSONText` meets it at depth `layers`. */
function wrapped(inner: string, layers: number): string {
  let text = inner;
  for (let i = 0; i < layers; i++) text = JSON.stringify(text);
  return text;
}

/** What a JSON reader sees after opening `layers` string layers. */
function unwrapped(text: string, layers: number): unknown {
  let value: unknown = text;
  for (let i = 0; i < layers; i++) value = JSON.parse(value as string);
  return value;
}

describe("JSON at the depth limit is withheld", () => {
  for (const layers of [5, 6, 7, 8]) {
    test(`an escaped secret in an object ${layers} string layers deep does not come out`, () => {
      registerSecret(SECRET);
      const inner = `{"k":"${ESCAPED}"}`;
      expect(JSON.parse(inner).k).toBe(SECRET);
      const out = redactJSONText(wrapped(inner, layers));
      expect(out).not.toContain("Zk93");
      expect(out).not.toContain("secret");
    });
  }

  test("an escaped secret that is itself a string layer at the limit is gone too", () => {
    registerSecret(SECRET);
    const out = redactJSONText(wrapped(`"${ESCAPED}"`, 6));
    expect(out).not.toContain("Zk93");
  });

  test("at the limit the JSON is replaced by the mask, as a string", () => {
    registerSecret(SECRET);
    const out = redactJSONText(wrapped(`{"k":"${ESCAPED}"}`, 6));
    expect(unwrapped(out, 6)).toBe(REDACTED);
  });

  test("text that is not JSON at the limit is still masked as plain text and kept", () => {
    registerSecret(SECRET);
    const out = redactJSONText(wrapped(`note: ${SECRET} and more`, 6));
    expect(unwrapped(out, 6)).toBe(`note: ${REDACTED} and more`);
  });

  test("a harmless document above the limit is walked and kept", () => {
    registerSecret(SECRET);
    const out = redactJSONText(wrapped(JSON.stringify({ a: 1, b: ["x"] }), 5));
    expect(JSON.parse(unwrapped(out, 5) as string)).toEqual({ a: 1, b: ["x"] });
  });
});
