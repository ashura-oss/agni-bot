/**
 * HF-3 and HF-5 (round 2): the gate must judge the arguments the handler gets. executeTool parses and repairs a call's
 * arguments once and hands the same frozen object to decide() and to the tool; the registry wrapper refuses to change it.
 * These tests fail if the loop goes back to two parses, or if the wrapper repairs after the gate.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db";
import { resolvePersona } from "../src/agent/personas";
import { rootGuardrail } from "../src/agent/guardrails";
import { runTaskTurn } from "../src/agent/task-loop";
import * as engine from "../src/policy/engine";
import { backgroundSession, ensureConversation } from "../src/stores/conversations";
import { ToolRegistry, type ToolDefinition } from "../src/tools/registry";

let home = "";
const savedEnv = { home: process.env.AGNI_HOME, scratch: process.env.AGNI_SCRATCH_DIR };
let db: Database | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agni-r2-one-"));
  mkdirSync(join(home, "scratch"));
  process.env.AGNI_HOME = home;
  process.env.AGNI_SCRATCH_DIR = join(home, "scratch");
});
afterEach(() => {
  db?.close();
  db = undefined;
  if (savedEnv.home === undefined) delete process.env.AGNI_HOME; else process.env.AGNI_HOME = savedEnv.home;
  if (savedEnv.scratch === undefined) delete process.env.AGNI_SCRATCH_DIR; else process.env.AGNI_SCRATCH_DIR = savedEnv.scratch;
  rmSync(home, { recursive: true, force: true });
});

const freeze = <T>(value: T): T => { if (value && typeof value === "object") { Object.freeze(value); for (const item of Object.values(value)) freeze(item); } return value; };
const ctx = { threadID: "t", turnID: "u", signal: new AbortController().signal };

describe("the registry wrapper and frozen arguments", () => {
  function registryWith(seen: unknown[]): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register({
      name: "probe", description: "test", timeoutMs: 1_000,
      schema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 20 }, path: { type: "string" } }, additionalProperties: false },
      handler: async (args: unknown) => { seen.push(args); return { ok: true }; },
    } as ToolDefinition<unknown, unknown>);
    return registry;
  }

  test("frozen, already repaired arguments reach the handler as the very same object", async () => {
    const seen: unknown[] = [];
    const args = freeze({ limit: 5, path: "a.txt" });
    await registryWith(seen).get("probe")!.handler(args as never, ctx);
    expect(seen[0]).toBe(args);
  });

  test("frozen arguments that a repair would change are refused, and the handler does not run", async () => {
    const seen: unknown[] = [];
    await expect(registryWith(seen).get("probe")!.handler(freeze({ limit: 50 }) as never, ctx)).rejects.toThrow(/changed after they were judged/);
    expect(seen).toEqual([]);
  });

  test("unfrozen arguments are repaired and the repair is reported, as before", async () => {
    const seen: unknown[] = [];
    const result = await registryWith(seen).get("probe")!.handler({ limit: 50 } as never, ctx) as { argumentNotes?: string[] };
    expect(seen[0]).toEqual({ limit: 20 });
    expect(result.argumentNotes?.length).toBe(1);
  });
});

describe("executeTool hands one value to the gate and the handler (HF-5)", () => {
  test("decide() and the read_file handler receive the identical, repaired, frozen object", async () => {
    db = openDatabase(":memory:");
    const database = db;
    writeFileSync(join(home, "scratch", "notes.txt"), "hello\n");
    const handlerArgs: unknown[] = [];
    const register = ToolRegistry.prototype.register;
    const registerSpy = spyOn(ToolRegistry.prototype, "register").mockImplementation(function (this: ToolRegistry, definition: ToolDefinition<unknown, unknown>) {
      if (definition.name !== "read_file") return register.call(this, definition as never);
      const inner = definition.handler;
      return register.call(this, { ...definition, handler: async (args: unknown, context: never) => { handlerArgs.push(args); return inner(args, context); } } as never);
    } as never);
    const gateArgs: unknown[] = [];
    const decide = engine.decide;
    const decideSpy = spyOn(engine, "decide").mockImplementation(((run: never, input: { tool: string; args: unknown }, options?: never) => {
      if (input.tool === "read_file") gateArgs.push(input.args);
      return decide(run, input as never, options);
    }) as never);
    try {
      const persona = { ...resolvePersona(database, "ea")!, tools: ["read_file"] };
      const conversation = ensureConversation(database, "ea");
      const thread = backgroundSession(database, conversation, "r2");
      let step = 0;
      const router = {
        route: async () => {
          step += 1;
          if (step === 1) {
            return {
              text: "", outputTokens: 1, provider: "fake", model: "fake", latencyMs: 1,
              // `limit` as a numeric string: the repair turns it into a number, and the gate must see the repaired value.
              toolCalls: [{ id: "call-r", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "notes.txt", limit: "5" }) } }],
            };
          }
          return { text: "Done.", outputTokens: 1, provider: "fake", model: "fake", latencyMs: 1 };
        },
      };
      await runTaskTurn(database, router as never, { firstTokenTimeoutMs: 1_000, turnTimeoutMs: 10_000 }, {
        threadID: thread.id, text: "read it", persona, emit: () => {}, signal: AbortSignal.timeout(5_000),
        conversationID: conversation.id, carrySummary: null, guardrail: rootGuardrail("ea"),
      });
    } finally {
      registerSpy.mockRestore();
      decideSpy.mockRestore();
    }
    expect(gateArgs.length).toBeGreaterThan(0);
    expect(handlerArgs.length).toBe(1);
    for (const seen of gateArgs) expect(seen).toBe(handlerArgs[0]);
    expect(handlerArgs[0]).toEqual({ path: "notes.txt", limit: 5 });
    expect(Object.isFrozen(handlerArgs[0])).toBe(true);
  });
});
