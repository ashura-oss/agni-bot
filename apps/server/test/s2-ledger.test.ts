import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { streamChat } from "../src/models/client";
import { HealthTracker } from "../src/models/health";
import { resetPriceWarnings } from "../src/models/prices";
import type { ProviderConfig } from "../src/models/providers";
import { Router, setRouteGate } from "../src/models/router";
import { configureBudget } from "../src/policy/budget";
import { recordModelUsage, setUsageRecorder, type ModelUsageEvent } from "../src/models/usage-hook";
import { startupS2Ledger } from "../src/startup/s2-ledger";
import { dayTotals, recordUsage } from "../src/stores/usage";

const encoder = new TextEncoder();

function sse(usage: Record<string, unknown> | undefined, content = "hi"): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`));
      const last = { choices: [{ delta: {}, finish_reason: "stop" }], ...(usage ? { usage } : {}) };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(last)}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  }), { status: 200 });
}

const asFetch = (fn: () => Response): typeof fetch => (async () => fn()) as unknown as typeof fetch;
// The router gate (installed by startupS2Ledger) refuses a call that names no bot and no kind.
const options = { messages: [{ role: "user" as const, content: "hi" }], firstTokenTimeoutMs: 1000, onDelta: () => {}, agentID: "agent_x", kind: "turn" as const };
const deepseek: ProviderConfig = { id: "openrouter", label: "OpenRouter", baseUrl: "https://or.test/v1", apiKey: "k", model: "deepseek/deepseek-v4.1-flash-1017" };

interface LedgerRow {
  id: string; turn_id: string | null; provider: string; model: string; input_tokens: number; output_tokens: number;
  cached_input_tokens: number; cost_usd: number | null; agent_id: string | null; job_id: string | null;
  root_job_id: string | null; call_kind: string | null; purpose: string | null; day: string; created_at: string;
}
const rows = (db: Database): LedgerRow[] => db.query<LedgerRow, []>("SELECT * FROM usage_ledger ORDER BY created_at, rowid").all();

let db: Database;
beforeEach(() => {
  resetPriceWarnings();
  db = openDatabase(":memory:");
});
afterEach(() => {
  setUsageRecorder(() => {});
  setRouteGate(null);
  configureBudget(null);
  db.close();
});

describe("cached token counts from provider responses", () => {
  const run = async (usage: Record<string, unknown>) => streamChat({
    baseUrl: "https://p.test/v1", apiKey: "k", model: "m", messages: [{ role: "user", content: "x" }],
    firstTokenTimeoutMs: 1000, onDelta: () => {}, fetchFn: asFetch(() => sse(usage)),
  });

  test("OpenAI-style prompt_tokens_details.cached_tokens (OpenRouter, Qwen, OpenAI)", async () => {
    const result = await run({ prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 640 } });
    expect(result.inputTokens).toBe(1000);
    expect(result.cachedInputTokens).toBe(640);
  });

  test("DeepSeek-style prompt_cache_hit_tokens", async () => {
    const result = await run({ prompt_tokens: 500, completion_tokens: 5, prompt_cache_hit_tokens: 300, prompt_cache_miss_tokens: 200 });
    expect(result.cachedInputTokens).toBe(300);
  });

  test("no cache field means the count is absent, not zero", async () => {
    const result = await run({ prompt_tokens: 10, completion_tokens: 2 });
    expect(result.cachedInputTokens).toBeUndefined();
  });
});

describe("router passes cached tokens through", () => {
  test("the usage event and the route result carry cachedInputTokens", async () => {
    const events: ModelUsageEvent[] = [];
    setUsageRecorder((event) => { events.push(event); });
    const usage = { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 80 } };
    const router = new Router([deepseek], new HealthTracker(), asFetch(() => sse(usage)));
    const result = await router.route(options);
    expect(result.cachedInputTokens).toBe(80);
    expect(events).toHaveLength(1);
    expect(events[0]!.cachedInputTokens).toBe(80);
  });
});

describe("migration 54: ledger columns", () => {
  test("usage_ledger gains cost, cached tokens, bot, job, root job, kind and purpose", () => {
    const names = db.query<{ name: string }, []>("PRAGMA table_info(usage_ledger)").all().map((c) => c.name);
    for (const column of ["cost_usd", "cached_input_tokens", "agent_id", "job_id", "root_job_id", "call_kind", "purpose"]) {
      expect(names, column).toContain(column);
    }
  });

  test("a row written the old way still works and has no kind", () => {
    recordUsage(db, { turnID: "trn_1", provider: "p", model: "m", inputTokens: 5, outputTokens: 2 });
    const [row] = rows(db);
    expect(row!.call_kind).toBeNull();
    expect(row!.cost_usd).toBeNull();
    expect(row!.cached_input_tokens).toBe(0);
    expect(dayTotals(db)).toEqual({ turns: 1, inputTokens: 5, outputTokens: 2 });
  });
});

describe("ledger recorder (startupS2Ledger)", () => {
  const install = async () => startupS2Ledger({ db, config: {} as never });

  test("one model call writes exactly one row with cost, cached tokens, bot, job, root job, kind and purpose", async () => {
    await install();
    const usage = { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 400 } };
    const router = new Router([deepseek], new HealthTracker(), asFetch(() => sse(usage)));
    await router.route({ ...options, purpose: "chat", agentID: "agent_a", jobID: "job_child", rootJobID: "job_root", kind: "turn" });
    const all = rows(db);
    expect(all).toHaveLength(1);
    const row = all[0]!;
    expect(row).toMatchObject({
      provider: "openrouter", model: "deepseek/deepseek-v4.1-flash-1017", input_tokens: 1000, output_tokens: 100,
      cached_input_tokens: 400, agent_id: "agent_a", job_id: "job_child", root_job_id: "job_root", call_kind: "turn", purpose: "chat",
    });
    // 600 uncached x $0.036/M + 400 cached x $0.01/M + 100 output x $0.5/M
    expect(row.cost_usd).toBeCloseTo((600 * 0.036 + 400 * 0.01 + 100 * 0.5) / 1e6, 12);
  });

  test("a call that names no kind is recorded as a side call; a job with no parent is its own root", async () => {
    await install();
    recordModelUsage({ provider: "openrouter", model: "qwen/qwen3.8-flash", inputTokens: 10, outputTokens: 1, latencyMs: 5, jobID: "job_x" });
    const [row] = rows(db);
    expect(row!.call_kind).toBe("side");
    expect(row!.root_job_id).toBe("job_x");
    expect(row!.purpose).toBeNull();
  });

  test("an unpriced model with no token counts is recorded with cost null (never 0)", async () => {
    await install();
    recordModelUsage({ provider: "openrouter", model: "nobody/unknown", latencyMs: 5 });
    expect(rows(db)[0]!.cost_usd).toBeNull();
  });

  test("a provider that reports no usage still leaves a row (zero tokens, cost null)", async () => {
    await install();
    const router = new Router([deepseek], new HealthTracker(), asFetch(() => sse(undefined)));
    await router.route(options);
    const all = rows(db);
    expect(all).toHaveLength(1);
    expect(all[0]!.input_tokens).toBe(0);
    expect(all[0]!.cost_usd).toBeNull();
  });

  test("one call from each kind of caller yields exactly one row, retried calls included", async () => {
    await install();
    const usage = { prompt_tokens: 10, completion_tokens: 2 };
    let calls = 0;
    const flaky = (async () => (++calls === 1 ? new Response("down", { status: 503 }) : sse(usage))) as unknown as typeof fetch;
    const before = Router.retryBackoffMs;
    Router.retryBackoffMs = 0;
    try {
      const router = new Router([deepseek], new HealthTracker(), flaky);
      const callers = ["chat", "tagger", "summary", "compactor", "critic"];
      for (const purpose of callers) await router.route({ ...options, purpose, kind: purpose === "chat" ? "turn" : "side" });
      const all = rows(db);
      expect(all).toHaveLength(callers.length);
      expect(all.map((r) => r.purpose)).toEqual(callers);
      expect(all.filter((r) => r.call_kind === "side")).toHaveLength(4);
    } finally {
      Router.retryBackoffMs = before;
    }
  });

  test("a failed route writes nothing", async () => {
    await install();
    const router = new Router([deepseek], new HealthTracker(), (async () => new Response("bad", { status: 400 })) as unknown as typeof fetch);
    await expect(router.route(options)).rejects.toThrow();
    expect(rows(db)).toHaveLength(0);
  });

  test("a ledger write that fails does not fail the call it belongs to, but stops the next one", async () => {
    await install();
    const breaking = (async () => { db.exec("DROP TABLE usage_ledger"); return sse({ prompt_tokens: 1, completion_tokens: 1 }); }) as unknown as typeof fetch;
    const router = new Router([deepseek], new HealthTracker(), breaking);
    expect((await router.route(options)).text).toBe("hi");
    await expect(router.route(options)).rejects.toMatchObject({ reason: "budget_unreadable" });
  });

  test("until the per-turn recordUsage is removed, the old row is the only difference: one extra row with no kind and no cost", async () => {
    await install();
    const router = new Router([deepseek], new HealthTracker(), asFetch(() => sse({ prompt_tokens: 100, completion_tokens: 10 })));
    const result = await router.route({ ...options, kind: "turn", agentID: "a1", jobID: "j1" });
    // task-loop.ts:897 today, once per turn:
    recordUsage(db, { turnID: "trn_1", provider: result.provider, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens });
    const all = rows(db);
    expect(all).toHaveLength(2);
    const perCall = all.filter((r) => r.call_kind !== null);
    const legacy = all.filter((r) => r.call_kind === null);
    expect(perCall).toHaveLength(1);
    expect(legacy).toHaveLength(1);
    expect(legacy[0]!.cost_usd).toBeNull(); // the duplicate never adds to spend
    expect(perCall[0]!.cost_usd).not.toBeNull();
  });
});

describe("cost the provider reports (OpenRouter usage.cost)", () => {
  const install = async () => startupS2Ledger({ db, config: {} as never });
  const usage = { prompt_tokens: 1000, completion_tokens: 100, cost: 0.000321, prompt_tokens_details: { cached_tokens: 0 } };

  test("the client reads usage.cost, and leaves it out when absent or not a number", async () => {
    const run = (u: Record<string, unknown>) => streamChat({
      baseUrl: "https://p.test/v1", apiKey: "k", model: "m", messages: [{ role: "user", content: "x" }],
      firstTokenTimeoutMs: 1000, onDelta: () => {}, fetchFn: asFetch(() => sse(u)),
    });
    expect((await run(usage)).reportedCostUsd).toBe(0.000321);
    expect((await run({ prompt_tokens: 1, completion_tokens: 1 })).reportedCostUsd).toBeUndefined();
    expect((await run({ prompt_tokens: 1, completion_tokens: 1, cost: "free" })).reportedCostUsd).toBeUndefined();
    expect((await run({ prompt_tokens: 1, completion_tokens: 1, cost: -1 })).reportedCostUsd).toBeUndefined();
    // Bring-your-own-key calls report cost 0 here; the real bill is the upstream's, so it is not trusted.
    expect((await run({ prompt_tokens: 1, completion_tokens: 1, cost: 0, is_byok: true })).reportedCostUsd).toBeUndefined();
  });

  test("the ledger stores the reported cost and says where it came from", async () => {
    await install();
    const router = new Router([deepseek], new HealthTracker(), asFetch(() => sse(usage)));
    await router.route({ ...options, kind: "turn" });
    const row = rows(db)[0]!;
    expect(row.cost_usd).toBe(0.000321);
    expect((row as unknown as { cost_source: string }).cost_source).toBe("reported");
  });

  test("with no reported cost the price table is used, and marked as such", async () => {
    await install();
    const router = new Router([deepseek], new HealthTracker(), asFetch(() => sse({ prompt_tokens: 1000, completion_tokens: 100 })));
    await router.route({ ...options, kind: "turn" });
    const row = rows(db)[0]!;
    expect(row.cost_usd).toBeCloseTo((1000 * 0.036 + 100 * 0.5) / 1e6, 12);
    expect((row as unknown as { cost_source: string }).cost_source).toBe("table");
  });

  test("a reported cost covers a model with no price entry", async () => {
    await install();
    recordModelUsage({ provider: "openrouter", model: "nobody/unknown", inputTokens: 10, outputTokens: 1, latencyMs: 5, reportedCostUsd: 0.5 } as ModelUsageEvent);
    const row = rows(db)[0]! as unknown as { cost_usd: number; cost_source: string };
    expect(row.cost_usd).toBe(0.5);
    expect(row.cost_source).toBe("reported");
  });

  test("an unpriced model with no reported cost has cost null and no source", async () => {
    await install();
    recordModelUsage({ provider: "openrouter", model: "nobody/unknown", latencyMs: 5 });
    const row = rows(db)[0]! as unknown as { cost_usd: number | null; cost_source: string | null };
    expect(row.cost_usd).toBeNull();
    expect(row.cost_source).toBeNull();
  });
});
