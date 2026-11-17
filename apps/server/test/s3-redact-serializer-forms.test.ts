/**
 * Sprint 3 fix round 10: the escaped forms other common serializers write are masked too.
 *
 * `JSON.stringify` leaves `/`, `<`, `>`, `&` and non-ASCII text alone, so the registry matched only that. PHP writes
 * backslash-slash; Go writes `<`, `>` and `&` as backslash-u-003c and its kin (lower or upper hex); .NET adds `+`, `'`,
 * `"` and a backtick, and Gson adds `=` and `'` (each leaves the others alone); Python, PHP and .NET write non-ASCII text
 * (and Python, DEL) as backslash-u-XXXX. A secret that holds such a character, in a frame, a log line or a document that
 * came through one of them, was left unmasked. One level of escaping only: the forms are for text one serializer wrote.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { REDACTED, redact, registerSecret } from "../src/util/redact";
import { clearSecretsForTests, holdbackLength } from "../src/util/redact-core";

afterEach(() => {
  clearSecretsForTests();
});

/** One backslash. The test source never writes an escape sequence, so no tool or editor can read one into it. */
const BS = String.fromCharCode(92);
const hex = (unit: number, upper: boolean): string => {
  const digits = unit.toString(16).padStart(4, "0");
  return `${BS}u${upper ? digits.toUpperCase() : digits}`;
};
/** `text` as a serializer that escapes `/`, the tag characters and non-ASCII text writes it, in lower or upper hex. */
function escapedLike(text: string, options: { slash?: boolean; tags?: boolean; nonAscii?: boolean; upper?: boolean }): string {
  return [...text].map((ch) => {
    const unit = ch.charCodeAt(0);
    if (options.slash && ch === "/") return `${BS}/`;
    if (options.tags && "<>&".includes(ch)) return hex(unit, options.upper === true);
    if (options.nonAscii && unit > 127) return Array.from({ length: ch.length }, (_, i) => hex(ch.charCodeAt(i), options.upper === true)).join("");
    return ch;
  }).join("");
}

/**
 * `text` as a serializer writes it that escapes exactly the characters in `escaped` as backslash-u-hex and writes every
 * other character the way JSON does (a quote as backslash-quote, a backslash doubled): .NET's default encoder, Gson.
 */
function serializedWith(text: string, escaped: string, upper: boolean): string {
  return [...text].map((ch) => (escaped.includes(ch) ? hex(ch.charCodeAt(0), upper) : JSON.stringify(ch).slice(1, -1))).join("");
}

