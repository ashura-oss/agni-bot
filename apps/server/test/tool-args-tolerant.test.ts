/**
 * The models send what the handlers always tolerated: null for an optional
 * field, numbers as strings, one string where a list is wanted, a limit past
 * the maximum. Those calls are repaired (and the result says so when a value
 * was clamped); missing required fields, uncoercible types and enum or length
 * violations are still refused. Every case runs against the real schemas.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { ToolRegistry } from "../src/tools/registry";
import { validateArgs } from "../src/tools/validate-args";
import { buildTaskToolRegistry } from "../src/tools/task-registry";

const ctx = { threadID: "thr_t", turnID: "trn_t", signal: new AbortController().signal };

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

/** The real registry's schema for `name`, behind a handler that reports what it received. */
function probe(name: string): (args: unknown) => Promise<unknown> {
  db = openDatabase(":memory:");
  const real = buildTaskToolRegistry(db);
  const registry = new ToolRegistry();
  registry.register({
    name, description: "probe", kind: "static", timeoutMs: 1000,
    schema: real.get(name)!.schema,
    handler: async (args) => ({ received: args }),
  });
  return (args) => registry.get(name)!.handler(args as never, ctx);
}
const received = (result: unknown): Record<string, unknown> => (result as { received: Record<string, unknown> }).received;

describe("tolerant arguments", () => {
  test("null on an optional field means not given", async () => {
    const call = probe("tasks_list");
    expect(received(await call({ limit: null, status: null }))).toEqual({});
  });

  test("a numeric string becomes a number", async () => {
    const call = probe("tasks_list");
    expect(received(await call({ limit: "5" }))).toEqual({ limit: 5 });
    expect(received(await call({ limit: " 7 " }))).toEqual({ limit: 7 });
  });

  test("a number past its bound is clamped to the bound, and the result says so", async () => {
    const call = probe("tasks_list");
    const high = (await call({ limit: 50 })) as { received: Record<string, unknown>; argumentNotes?: string[] };
    expect(high.received).toEqual({ limit: 20 });
    expect(high.argumentNotes?.join(" ")).toContain("limit");
    expect(high.argumentNotes?.join(" ")).toContain("20");
    expect(received(await call({ limit: 0 }))).toEqual({ limit: 1 });
    expect(((await call({ limit: 5 })) as { argumentNotes?: string[] }).argumentNotes).toBeUndefined();
  });

  test("web_fetch maxChars clamps at 20,000 and takes a numeric string", async () => {
    const call = probe("web_fetch");
    expect(received(await call({ url: "https://example.com", maxChars: 99_999 }))).toEqual({ url: "https://example.com", maxChars: 20_000 });
    expect(received(await call({ url: "https://example.com", maxChars: "3000" }))).toEqual({ url: "https://example.com", maxChars: 3000 });
  });

  test("mail_send to as a single string becomes a one-address list", async () => {
    const call = probe("mail_send");
    expect(received(await call({ to: "a@b.c", subject: "s", body: "b" }))).toEqual({ to: ["a@b.c"], subject: "s", body: "b" });
    expect(received(await call({ to: ["a@b.c", "d@e.f"], subject: "s", body: "b" })).to).toEqual(["a@b.c", "d@e.f"]);
  });

  test("a required field that is missing or null is still refused", async () => {
    const call = probe("web_fetch");
    await expect(call({})).rejects.toThrow('"url" is required');
    await expect(call({ url: null })).rejects.toThrow('"url" is required');
  });

  test("a value that cannot be coerced is still refused", async () => {
    const call = probe("tasks_list");
    await expect(call({ limit: "lots" })).rejects.toThrow('"limit" must be an integer');
    await expect(call({ limit: 2.5 })).rejects.toThrow('"limit" must be an integer');
    await expect(call({ limit: true })).rejects.toThrow('"limit" must be an integer');
    await expect(call({ limit: {} })).rejects.toThrow('"limit" must be an integer');
  });

  test("an enum violation and a bad length are still refused", async () => {
    const call = probe("tasks_list");
    await expect(call({ status: "archived" })).rejects.toThrow('"status" must be one of');
    const memory = probe("memory_search");
    await expect(memory({ query: "" })).rejects.toThrow('"query" must be at least 1 characters');
  });

  test("a string is not wrapped where a list of non-strings is expected", () => {
    const schema = { type: "object", properties: { ids: { type: "array", items: { type: "integer" } } } };
    expect(validateArgs(schema, { ids: "5" })).toBe('invalid arguments: "ids" must be an array');
  });

  test("the broker's validator agrees: repairable calls get no 'invalid' verdict", () => {
    db = openDatabase(":memory:");
    const registry = buildTaskToolRegistry(db);
    expect(registry.validateArgs("tasks_list", { limit: null })).toBeNull();
    expect(registry.validateArgs("tasks_list", { limit: "5" })).toBeNull();
    expect(registry.validateArgs("tasks_list", { limit: 50 })).toBeNull();
    expect(registry.validateArgs("mail_send", { to: "a@b.c", subject: "s", body: "b" })).toBeNull();
    expect(registry.validateArgs("tasks_list", { limit: "lots" })).toMatch(/"limit"/);
  });
});
