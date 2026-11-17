/**
 * Sprint 3 fix round 9: a number that a double cannot hold does not send parsed JSON down the raw-text path.
 *
 * Round 8 masked any input holding such a number (`12345678901234567890`) as plain text so the digits stayed
 * exact. Anyone could add one to force that path, and plain-text masking knows only a secret's raw and
 * JSON-escaped forms: a `\u`-escaped secret, or a secret in the first of two equal keys, went through. Input
 * that parses as JSON is now always returned as the walked value, lossy numbers included; the exact digits are
 * carried through the walk as placeholders and put back at the end.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { maskedDocument } from "../src/share/document";
import type { ShareDocument, ShareRecord } from "../src/share/render";
import { REDACTED, registerSecret } from "../src/util/redact";
import { clearSecretsForTests } from "../src/util/redact-core";
import { redactJSONText } from "../src/util/redact-json";

const SECRET = "lossy-secret-Zk93-tail";
const BIG = "12345678901234567890";
/** `SECRET` with its first letter written as a `\u` escape: the raw text of the document does not hold the secret. */
const ESCAPED_SECRET = "\\u006cossy-secret-Zk93-tail";

afterEach(() => {
  clearSecretsForTests();
});

function toolRecord(overrides: Partial<ShareRecord> = {}): ShareRecord {
  return { id: "tc_1", kind: "tool", at: "2026-11-17T00:00:01.000Z", toolName: "search", args: "{}", result: "ok", ok: true, ...overrides };
}

function documentOf(...records: ShareRecord[]): ShareDocument {
  return { title: "Export", agentName: "Agent", agentID: "agt_1", conversationID: "cnv_1", createdAt: "2026-11-17T00:00:00.000Z", records };
}

describe("a lossy number does not open the raw-text path", () => {
  test("a big id and a \\u-escaped secret: the secret is masked and the id keeps its digits", () => {
    registerSecret(SECRET);
    const out = redactJSONText(`{"id":${BIG},"token":"${ESCAPED_SECRET}"}`);
    expect(out).not.toContain("Zk93");
    expect(out).toContain(BIG);
    expect(out).toContain(REDACTED);
  });

  test("a big id and a duplicate key whose first value is the secret: the secret is gone", () => {
    registerSecret(SECRET);
    const out = redactJSONText(`{"id":${BIG},"k":"${SECRET}","k":"x"}`);
    expect(out).not.toContain("Zk93");
    expect(out).toContain(BIG);
    expect(out).toContain('"k":"x"');
  });

  test("a big id and a duplicate key whose first value is a \\u-escaped secret: the secret is gone", () => {
    registerSecret(SECRET);
    const out = redactJSONText(`{"id":${BIG},"k":"${ESCAPED_SECRET}","k":"x"}`);
    expect(out).not.toContain("Zk93");
    expect(out).toContain(BIG);
  });

  test("a big id, and a \\u-escaped secret inside JSON that is inside a string", () => {
    registerSecret(SECRET);
    const out = redactJSONText(`{"id":${BIG},"body":${JSON.stringify(`{"n":${BIG},"token":"${ESCAPED_SECRET}"}`)}}`);
    expect(out).not.toContain("Zk93");
    expect(JSON.parse(out).body).toContain(BIG);
  });

  test("a big id at the top and a \\u-escaped secret in a shared document's tool args", () => {
    registerSecret(SECRET);
    const masked = maskedDocument(documentOf(toolRecord({ args: `{"id":${BIG},"token":"${ESCAPED_SECRET}"}` })));
    expect(masked.records[0]!.args).toContain(BIG);
    expect(JSON.stringify(masked)).not.toContain("Zk93");
  });

  test("the first of two equal keys holds a big number and the second a secret: the output is the last value", () => {
    registerSecret(SECRET);
    const out = redactJSONText(`{"id":${BIG},"id":"${ESCAPED_SECRET}"}`);
    expect(out).not.toContain("Zk93");
    expect(JSON.parse(out)).toEqual({ id: REDACTED });
  });

  test("a big number in a key's dropped duplicate leaves a valid document and no placeholder text", () => {
    registerSecret(SECRET);
    const out = redactJSONText(`{"id":${BIG},"id":1,"token":"${SECRET}"}`);
    expect(JSON.parse(out)).toEqual({ id: 1, token: REDACTED });
    expect(out).not.toContain("agni_lossy");
  });
});

describe("a lossy number keeps its digits", () => {
  test("at the top level, byte for byte", () => {
    registerSecret(SECRET);
    expect(redactJSONText(`{"id":${BIG}}`)).toBe(`{"id":${BIG}}`);
  });

  test("two of them in one document, and one inside an array", () => {
    registerSecret(SECRET);
    const out = redactJSONText(`{"a":${BIG},"list":[1,${BIG},2.5],"b":-${BIG}}`);
    expect(out).toBe(`{"a":${BIG},"list":[1,${BIG},2.5],"b":-${BIG}}`);
  });

  test("nested in a JSON string, at the inner layer", () => {
    registerSecret(SECRET);
    const out = redactJSONText(JSON.stringify({ body: `{"id":${BIG}}` }));
    expect(JSON.parse(out).body).toBe(`{"id":${BIG}}`);
  });

  test("nested in a JSON string, with another at the outer layer", () => {
    registerSecret(SECRET);
    const out = redactJSONText(`{"outer":${BIG},"body":${JSON.stringify(`{"inner":${BIG}}`)}}`);
    expect(out).toBe(`{"outer":${BIG},"body":${JSON.stringify(`{"inner":${BIG}}`)}}`);
  });

  test("inside a shared document's tool args and result", () => {
    registerSecret(SECRET);
    const masked = maskedDocument(
      documentOf(toolRecord({ args: `{"id":${BIG}}`, result: JSON.stringify({ body: `{"id":${BIG}}` }) })),
    );
    expect(masked.records[0]!.args).toBe(`{"id":${BIG}}`);
    expect(JSON.parse(masked.records[0]!.result!).body).toBe(`{"id":${BIG}}`);
  });

  test("a decimal too long for a double and an overflowing literal, with a secret masked beside them", () => {
    registerSecret(SECRET);
    const out = redactJSONText(`{"p":3.141592653589793238462643,"n":1e999,"token":"${SECRET}"}`);
    expect(out).toBe(`{"p":3.141592653589793238462643,"n":1e999,"token":"${REDACTED}"}`);
  });

  test("a digit run inside a string is a string, not a number: it is not swapped", () => {
    registerSecret(SECRET);
    const out = redactJSONText(`{"note":"id ${BIG}","id":${BIG}}`);
    expect(out).toBe(`{"note":"id ${BIG}","id":${BIG}}`);
  });

  test("a big number that is itself a registered value is masked, not kept", () => {
    registerSecret(BIG);
    const out = redactJSONText(`{"id":${BIG}}`);
    expect(out).not.toContain(BIG);
    expect(JSON.parse(out)).toEqual({ id: REDACTED });
  });
});
