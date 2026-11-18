/**
 * C1 (Sprint 5 hotfix): the gate judged `args.path` as written, and the write_file handler trimmed it before writing,
 * so " ../x" was judged a new file inside scratch (free) and written to ../x. A handler now uses every argument the gate
 * judges exactly as written, or refuses it; and writeFile refuses a target outside scratch unless the owner said yes.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db";
import { resolvePersona } from "../src/agent/personas";
import { rootGuardrail } from "../src/agent/guardrails";
import { runTaskTurn } from "../src/agent/task-loop";
import { backgroundSession, ensureConversation } from "../src/stores/conversations";
import { exactString } from "../src/tools/exact-arg";
import { registerSecureExecTool } from "../src/tools/secure-exec-tool";
import { buildTaskToolRegistry } from "../src/tools/task-registry";
import { writeFile } from "../src/tools/write-file";

let root = "";
let scratch = "";
let savedScratch: string | undefined;
let db: Database | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agni-c1-"));
  scratch = join(root, "scratch");
  mkdirSync(scratch);
  savedScratch = process.env.AGNI_SCRATCH_DIR;
  process.env.AGNI_SCRATCH_DIR = scratch;
});
afterEach(() => {
  db?.close();
  db = undefined;
  if (savedScratch === undefined) delete process.env.AGNI_SCRATCH_DIR;
  else process.env.AGNI_SCRATCH_DIR = savedScratch;
  rmSync(root, { recursive: true, force: true });
});

const PADS = [(v: string) => ` ${v}`, (v: string) => `${v} `, (v: string) => `\t${v}`, (v: string) => `${v}\n`];
const ctx = { threadID: "thr_c1", turnID: "trn_c1", signal: new AbortController().signal };
const PADDED = /must not start or end with spaces or line breaks/;

describe("exactString", () => {
  test("returns the value unchanged", () => {
    expect(exactString("notes/a.txt", "path")).toBe("notes/a.txt");
    expect(exactString("a b", "path")).toBe("a b");
  });
  test("refuses padding, emptiness and non-strings", () => {
    for (const pad of PADS) expect(() => exactString(pad("a.txt"), "path")).toThrow(PADDED);
    expect(() => exactString("", "path")).toThrow(/path must be a non-empty string/);
    expect(() => exactString("   ", "path")).toThrow(PADDED);
    expect(() => exactString(42, "path")).toThrow(/path must be a non-empty string/);
  });
});

describe("handlers refuse a padded argument the gate judges", () => {
  const cases: Array<{ tool: string; args: Record<string, unknown>; field: string }> = [
    { tool: "write_file", args: { path: "out.txt", content: "hi" }, field: "path" },
    { tool: "read_file", args: { path: "out.txt" }, field: "path" },
    { tool: "grep", args: { pattern: "x", path: "sub" }, field: "path" },
    { tool: "glob", args: { pattern: "*.md", path: "sub" }, field: "path" },
    { tool: "bash", args: { command: "echo hi", cwd: "sub" }, field: "cwd" },
    { tool: "bash", args: { command: "echo hi" }, field: "command" },
    { tool: "run_privileged", args: { command: "sudo true", purpose: "test" }, field: "command" },
  ];
  for (const { tool, args, field } of cases) {
    test(`${tool}.${field}`, async () => {
      db = openDatabase(":memory:");
      const registry = buildTaskToolRegistry(db);
      registerSecureExecTool(registry, { emit: () => undefined, threadID: "thr_c1" });
      const handler = registry.get(tool)!.handler as (args: unknown, ctx: unknown) => Promise<unknown>;
      for (const pad of PADS) {
        await expect(handler({ ...args, [field]: pad(String(args[field])) }, ctx)).rejects.toThrow(PADDED);
      }
    });
  }

  test("write_file with a padded path that climbs out of scratch writes nothing", async () => {
    db = openDatabase(":memory:");
    const handler = buildTaskToolRegistry(db).get("write_file")!.handler as (args: unknown, ctx: unknown) => Promise<unknown>;
    await expect(handler({ path: " ../escaped.txt", content: "owned" }, ctx)).rejects.toThrow(PADDED);
    expect(existsSync(join(root, "escaped.txt"))).toBe(false);
  });
});

describe("writeFile stays in scratch unless the owner approved the call", () => {
  test("a target outside scratch is refused by default and nothing is written", () => {
    expect(() => writeFile({ path: "../outside.txt", content: "x" })).toThrow(/outside the sandbox/);
    expect(existsSync(join(root, "outside.txt"))).toBe(false);
  });
  test("a target outside scratch is written when the owner approved it", () => {
    const result = writeFile({ path: "../outside.txt", content: "x" }, { allowOutsideScratch: true });
    expect(result.created).toBe(true);
    expect(existsSync(join(root, "outside.txt"))).toBe(true);
  });
  test("the write_file handler passes the owner's yes, and only that", async () => {
    db = openDatabase(":memory:");
    const handler = buildTaskToolRegistry(db).get("write_file")!.handler as (args: unknown, ctx: unknown) => Promise<unknown>;
    await expect(handler({ path: "../a.txt", content: "x" }, ctx)).rejects.toThrow(/outside the sandbox/);
    await expect(handler({ path: "../a.txt", content: "x" }, { ...ctx, ownerApproved: false })).rejects.toThrow(/outside the sandbox/);
    expect(existsSync(join(root, "a.txt"))).toBe(false);
    await handler({ path: "../a.txt", content: "x" }, { ...ctx, ownerApproved: true });
    expect(existsSync(join(root, "a.txt"))).toBe(true);
  });
  test("a new file inside scratch is written as before", () => {
    expect(writeFile({ path: "inside.txt", content: "x" }).created).toBe(true);
    expect(existsSync(join(scratch, "inside.txt"))).toBe(true);
  });
});

describe("the exploit end to end", () => {
  test("a bot's write_file to ' ../escaped.txt' in a turn writes nothing outside scratch", async () => {
    db = openDatabase(":memory:");
    const database = db;
    const persona = { ...resolvePersona(database, "ea")!, tools: ["write_file"] };
    const conversation = ensureConversation(database, "ea");
    const thread = backgroundSession(database, conversation, "c1");
    let step = 0;
    const router = {
      route: async () => {
        step += 1;
        if (step === 1) {
          return {
            text: "", outputTokens: 1, provider: "fake", model: "fake", latencyMs: 1,
            toolCalls: [{ id: "call-w", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: " ../escaped.txt", content: "owned" }) } }],
          };
        }
        return { text: "Done.", outputTokens: 1, provider: "fake", model: "fake", latencyMs: 1 };
      },
    };
    await runTaskTurn(database, router as never, { firstTokenTimeoutMs: 1_000, turnTimeoutMs: 10_000 }, {
      threadID: thread.id, text: "save it", persona, emit: () => {}, signal: AbortSignal.timeout(5_000),
      conversationID: conversation.id, carrySummary: null, guardrail: rootGuardrail("ea"),
    });
    expect(existsSync(join(root, "escaped.txt"))).toBe(false);
    const row = database.query<{ result: string | null; ok: number }, []>("SELECT result, ok FROM tool_calls WHERE tool_name = 'write_file'").get();
    expect(row?.ok).toBe(0);
    expect(row?.result ?? "").toMatch(PADDED);
  });
});
