/**
 * S1-26 (registry side): tool arguments are checked against the tool's own
 * schema before its handler runs and before any approval card is raised.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { ApprovalBroker } from "../src/agent/approval-broker";
import { ToolRegistry } from "../src/tools/registry";
import { validateArgs } from "../src/tools/validate-args";
import { buildTaskToolRegistry } from "../src/tools/task-registry";

const ctx = { threadID: "thr_t", turnID: "trn_t", signal: new AbortController().signal };

describe("validateArgs: the JSON-schema subset the tools use", () => {
  const schema = {
    type: "object",
    properties: {
      name: { type: "string", minLength: 2, maxLength: 5 },
      count: { type: "integer", minimum: 1, maximum: 3 },
      ratio: { type: "number", minimum: 0, maximum: 1 },
      mode: { type: "string", enum: ["a", "b"] },
      on: { type: "boolean" },
      tags: { type: "array", maxItems: 2, minItems: 1, items: { type: "string", minLength: 1 } },
      link: { type: "string", format: "uri" },
      either: { type: ["string", "null"] },
      nested: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
    required: ["name"],
    additionalProperties: false,
  };

  test("accepts a valid call and a call with only what is required", () => {
    expect(validateArgs(schema, { name: "abc" })).toBeNull();
    expect(validateArgs(schema, { name: "abc", count: 3, ratio: 0.5, mode: "b", on: false, tags: ["x"], link: "https://a.example/x", either: null, nested: { id: "1" } })).toBeNull();
  });

  test("a missing required field is named", () => {
    expect(validateArgs(schema, {})).toBe('invalid arguments: "name" is required');
    expect(validateArgs(schema, { name: undefined })).toBe('invalid arguments: "name" is required');
    expect(validateArgs(schema, undefined)).toBe('invalid arguments: "name" is required');
  });

  test("arguments that are not an object are refused", () => {
    expect(validateArgs(schema, "x")).toMatch(/must be an object/);
    expect(validateArgs(schema, [1])).toMatch(/must be an object/);
    expect(validateArgs(schema, null)).toMatch(/must be an object/);
  });

  test("wrong types name the field and the type wanted", () => {
    expect(validateArgs(schema, { name: 5 })).toBe('invalid arguments: "name" must be a string');
    expect(validateArgs(schema, { name: "abc", count: 1.5 })).toBe('invalid arguments: "count" must be an integer');
    expect(validateArgs(schema, { name: "abc", count: "abc" })).toBe('invalid arguments: "count" must be an integer');
    expect(validateArgs(schema, { name: "abc", count: "" })).toBe('invalid arguments: "count" must be an integer');
    expect(validateArgs(schema, { name: "abc", count: "2.5" })).toBe('invalid arguments: "count" must be an integer');
    expect(validateArgs(schema, { name: "abc", ratio: Number.NaN })).toBe('invalid arguments: "ratio" must be a number');
    expect(validateArgs(schema, { name: "abc", on: "yes" })).toBe('invalid arguments: "on" must be a boolean');
    expect(validateArgs(schema, { name: "abc", tags: 5 })).toBe('invalid arguments: "tags" must be an array');
    expect(validateArgs(schema, { name: "abc", either: 4 })).toBe('invalid arguments: "either" must be a string or null');
  });

  test("minLength, maxLength, maxItems and minItems", () => {
    expect(validateArgs(schema, { name: "a" })).toBe('invalid arguments: "name" must be at least 2 characters (got 1)');
    expect(validateArgs(schema, { name: "abcdef" })).toBe('invalid arguments: "name" must be at most 5 characters (got 6)');
    expect(validateArgs(schema, { name: "abc", tags: ["a", "b", "c"] })).toBe('invalid arguments: "tags" must have at most 2 items (got 3)');
    expect(validateArgs(schema, { name: "abc", tags: [] })).toBe('invalid arguments: "tags" must have at least 1 items (got 0)');
  });

  test("enum lists the allowed values", () => {
    expect(validateArgs(schema, { name: "abc", mode: "c" })).toBe('invalid arguments: "mode" must be one of: a, b');
  });

  test("array items are checked and named by index", () => {
    expect(validateArgs(schema, { name: "abc", tags: ["ok", ""] })).toBe('invalid arguments: "tags[1]" must be at least 1 characters (got 0)');
    expect(validateArgs(schema, { name: "abc", tags: [3] })).toBe('invalid arguments: "tags[0]" must be a string');
  });

  test("nested objects are checked with a dotted name", () => {
    expect(validateArgs(schema, { name: "abc", nested: {} })).toBe('invalid arguments: "nested.id" is required');
  });

  test("format uri must parse as a URL", () => {
    expect(validateArgs(schema, { name: "abc", link: "not a url" })).toBe('invalid arguments: "link" must be a valid URI');
  });

  test("keywords outside the subset are ignored rather than guessed at", () => {
    expect(validateArgs({ type: "object", properties: { x: { oneOf: [{ type: "string" }, { type: "number" }], pattern: "^a" } }, patternProperties: {} }, { x: 5, extra: true })).toBeNull();
    expect(validateArgs(undefined, { anything: 1 })).toBeNull();
    expect(validateArgs({}, { anything: 1 })).toBeNull();
  });
});

describe("the registry validates before the handler", () => {
  test("an invalid call returns an error naming the field and never reaches the handler", async () => {
    const registry = new ToolRegistry();
    let ran = 0;
    registry.register({
      name: "demo", description: "d", kind: "static", timeoutMs: 1000,
      schema: { type: "object", properties: { path: { type: "string", minLength: 1 } }, required: ["path"] },
      handler: async () => { ran += 1; return { ok: true }; },
    });
    const tool = registry.get("demo")!;
    await expect(tool.handler({} as never, ctx)).rejects.toThrow('invalid arguments: "path" is required');
    await expect(tool.handler({ path: "" } as never, ctx)).rejects.toThrow('"path" must be at least 1 characters');
    expect(ran).toBe(0);
    expect(await tool.handler({ path: "x" } as never, ctx)).toEqual({ ok: true });
    expect(ran).toBe(1);
  });

  test("validateArgs on the registry answers for a tool by name, and is silent for an unknown one", () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "demo", description: "d", kind: "static", timeoutMs: 1000,
      schema: { type: "object", properties: { n: { type: "integer", maximum: 2 } }, required: ["n"] },
      handler: async () => null,
    });
    expect(registry.validateArgs("demo", { n: "many" })).toBe('invalid arguments: "n" must be an integer');
    expect(registry.validateArgs("demo", {})).toBe('invalid arguments: "n" is required');
    expect(registry.validateArgs("demo", { n: 3 })).toBeNull(); // out of range is clamped, not refused
    expect(registry.validateArgs("nope", {})).toBeNull();
  });
});

describe("an invalid call never raises an approval card", () => {
  let db: Database | undefined;
  afterEach(() => { db?.close(); db = undefined; });

  test("write_file without a path is rejected by validation, not shown as 'write file: ?'", async () => {
    db = openDatabase(":memory:");
    const registry = buildTaskToolRegistry(db);
    const broker = new ApprovalBroker({
      db,
      emit: () => undefined,
      waitForDecision: async () => null,
      validate: (name, args) => registry.validateArgs(name, args),
    });
    // Outside-scratch-style call with the required path missing: no card.
    expect(broker.requiresApproval("write_file", { content: "x" })).toBe(false);
    expect(broker.requiresApproval("bash", {})).toBe(false);
    expect(broker.requiresApproval("bash", { command: "rm -rf /tmp/x" })).toBe(true);
    // And the handler refuses it with a tool error that names the field.
    await expect(registry.get("write_file")!.handler({ content: "x" } as never, ctx)).rejects.toThrow('"path" is required');
    await expect(registry.get("bash")!.handler({} as never, ctx)).rejects.toThrow('"command" is required');
  });

  test("a broker with no validator behaves as before", () => {
    const broker = new ApprovalBroker({ db: null as unknown as Database, emit: () => undefined, waitForDecision: async () => null });
    expect(broker.requiresApproval("bash", {})).toBe(true);
  });

  test("approval previews never print a bare question mark for a missing argument", async () => {
    db = openDatabase(":memory:");
    const frames: Array<{ action: string; preview: string }> = [];
    const broker = new ApprovalBroker({ db, emit: (f) => frames.push(f), waitForDecision: async () => "once" });
    for (const [tool, args] of [["write_file", {}], ["task_create", {}], ["link_save", {}], ["task_update", {}], ["mail_send", { account: "owner" }]] as const) {
      await broker.request("thr_x", "trn_x", tool, `call_${tool}`, args as Record<string, unknown>, new AbortController().signal);
    }
    for (const frame of frames) {
      expect(frame.action).not.toContain("?");
      expect(frame.action).not.toContain("undefined");
      expect(frame.preview).not.toContain("?");
      expect(frame.preview).not.toContain("undefined");
    }
  });
});
