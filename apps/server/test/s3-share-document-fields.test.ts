/**
 * Sprint 3 fix round 7: the shared document is masked field by field.
 *
 * A share page used to be masked as one serialized blob (`redactForStorage(JSON.stringify(doc))`). JSON escaping
 * changes a secret that holds a quote, a backslash or a control character, a tool's args hold JSON inside a
 * string (escaped twice), and a short registered value can equal JSON syntax. So each string is masked on its own,
 * and the fields that hold JSON are parsed, walked and written back.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishShare, maskedDocument } from "../src/share/document";
import type { ShareDocument, ShareRecord } from "../src/share/render";
import { REDACTED, registerSecret } from "../src/util/redact";
import { clearSecretsForTests } from "../src/util/redact-core";

/** A secret with the three kinds of character JSON escapes: a quote, a backslash and a newline. */
const AWKWARD = 'pa"ss\wd\nZk93-tail-xyz';

/** `JSON.stringify(text)` without its two quotes: how `text` looks inside a JSON string. */
const escaped = (text: string): string => JSON.stringify(text).slice(1, -1);
const escapedTwice = (text: string): string => escaped(escaped(text));

const dirs: string[] = [];
afterEach(() => {
  clearSecretsForTests();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function toolRecord(overrides: Partial<ShareRecord> = {}): ShareRecord {
  return { id: "tc_1", kind: "tool", at: "2026-11-17T00:00:01.000Z", toolName: "search", args: "{}", result: "ok", ok: true, ...overrides };
}

function documentOf(...records: ShareRecord[]): ShareDocument {
  return { title: "Export", agentName: "Agent", agentID: "agt_1", conversationID: "cnv_1", createdAt: "2026-11-17T00:00:00.000Z", records };
}

describe("the shared document is masked field by field", () => {
  test("a secret with a quote and a backslash inside tool-call args is masked and the args keep their shape", () => {
    registerSecret(AWKWARD);
    const doc = documentOf(toolRecord({ args: JSON.stringify({ token: AWKWARD, query: "weather" }) }));
    const masked = maskedDocument(doc);
    expect(Object.keys(masked)).toEqual(Object.keys(doc));
    expect(masked.records).toHaveLength(1);
    expect(masked.records[0]!.kind).toBe("tool");
    expect(JSON.parse(masked.records[0]!.args!)).toEqual({ token: REDACTED, query: "weather" });
    const everything = JSON.stringify(masked);
    for (const form of [AWKWARD, escaped(AWKWARD), escapedTwice(AWKWARD)]) expect(everything).not.toContain(form);
    expect(everything).not.toContain("Zk93");
  });

  test("a secret inside a JSON result is masked, nested keys and values alike", () => {
    registerSecret(AWKWARD);
    const result = JSON.stringify({ headers: { authorization: AWKWARD }, [AWKWARD]: "as a key", list: [AWKWARD, 3] });
    const masked = maskedDocument(documentOf(toolRecord({ result })));
    expect(JSON.parse(masked.records[0]!.result!)).toEqual({ headers: { authorization: REDACTED }, [REDACTED]: "as a key", list: [REDACTED, 3] });
  });

  test("a secret inside JSON that is inside a string of a result is masked", () => {
    registerSecret(AWKWARD);
    const result = JSON.stringify({ body: JSON.stringify({ password: AWKWARD }) });
    const masked = maskedDocument(documentOf(toolRecord({ result })));
    expect(masked.records[0]!.result).not.toContain("Zk93");
    expect(JSON.parse(JSON.parse(masked.records[0]!.result!).body)).toEqual({ password: REDACTED });
  });

  test("args or a result that is not JSON is masked as plain text, raw and escaped forms", () => {
    registerSecret(AWKWARD);
    const masked = maskedDocument(
      documentOf(toolRecord({ args: `not json: ${AWKWARD}`, result: `stack: ${escaped(AWKWARD)} / ${escapedTwice(AWKWARD)}` })),
    );
    expect(masked.records[0]!.args).toBe(`not json: ${REDACTED}`);
    expect(masked.records[0]!.result).toBe(`stack: ${REDACTED} / ${REDACTED}`);
  });

  test("a registered number that appears as a JSON number is masked and the JSON still parses", () => {
    registerSecret("12345678");
    const masked = maskedDocument(documentOf(toolRecord({ args: '{"pin":12345678,"n":2}' })));
    expect(JSON.parse(masked.records[0]!.args!)).toEqual({ pin: REDACTED, n: 2 });
  });

  test("text fields (a message, an approval, a title) are masked too", () => {
    registerSecret(AWKWARD);
    const doc = documentOf(
      { id: "m1", kind: "agent", at: "2026-11-17T00:00:02.000Z", text: `my key is ${AWKWARD}` },
      { id: "a1", kind: "approval", at: "2026-11-17T00:00:03.000Z", text: `run curl -H "x: ${AWKWARD}"`, decision: "approve" },
    );
    doc.title = `Export of ${AWKWARD}`;
    const masked = maskedDocument(doc);
    expect(masked.title).toBe(`Export of ${REDACTED}`);
    expect(masked.records[0]!.text).toBe(`my key is ${REDACTED}`);
    expect(masked.records[1]!.text).toBe(`run curl -H "x: ${REDACTED}"`);
    expect(masked.records[1]!.decision).toBe("approve");
  });

  test("a registered value that is JSON syntax does not corrupt the document", () => {
    const syntax = '","kind":"';
    registerSecret(syntax);
    const doc = documentOf(
      toolRecord({ args: JSON.stringify({ a: "x", kind: "y" }), result: `before ${syntax} after` }),
      { id: "m1", kind: "user", at: "2026-11-17T00:00:02.000Z", text: "hello" },
    );
    const masked = maskedDocument(doc);
    expect(masked.records.map((record) => [record.id, record.kind, record.at])).toEqual(doc.records.map((record) => [record.id, record.kind, record.at]));
    expect(masked.records[0]!.args).toBe(doc.records[0]!.args);
    expect(masked.records[0]!.result).toBe(`before ${REDACTED} after`);
    expect(masked.records[1]!.text).toBe("hello");
    expect(masked.title).toBe(doc.title);
  });

  test("JSON with nothing to mask keeps its value (it is written back compact, never as the raw text)", () => {
    registerSecret(AWKWARD);
    const value = { a: 1, b: ["x", { c: null }] };
    const pretty = JSON.stringify(value, null, 2);
    const masked = maskedDocument(documentOf(toolRecord({ args: pretty, result: pretty })));
    expect(JSON.parse(masked.records[0]!.args!)).toEqual(value);
    expect(JSON.parse(masked.records[0]!.result!)).toEqual(value);
  });

  test("JSON nested too deep to walk is masked as plain text and the export still goes through", () => {
    registerSecret(AWKWARD);
    const depth = 50_000;
    const deep = `${"[".repeat(depth)}${JSON.stringify(AWKWARD)}${"]".repeat(depth)}`;
    const masked = maskedDocument(documentOf(toolRecord({ result: deep })));
    expect(masked.records[0]!.result).not.toContain("Zk93");
  });

  test("a key named __proto__ stays an own key of the masked args", () => {
    registerSecret(AWKWARD);
    const args = '{"__proto__":{"token":' + JSON.stringify(AWKWARD) + "}}";
    const masked = maskedDocument(documentOf(toolRecord({ args })));
    expect(Object.keys(JSON.parse(masked.records[0]!.args!))).toEqual(["__proto__"]);
    expect(masked.records[0]!.args).not.toContain("Zk93");
  });

  test("the page written to disk has none of the secret, in any form, inside tool args", () => {
    registerSecret(AWKWARD);
    const dir = mkdtempSync(join(tmpdir(), "agni-s3-json-forms-"));
    dirs.push(dir);
    const saved = process.env.AGNI_SHARE_DIR;
    process.env.AGNI_SHARE_DIR = dir;
    try {
      const { path } = publishShare(documentOf(toolRecord({ args: JSON.stringify({ token: AWKWARD }) })), { baseURL: "http://127.0.0.1:8787" });
      const page = readFileSync(path, "utf8");
      expect(page).toContain("search");
      expect(page).not.toContain("Zk93");
    } finally {
      if (saved === undefined) delete process.env.AGNI_SHARE_DIR;
      else process.env.AGNI_SHARE_DIR = saved;
    }
  });
});
