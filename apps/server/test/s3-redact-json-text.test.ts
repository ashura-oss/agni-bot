/**
 * Sprint 3 fix round 8: `redactJSONText` never returns the raw text of input that parses as JSON.
 *
 * `JSON.parse` keeps only the last of duplicate keys, so a walk of the parsed value never sees the first
 * value, and returning the raw text "because nothing was masked" put that value on disk. Whenever the parser
 * and the raw bytes can disagree, the raw bytes are not safe to return. Parsed JSON is re-serialized from the
 * walked value, every time; input with a number that would not survive the round trip (an id above 2^53) is
 * masked as plain text instead, so the digits stay exact.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { maskedDocument } from "../src/share/document";
import type { ShareDocument, ShareRecord } from "../src/share/render";
import { REDACTED, registerSecret } from "../src/util/redact";
import { clearSecretsForTests } from "../src/util/redact-core";
import { redactJSONText } from "../src/util/redact-json";

const SECRET = "dupkey-secret-Zk93-tail";
const BIG = "12345678901234567890";

afterEach(() => {
  clearSecretsForTests();
});

function toolRecord(overrides: Partial<ShareRecord> = {}): ShareRecord {
  return { id: "tc_1", kind: "tool", at: "2026-11-17T00:00:01.000Z", toolName: "search", args: "{}", result: "ok", ok: true, ...overrides };
}

function documentOf(...records: ShareRecord[]): ShareDocument {
  return { title: "Export", agentName: "Agent", agentID: "agt_1", conversationID: "cnv_1", createdAt: "2026-11-17T00:00:00.000Z", records };
}

describe("a duplicate key cannot carry a secret past the walk", () => {
  test("the first of two equal keys holds the secret and the walk masks nothing: the secret is gone", () => {
    registerSecret(SECRET);
    const out = redactJSONText(`{"k":"${SECRET}","k":"x"}`);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain("Zk93");
    expect(JSON.parse(out)).toEqual({ k: "x" });
  });

  test("the same inside an array of objects", () => {
    registerSecret(SECRET);
    const out = redactJSONText(`[{"a":1},{"k":"${SECRET}","k":"x"}]`);
    expect(out).not.toContain("Zk93");
    expect(JSON.parse(out)).toEqual([{ a: 1 }, { k: "x" }]);
  });

  test("inside a JSON string that is itself inside JSON", () => {
    registerSecret(SECRET);
    const inner = `{"k":"${SECRET}","k":"x"}`;
    const out = redactJSONText(JSON.stringify({ body: inner }));
    expect(out).not.toContain("Zk93");
    expect(JSON.parse(JSON.parse(out).body)).toEqual({ k: "x" });
  });

  test("a shared document: tool args with a duplicate key, and a result with one inside a JSON string field", () => {
    registerSecret(SECRET);
    const masked = maskedDocument(
      documentOf(toolRecord({ args: `{"k":"${SECRET}","k":"x"}`, result: JSON.stringify({ body: `{"k":"${SECRET}","k":"x"}` }) })),
    );
    expect(JSON.stringify(masked)).not.toContain("Zk93");
    expect(JSON.parse(masked.records[0]!.args!)).toEqual({ k: "x" });
    expect(JSON.parse(JSON.parse(masked.records[0]!.result!).body)).toEqual({ k: "x" });
  });

  test("a duplicate key and a masked secret in the same object: both are gone", () => {
    registerSecret(SECRET);
    const out = redactJSONText(`{"k":"${SECRET}","k":"x","token":"${SECRET}"}`);
    expect(out).not.toContain("Zk93");
    expect(JSON.parse(out)).toEqual({ k: "x", token: REDACTED });
  });
});

describe("a number that would not survive the round trip keeps its digits", () => {
  test("an integer above 2^53 stays exact, and a secret elsewhere in the input is still masked", () => {
    registerSecret(SECRET);
    const out = redactJSONText(`{"id":${BIG},"token":"${SECRET}"}`);
    expect(out).toContain(BIG);
    expect(out).not.toContain("Zk93");
  });

  test("a duplicate key beside a big id: the id is exact and the first value is gone", () => {
    registerSecret(SECRET);
    const out = redactJSONText(`{"id":${BIG},"k":"${SECRET}","k":"x"}`);
    expect(out).toContain(BIG);
    expect(out).not.toContain("Zk93");
  });

  test("a literal too long for a double (a decimal with 25 digits) is kept exact", () => {
    registerSecret(SECRET);
    const out = redactJSONText(`{"p":3.141592653589793238462643,"token":"${SECRET}"}`);
    expect(out).toContain("3.141592653589793238462643");
    expect(out).not.toContain("Zk93");
  });

  test("an overflowing literal (1e999 would become null) is kept as written", () => {
    registerSecret(SECRET);
    const out = redactJSONText(`{"n":1e999,"token":"${SECRET}"}`);
    expect(out).toContain("1e999");
    expect(out).not.toContain("Zk93");
  });

  test("a big id inside JSON that is inside a string keeps its digits too", () => {
    registerSecret(SECRET);
    const out = redactJSONText(JSON.stringify({ body: `{"id":${BIG},"token":"${SECRET}"}` }));
    expect(JSON.parse(out).body).toContain(BIG);
    expect(out).not.toContain("Zk93");
  });

  test("a digit run inside a string is not a number: the string is masked and the document is re-serialized", () => {
    registerSecret(SECRET);
    const out = redactJSONText(`{"note":"id ${BIG}","token":"${SECRET}"}`);
    expect(JSON.parse(out)).toEqual({ note: `id ${BIG}`, token: REDACTED });
  });

  test("a shared document: a tool's args with a big id keep it and still mask the secret", () => {
    registerSecret(SECRET);
    const masked = maskedDocument(documentOf(toolRecord({ args: `{"id":${BIG},"token":"${SECRET}"}` })));
    expect(masked.records[0]!.args).toContain(BIG);
    expect(masked.records[0]!.args).not.toContain("Zk93");
  });
});

describe("ordinary JSON keeps its shape", () => {
  test("JSON with no secret parses to the same value after redaction, pretty-printed or not", () => {
    registerSecret(SECRET);
    const value = { a: 1, b: ["x", { c: null, d: true }], e: { f: 2.5, g: "text" } };
    expect(JSON.parse(redactJSONText(JSON.stringify(value)))).toEqual(value);
    expect(JSON.parse(redactJSONText(JSON.stringify(value, null, 2)))).toEqual(value);
  });

  test("numbers that only change their spelling (1.0, 1.50, 1e2) are re-serialized, and the value is the same", () => {
    registerSecret(SECRET);
    const out = redactJSONText(`{"a":1.0,"b":1.50,"c":1e2,"token":"${SECRET}"}`);
    expect(JSON.parse(out)).toEqual({ a: 1, b: 1.5, c: 100, token: REDACTED });
  });

  test("ordinary numbers (0.1, 1e-7, -0, 2^53-1) are not lossy: the input is walked and written back compact", () => {
    registerSecret(SECRET);
    const out = redactJSONText(`{ "a": 0.1 , "b": 1e-7, "c": -0, "d": 9007199254740991, "token": "${SECRET}" }`);
    expect(out).toBe(`{"a":0.1,"b":1e-7,"c":0,"d":9007199254740991,"token":"${REDACTED}"}`);
  });

  test("text that is not JSON is masked as plain text", () => {
    registerSecret(SECRET);
    expect(redactJSONText(`stack trace: ${SECRET} at line 3`)).toBe(`stack trace: ${REDACTED} at line 3`);
  });

  test("a top-level JSON string is opened too", () => {
    registerSecret(SECRET);
    // The secret's first letter written as a \u escape: the raw text does not hold it, the parsed string does.
    const out = redactJSONText(`"\\u0064upkey-secret-Zk93-tail"`);
    expect(out).not.toContain("Zk93");
  });
});