describe("a serializer's escaped forms of a secret are masked", () => {
  test("the slash form (PHP) of a secret with slashes", () => {
    const secret = "https://host.example/path/Zk93-secret";
    registerSecret(secret);
    const written = escapedLike(secret, { slash: true });
    expect(written).toContain(`${BS}/`);
    expect(redact(`{"url":"${written}"}`)).toBe(`{"url":"${REDACTED}"}`);
  });

  for (const upper of [false, true]) {
    test(`the tag characters as ${upper ? "upper" : "lower"} hex (Go, .NET) of a secret with < > &`, () => {
      const secret = "tok<en>&more-Zk93-secret";
      registerSecret(secret);
      const written = escapedLike(secret, { tags: true, upper });
      expect(written).toContain(hex(60, upper));
      expect(redact(`{"t":"${written}"}`)).toBe(`{"t":"${REDACTED}"}`);
    });

    test(`non-ASCII text as ${upper ? "upper" : "lower"} hex (Python, PHP, .NET) of a secret with accents, CJK and an emoji`, () => {
      const secret = "café-中文-😀-Zk93-secret";
      registerSecret(secret);
      const written = escapedLike(secret, { nonAscii: true, upper });
      expect(written).toContain(hex(0xe9, upper));
      expect(redact(`{"t":"${written}"}`)).toBe(`{"t":"${REDACTED}"}`);
    });
  }

  test("a serializer that writes more than one kind at once: slash and non-ASCII, tags and non-ASCII, all three", () => {
    const secret = "a/b<c>&d-café-Zk93-secret";
    registerSecret(secret);
    for (const options of [
      { slash: true, nonAscii: true },
      { tags: true, nonAscii: true, upper: true },
      { slash: true, tags: true, nonAscii: true },
      { slash: true, tags: true, nonAscii: true, upper: true },
    ]) {
      const written = escapedLike(secret, options);
      expect(redact(`x ${written} y`)).toBe(`x ${REDACTED} y`);
    }
  });

  for (const upper of [false, true]) {
    const hexCase = upper ? "upper" : "lower";

    test(`plus, quote, apostrophe and backtick as ${hexCase} hex (.NET) of a secret that also holds an equals sign`, () => {
      const secret = "ab+cd=ef'gh\"ij`kl-Zk93-secret";
      registerSecret(secret);
      const written = serializedWith(secret, "+'\"<>&`", upper);
      expect(written).toContain(hex(0x2b, upper));
      expect(written).toContain(hex(0x22, upper));
      expect(written).toContain("=");
      expect(redact(`{"t":"${written}"}`)).toBe(`{"t":"${REDACTED}"}`);
    });

    test(`equals and apostrophe as ${hexCase} hex (Gson) of a secret that also holds a plus`, () => {
      const secret = "key=val+x'y-Zk93-secret";
      registerSecret(secret);
      const written = serializedWith(secret, "=<>&'", upper);
      expect(written).toContain(hex(0x3d, upper));
      expect(written).toContain("+");
      expect(redact(`got ${written} back`)).toBe(`got ${REDACTED} back`);
    });
  }

  test("a serializer that escapes only the tag characters (Go) still matches a secret that also holds = + and a quote", () => {
    const secret = `q=a+b&c="d"-Zk93-secret`;
    registerSecret(secret);
    for (const upper of [false, true]) {
      const written = serializedWith(secret, "<>&", upper);
      expect(redact(`got ${written} back`)).toBe(`got ${REDACTED} back`);
    }
  });

  test("DEL (0x7f), which Python's ensure_ascii escapes with the non-ASCII text, as lower and upper hex", () => {
    const secret = `del${String.fromCharCode(0x7f)}char-Zk93-secret`;
    registerSecret(secret);
    for (const upper of [false, true]) {
      const written = serializedWith(secret, String.fromCharCode(0x7f), upper);
      expect(written).toContain(hex(0x7f, upper));
      expect(redact(`{"t":"${written}"}`)).toBe(`{"t":"${REDACTED}"}`);
    }
  });

  test("on top of JSON's own escaping of a quote and a backslash", () => {
    const secret = `a/"b"${BS}c<d-Zk93-secret`;
    registerSecret(secret);
    const written = escapedLike(JSON.stringify(secret).slice(1, -1), { slash: true, tags: true });
    expect(redact(`{"t":"${written}"}`)).toBe(`{"t":"${REDACTED}"}`);
  });

  test("the forms belong to the value: they go when its last holder lets go", () => {
    const secret = "tok<en>&more-Zk93-secret";
    registerSecret(secret);
    clearSecretsForTests();
    expect(redact(`{"t":"${escapedLike(secret, { tags: true })}"}`)).toContain("Zk93");
  });

  test("a secret with none of these characters registers none of these forms", () => {
    registerSecret("plain-secret-Zk93-value");
    expect(redact(`${BS}u0070lain-secret-Zk93-value`)).toContain("Zk93");
  });

  test("a stream that ends inside an escaped form holds that part back", () => {
    const secret = "tok<en>&more-Zk93-secret";
    registerSecret(secret);
    const written = escapedLike(secret, { tags: true });
    const cut = written.slice(0, written.indexOf("more"));
    expect(holdbackLength(`before ${cut}`)).toBe(cut.length);
  });
});
