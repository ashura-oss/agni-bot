/**
 * Sprint 3 fix round 7: redaction of serialized text, the registry half.
 *
 * A secret that holds a quote, a backslash or a control character is not the same text once it is inside
 * a JSON string, and inside a JSON string that is itself inside a JSON document (a tool's args, a result)
 * it is changed a second time. The registry masks the raw value and both escaped forms, with the same
 * holders, queue and staging as the value. (The shared document half is `s3-share-document-fields.test.ts`.)
 */
import { afterEach, describe, expect, test } from "bun:test";
import { RETIRED_PER_SLOT, REDACTED, holdbackLength, redact, registerSecret, rememberSecretsAt, secretCount } from "../src/util/redact";
import { clearSecretsForTests, unregisterSecret } from "../src/util/redact-core";
import { StreamRedactor } from "../src/util/redact-stream";

/** A secret with the three kinds of character JSON escapes: a quote, a backslash and a newline. */
const AWKWARD = 'pa"ss\wd\nZk93-tail-xyz';

/** `JSON.stringify(text)` without its two quotes: how `text` looks inside a JSON string. */
const escaped = (text: string): string => JSON.stringify(text).slice(1, -1);
const escapedTwice = (text: string): string => escaped(escaped(text));

afterEach(() => {
  clearSecretsForTests();
});

describe("the registry masks a value's JSON-escaped forms, one and two levels deep", () => {
  test("the form one level deep (a secret inside a JSON string)", () => {
    registerSecret(AWKWARD);
    expect(escaped(AWKWARD)).not.toBe(AWKWARD);
    expect(redact(`{"k":"${escaped(AWKWARD)}"}`)).toBe(`{"k":"${REDACTED}"}`);
  });

  test("the form two levels deep (a secret inside JSON text that is itself inside a JSON string)", () => {
    registerSecret(AWKWARD);
    expect(escapedTwice(AWKWARD)).not.toBe(escaped(AWKWARD));
    expect(redact(`{"k":"${escapedTwice(AWKWARD)}"}`)).toBe(`{"k":"${REDACTED}"}`);
  });

  test("a frame that carries tool args as a string leaks nothing once serialized", () => {
    registerSecret(AWKWARD);
    const args = JSON.stringify({ token: AWKWARD });
    const frame = JSON.stringify({ type: "tool", args });
    expect(frame).not.toContain("Zk93-tail-xyz\\\\");
    const out = redact(frame);
    expect(out).not.toContain("Zk93");
    expect(JSON.parse(out).type).toBe("tool");
  });

  test("a value with nothing to escape adds no extra form (its forms are the same as before)", () => {
    registerSecret("plain-key-without-specials-77");
    expect(redact("x plain-key-without-specials-77 y")).toBe(`x ${REDACTED} y`);
    expect(secretCount()).toBe(1);
  });

  test("a trimmed value (read from a file) is masked in its escaped forms too", () => {
    registerSecret('tok"en\\value-with-newline\n');
    const trimmed = 'tok"en\\value-with-newline';
    expect(redact(escaped(trimmed))).toBe(REDACTED);
    expect(redact(escapedTwice(trimmed))).toBe(REDACTED);
  });

  test("the escaped forms are held and released with the value: gone with the last holder", () => {
    registerSecret(AWKWARD);
    expect(redact(escapedTwice(AWKWARD))).toBe(REDACTED);
    unregisterSecret(AWKWARD);
    expect(redact(escapedTwice(AWKWARD))).toBe(escapedTwice(AWKWARD));
    expect(redact(escaped(AWKWARD))).toBe(escaped(AWKWARD));
    expect(secretCount()).toBe(0);
  });

  test("a slot that replaces the value keeps both escaped forms masked while queued, and drops them with it", () => {
    rememberSecretsAt("conn", AWKWARD);
    rememberSecretsAt("conn", "replacement-token-0000");
    expect(redact(escapedTwice(AWKWARD))).toBe(REDACTED);
    expect(redact(escaped(AWKWARD))).toBe(REDACTED);
    for (let i = 1; i <= RETIRED_PER_SLOT + 1; i += 1) rememberSecretsAt("conn", `replacement-token-${String(i).padStart(4, "0")}`);
    expect(redact(escapedTwice(AWKWARD))).toBe(escapedTwice(AWKWARD));
    expect(redact(escaped(AWKWARD))).toBe(escaped(AWKWARD));
    // Counted per value, not per form: the live value and the full queue, no more.
    expect(secretCount()).toBe(RETIRED_PER_SLOT + 1);
  });
});

describe("stream redaction", () => {
  const streamed = (text: string, cut: number): string => {
    const stream = new StreamRedactor();
    return stream.push("k", text.slice(0, cut)) + stream.push("k", text.slice(cut)) + stream.flush("k");
  };

  test("a secret in either escaped form is masked whichever way a chunk boundary falls", () => {
    registerSecret(AWKWARD);
    for (const form of [escaped(AWKWARD), escapedTwice(AWKWARD)]) {
      const text = `before ${form} after`;
      for (let cut = 0; cut <= text.length; cut += 1) {
        expect(streamed(text, cut)).toBe(`before ${REDACTED} after`);
      }
    }
  });

  test("the holdback covers the start of the longest form", () => {
    registerSecret(AWKWARD);
    const form = escapedTwice(AWKWARD);
    expect(holdbackLength(`text ${form.slice(0, form.length - 1)}`)).toBe(form.length - 1);
  });
});

