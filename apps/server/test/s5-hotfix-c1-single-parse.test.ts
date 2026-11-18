/**
 * C1 (Sprint 5 hotfix): a tool call's arguments are parsed once; the gate judges that value and the handler is given the
 * same value, deep-frozen, so nothing between them can change what was judged.
 */
import { describe, expect, test } from "bun:test";
import { prepareToolArguments } from "../src/agent/task-loop";

describe("prepareToolArguments", () => {
  test("parses once and freezes every level", () => {
    const { value, error } = prepareToolArguments(JSON.stringify({ path: "a.txt", nested: { list: ["x", { y: 1 }] } }));
    expect(error).toBeNull();
    expect(value).toEqual({ path: "a.txt", nested: { list: ["x", { y: 1 }] } });
    const v = value as { nested: { list: [string, { y: number }] } };
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(v.nested)).toBe(true);
    expect(Object.isFrozen(v.nested.list)).toBe(true);
    expect(Object.isFrozen(v.nested.list[1])).toBe(true);
    expect(() => { (value as Record<string, unknown>).path = " ../x"; }).toThrow();
  });

  test("keeps a value exactly as written, padding included", () => {
    expect(prepareToolArguments(JSON.stringify({ path: " ../x" })).value).toEqual({ path: " ../x" });
  });

  test("returns the parse error instead of throwing", () => {
    const { value, error } = prepareToolArguments("{not json");
    expect(value).toBeUndefined();
    expect(error).toBeInstanceOf(SyntaxError);
  });

  test("a value that is not an object is returned as it parsed", () => {
    expect(prepareToolArguments("null")).toEqual({ value: null, error: null, notes: [] });
    expect(prepareToolArguments("[1,2]").value).toEqual([1, 2]);
  });
});

describe("prepareToolArguments with the tool's schema (HF-3)", () => {
  const schema = {
    type: "object",
    properties: { limit: { type: "integer", minimum: 1, maximum: 20 }, tags: { type: "array", items: { type: "string" } }, note: { type: "string" } },
    additionalProperties: false,
  };
  test("repairs before it freezes, and says what it repaired", () => {
    const { value, error, notes } = prepareToolArguments(JSON.stringify({ limit: "50", tags: "a", note: null }), schema);
    expect(error).toBeNull();
    expect(value).toEqual({ limit: 20, tags: ["a"] });
    expect(notes.length).toBe(1);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen((value as { tags: string[] }).tags)).toBe(true);
  });
  test("keeps the parsed value when it breaks the schema, for the gate to refuse", () => {
    expect(prepareToolArguments(JSON.stringify({ limit: "many" }), schema).value).toEqual({ limit: "many" });
  });
});
