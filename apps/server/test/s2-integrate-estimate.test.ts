/**
 * S2-INT item 2: a provider that reports no usage at all is priced from the request size and the streamed
 * text, marked `estimate`, and does not block the day as an unknown cost.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { HealthTracker } from "../src/models/health";
import { estimateTokens } from "../src/models/prices";
import type { ProviderConfig } from "../src/models/providers";
import { Router, setRouteGate } from "../src/models/router";
import { setUsageRecorder } from "../src/models/usage-hook";
import { checkBudget, configureBudget } from "../src/policy/budget";
import { startupS2Ledger } from "../src/startup/s2-ledger";
import { setPauseCheck } from "../src/startup/s2-ledger";

const encoder = new TextEncoder();
const stream = (events: unknown[]): Response => new Response(new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(encoder.encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n"));
    controller.close();
  },
}), { status: 200 });

const openrouter: ProviderConfig = { id: "openrouter", label: "OpenRouter", baseUrl: "https://or.test/v1", apiKey: "k", model: "deepseek/deepseek-v4.1-flash-1017" };
const REPLY = "Here is a reasonably long answer with several words in it, so the output estimate is not tiny.";
const PROMPT = "Please write something and make it a bit long so the prompt estimate is clearly above zero.";

interface Row { cost_usd: number | null; cost_source: string | null; input_tokens: number; output_tokens: number }
let db: Database;
const rows = (): Row[] => db.query<Row, []>("SELECT cost_usd, cost_source, input_tokens, output_tokens FROM usage_ledger ORDER BY rowid").all();
const call = { messages: [{ role: "user" as const, content: PROMPT }], firstTokenTimeoutMs: 1000, onDelta: () => {}, agentID: "a1", jobID: "j1", kind: "turn" as const };

beforeEach(async () => {
  db = openDatabase(":memory:");
  await startupS2Ledger({ db, config: {} as never });
});
afterEach(() => {
  setUsageRecorder(() => {});
  setRouteGate(null);
  setPauseCheck(null);
  configureBudget(null);
  db.close();
});

describe("a provider that reports no usage", () => {
  test("is priced from the request size and the streamed text, and marked estimate", async () => {
    const router = new Router([openrouter], new HealthTracker(), (async () => stream([{ choices: [{ delta: { content: REPLY } }] }])) as unknown as typeof fetch);
    const result = await router.route(call);
    expect(result.text).toBe(REPLY);
    const [row] = rows();
    expect(rows()).toHaveLength(1);
    expect(row!.cost_source).toBe("estimate");
    expect(row!.cost_usd).not.toBeNull();
    expect(row!.cost_usd!).toBeGreaterThan(0);
    expect(row!.output_tokens).toBe(estimateTokens(REPLY));
    expect(row!.input_tokens).toBeGreaterThanOrEqual(estimateTokens(PROMPT));
  });

  test("does not block the day: the next call is allowed and nothing counts as unknown cost", async () => {
    const router = new Router([openrouter], new HealthTracker(), (async () => stream([{ choices: [{ delta: { content: REPLY } }] }])) as unknown as typeof fetch);
    await router.route(call);
    expect(checkBudget({ agentID: "a1", jobID: "j1" })).toEqual({ ok: true });
    expect((await router.route(call)).text).toBe(REPLY);
  });

  test("tool-call arguments count as output too", async () => {
    const args = JSON.stringify({ note: "x".repeat(400) });
    const router = new Router([openrouter], new HealthTracker(), (async () => stream([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "tasks_list", arguments: args } }] } }] },
    ])) as unknown as typeof fetch);
    await router.route(call);
    expect(rows()[0]!.output_tokens).toBeGreaterThanOrEqual(estimateTokens(args));
    expect(rows()[0]!.cost_source).toBe("estimate");
  });

  test("a call that reported its usage is not marked estimate", async () => {
    const router = new Router([openrouter], new HealthTracker(), (async () => stream([
      { choices: [{ delta: { content: REPLY } }] },
      { choices: [], usage: { prompt_tokens: 50, completion_tokens: 10 } },
    ])) as unknown as typeof fetch);
    await router.route(call);
    expect(rows()[0]).toMatchObject({ input_tokens: 50, output_tokens: 10 });
    expect(rows()[0]!.cost_source).toBe("table");
  });
});
