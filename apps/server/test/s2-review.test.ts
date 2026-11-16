import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { openDatabase } from "../src/db";
import { streamChat } from "../src/models/client";
import { HealthTracker } from "../src/models/health";
import { FALLBACK_PRICE, computeCostUsd, estimateTokens, resetPriceWarnings } from "../src/models/prices";
import type { ProviderConfig } from "../src/models/providers";
import { MidStreamError, RouteRefusedError, Router, setRouteGate } from "../src/models/router";
import { recordModelUsage, setUsageRecorder } from "../src/models/usage-hook";
import { checkBudget, configureBudget, grantContinueOnce } from "../src/policy/budget";
import { setPauseCheck, startupS2Ledger } from "../src/startup/s2-ledger";
import { setSpendCaps } from "../src/stores/policy-settings";

const encoder = new TextEncoder();
const chunk = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;
function stream(parts: string[], end: "done" | "error" = "done"): Response {
  // An errored stream drops what is still queued, so the error comes on the read after the data.
  let sent = false;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) { sent = true; for (const part of parts) controller.enqueue(encoder.encode(part)); if (end === "done") controller.close(); return; }
      controller.error(new Error("connection reset"));
    },
  }), { status: 200 });
}
const okStream = (usage?: Record<string, unknown>): Response =>
  stream([chunk({ choices: [{ delta: { content: "hi" } }] }), chunk({ choices: [{ delta: {}, finish_reason: "stop" }] }), ...(usage ? [chunk({ choices: [], usage })] : []), "data: [DONE]\n\n"]);

const openrouter: ProviderConfig = { id: "openrouter", label: "OpenRouter", baseUrl: "https://or.test/v1", apiKey: "k", model: "deepseek/deepseek-v4.1-flash-1017" };
const other: ProviderConfig = { id: "custom", label: "Custom", baseUrl: "https://c.test/v1", apiKey: "k", model: "mystery-model" };
const call = { messages: [{ role: "user" as const, content: "hello there" }], firstTokenTimeoutMs: 1000, onDelta: () => {}, agentID: "a1", kind: "turn" as const };

interface Row { cost_usd: number | null; cost_source: string | null; root_job_id: string | null; input_tokens: number; output_tokens: number; call_kind: string | null }
const rows = (db: Database): Row[] => db.query<Row, []>("SELECT * FROM usage_ledger ORDER BY created_at, rowid").all();

let db: Database;
let seq = 0;
const install = () => startupS2Ledger({ db, config: {} as never });
function spend(costUsd: number | null, who: { agentID?: string; jobID?: string; rootJobID?: string } = {}): void {
  const at = new Date();
  db.run(
    `INSERT INTO usage_ledger (id, provider, model, input_tokens, output_tokens, day, created_at, cost_usd, agent_id, job_id, root_job_id, call_kind)
     VALUES (?, 'openrouter', 'm', 1, 1, ?, ?, ?, ?, ?, ?, 'turn')`,
    [`use_r${++seq}`, at.toISOString().slice(0, 10), at.toISOString(), costUsd, who.agentID ?? null, who.jobID ?? null, who.rootJobID ?? who.jobID ?? null],
  );
}

beforeEach(() => {
  resetPriceWarnings();
  db = openDatabase(":memory:");
  configureBudget(db);
});
afterEach(() => {
  setUsageRecorder(() => {});
  setRouteGate(null);
  setPauseCheck(null);
  configureBudget(null);
  db.close();
});

describe("1. the usage-only final chunk", () => {
  const run = (response: () => Response) => streamChat({
    baseUrl: "https://p.test/v1", apiKey: "k", model: "m", messages: [{ role: "user", content: "x" }],
    firstTokenTimeoutMs: 1000, onDelta: () => {}, fetchFn: (async () => response()) as unknown as typeof fetch,
  });

  test("usage, cached tokens and cost are read from a chunk with empty choices", async () => {
    const result = await run(() => okStream({ prompt_tokens: 900, completion_tokens: 30, cost: 0.0004, prompt_tokens_details: { cached_tokens: 100 } }));
    expect(result.inputTokens).toBe(900);
    expect(result.outputTokens).toBe(30);
    expect(result.cachedInputTokens).toBe(100);
    expect(result.reportedCostUsd).toBe(0.0004);
  });

  test("every streaming request asks the provider to include usage", async () => {
    let body: Record<string, unknown> = {};
    await streamChat({
      baseUrl: "https://p.test/v1", apiKey: "k", model: "m", messages: [{ role: "user", content: "x" }],
      firstTokenTimeoutMs: 1000, onDelta: () => {},
      fetchFn: (async (_url: string, init?: RequestInit) => { body = JSON.parse(String(init?.body)); return okStream(); }) as unknown as typeof fetch,
    });
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });
});

describe("2. unknown cost is never $0", () => {
  test("an unpriced model with known tokens is charged the conservative fallback price", () => {
    expect(FALLBACK_PRICE).toEqual({ inputPerM: 1, cachedInputPerM: 1, outputPerM: 4 });
    const cost = computeCostUsd({ provider: "custom", model: "mystery-model", inputTokens: 1_000_000, outputTokens: 1_000_000 }, () => {});
    expect(cost).toBeCloseTo(5, 9);
  });

  test("a free or local model with no token counts still costs 0, not unknown", () => {
    expect(computeCostUsd({ provider: "lmstudio", model: "local" })).toBe(0);
  });

  test("the ledger stores the fallback with its source", async () => {
    await install();
    recordModelUsage({ provider: "custom", model: "mystery-model", inputTokens: 1000, outputTokens: 100, latencyMs: 1, agentID: "a", kind: "turn" });
    const [row] = rows(db);
    expect(row!.cost_usd).toBeCloseTo((1000 * 1 + 100 * 4) / 1e6, 12);
    expect(row!.cost_source).toBe("fallback");
  });

  test("a scope with a call of unknown cost is denied as cost_unknown: root job, bot and day", () => {
    spend(null, { agentID: "a", jobID: "j", rootJobID: "r" });
    expect(checkBudget({ agentID: "z", jobID: "r", rootJobID: "r" })).toMatchObject({ ok: false, reason: "cost_unknown", scope: "job" });
    expect(checkBudget({ agentID: "a", jobID: "other" })).toMatchObject({ ok: false, reason: "cost_unknown", scope: "bot" });
    expect(checkBudget({ agentID: "z", jobID: "other" })).toMatchObject({ ok: false, reason: "cost_unknown", scope: "day" });
  });

  test("with no cap on a scope there is nothing to be unsure about", () => {
    setSpendCaps(db, { dayUsd: null, perBotDayUsd: null, perJobUsd: null });
    spend(null, { agentID: "a", jobID: "j" });
    expect(checkBudget({ agentID: "a", jobID: "j" })).toEqual({ ok: true });
  });

  test("Continue once clears a cost_unknown stop for that scope only", () => {
    spend(null, { agentID: "a", jobID: "r" });
    expect(checkBudget({ agentID: "a", jobID: "r" })).toMatchObject({ reason: "cost_unknown", scope: "job" });
    expect(grantContinueOnce("r")).toBe(0.5);
    // job scope is cleared, but the bot and day scopes also hold the unknown row
    expect(checkBudget({ agentID: "a", jobID: "r" })).toMatchObject({ reason: "cost_unknown", scope: "bot" });
  });
});

describe("3. a budget check that cannot read its state fails closed", () => {
  test("no registered database denies as budget_unreadable", () => {
    configureBudget(null);
    expect(checkBudget({ agentID: "a" })).toMatchObject({ ok: false, reason: "budget_unreadable" });
  });

  test("a database error denies as budget_unreadable", () => {
    db.exec("DROP TABLE policy_settings");
    expect(checkBudget({ agentID: "a" })).toMatchObject({ ok: false, reason: "budget_unreadable" });
  });

  test("a failed ledger write denies further calls until a write succeeds again", async () => {
    await install();
    db.exec("ALTER TABLE usage_ledger RENAME TO usage_ledger_away");
    recordModelUsage({ provider: "openrouter", model: "qwen/qwen3.8-flash", inputTokens: 1, outputTokens: 1, latencyMs: 1, agentID: "a", kind: "turn" });
    expect(checkBudget({ agentID: "a" })).toMatchObject({ ok: false, reason: "budget_unreadable" });
    db.exec("ALTER TABLE usage_ledger_away RENAME TO usage_ledger");
    expect(checkBudget({ agentID: "a" })).toEqual({ ok: true });
    expect(rows(db)).toHaveLength(0); // the probe leaves nothing behind
  });
});

describe("4. one choke point in the router", () => {
  const route = (router: Router, extra: Record<string, unknown> = {}) => router.route({ ...call, ...extra });

  test("without a gate nothing changes: an unattributed call goes through", async () => {
    const router = new Router([openrouter], new HealthTracker(), (async () => okStream({ prompt_tokens: 1, completion_tokens: 1 })) as unknown as typeof fetch);
    expect((await router.route({ messages: call.messages, firstTokenTimeoutMs: 1000, onDelta: () => {} })).text).toBe("hi");
  });

  test("with the gate installed a call with no agent or no kind is refused before any request", async () => {
    await install();
    let fetched = 0;
    const router = new Router([openrouter], new HealthTracker(), (async () => { fetched++; return okStream(); }) as unknown as typeof fetch);
    await expect(router.route({ messages: call.messages, firstTokenTimeoutMs: 1000, onDelta: () => {} })).rejects.toBeInstanceOf(RouteRefusedError);
    await expect(route(router, { kind: undefined })).rejects.toMatchObject({ reason: "unattributed" });
    await expect(route(router, { agentID: undefined })).rejects.toMatchObject({ reason: "unattributed" });
    expect(fetched).toBe(0);
  });

  test("an over-budget call is refused with the cap that stopped it, and nothing is sent", async () => {
    await install();
    spend(0.6, { agentID: "a1", jobID: "j1" });
    let fetched = 0;
    const router = new Router([openrouter], new HealthTracker(), (async () => { fetched++; return okStream(); }) as unknown as typeof fetch);
    const error = await route(router, { jobID: "j1" }).catch((e: unknown) => e) as RouteRefusedError;
    expect(error).toBeInstanceOf(RouteRefusedError);
    expect(error.reason).toBe("over_cap");
    expect(error.detail).toMatchObject({ scope: "job", capUsd: 0.5 });
    expect(fetched).toBe(0);
  });

  test("a paused run is refused through the injectable pause check", async () => {
    await install();
    setPauseCheck((c) => (c.agentID === "a1" ? "everything is paused" : null));
    const router = new Router([openrouter], new HealthTracker(), (async () => okStream()) as unknown as typeof fetch);
    await expect(route(router)).rejects.toMatchObject({ reason: "paused" });
    expect((await route(router, { agentID: "a2" })).text).toBe("hi");
  });

  test("a gate that throws refuses the call", async () => {
    setRouteGate(() => { throw new Error("boom"); });
    const router = new Router([openrouter], new HealthTracker(), (async () => okStream()) as unknown as typeof fetch);
    await expect(route(router)).rejects.toMatchObject({ reason: "gate_failed" });
  });

  test("an allowed call passes the gate once, even when the provider is retried", async () => {
    let gated = 0;
    setRouteGate(() => { gated++; return { ok: true }; });
    let calls = 0;
    const before = Router.retryBackoffMs;
    Router.retryBackoffMs = 0;
    try {
      const router = new Router([openrouter], new HealthTracker(), (async () => (++calls === 1 ? new Response("down", { status: 503 }) : okStream())) as unknown as typeof fetch);
      await route(router);
    } finally { Router.retryBackoffMs = before; }
    expect(gated).toBe(1);
  });
});

describe("5. a child that passes only its job id resolves the real root", () => {
  const job = (id: string, payload: unknown) =>
    db.run("INSERT INTO jobs (id, kind, payload, state, run_at, created_at, updated_at) VALUES (?, 'turn', ?, 'queued', 'x', 'x', 'x')", [id, JSON.stringify(payload)]);

  test("the recorder writes the root named in the job's payload, not the job itself", async () => {
    await install();
    job("job_root", {});
    job("job_child", { rootJob: "job_root" });
    recordModelUsage({ provider: "openrouter", model: "qwen/qwen3.8-flash", inputTokens: 1, outputTokens: 1, latencyMs: 1, agentID: "a", kind: "turn", jobID: "job_child" });
    expect(rows(db)[0]!.root_job_id).toBe("job_root");
  });

  test("a root job is its own root; a job nobody recorded is too", async () => {
    await install();
    job("job_root", { rootJob: null });
    recordModelUsage({ provider: "openrouter", model: "qwen/qwen3.8-flash", inputTokens: 1, outputTokens: 1, latencyMs: 1, agentID: "a", kind: "turn", jobID: "job_root" });
    recordModelUsage({ provider: "openrouter", model: "qwen/qwen3.8-flash", inputTokens: 1, outputTokens: 1, latencyMs: 1, agentID: "a", kind: "turn", jobID: "job_missing" });
    expect(rows(db).map((r) => r.root_job_id)).toEqual(["job_root", "job_missing"]);
  });

  test("the per-job cap counts a child's spend against its root even if the child passes only its job id", () => {
    job("job_root", {});
    job("job_child", { rootJob: "job_root" });
    spend(0.3, { agentID: "a", jobID: "job_root" });
    spend(0.25, { agentID: "b", jobID: "job_child", rootJobID: "job_root" });
    expect(checkBudget({ agentID: "b", jobID: "job_child" })).toMatchObject({ ok: false, scope: "job" });
  });
});

describe("6. reported cost is trusted only from openrouter", () => {
  test("another provider's cost field is ignored in favour of the price table", async () => {
    await install();
    recordModelUsage({ provider: "custom", model: "qwen/qwen3.8-flash", inputTokens: 1000, outputTokens: 100, latencyMs: 1, agentID: "a", kind: "turn", reportedCostUsd: 0 } as never);
    const [row] = rows(db);
    expect(row!.cost_source).toBe("table");
    expect(row!.cost_usd).toBeCloseTo((1000 * 0.15 + 100 * 0.47) / 1e6, 12);
  });

  test("openrouter's own figure is kept", async () => {
    await install();
    recordModelUsage({ provider: "openrouter", model: "qwen/qwen3.8-flash", inputTokens: 1000, outputTokens: 100, latencyMs: 1, agentID: "a", kind: "turn", reportedCostUsd: 0.01 } as never);
    expect(rows(db)[0]).toMatchObject({ cost_usd: 0.01, cost_source: "reported" });
  });
});

describe("7. streams that fail after delivering tokens are still billed", () => {
  test("a stream cut mid-answer records an estimated cost, once", async () => {
    await install();
    const text = "word ".repeat(200);
    const router = new Router([openrouter], new HealthTracker(), (async () => stream([chunk({ choices: [{ delta: { content: text } }] })], "error")) as unknown as typeof fetch);
    await expect(router.route(call)).rejects.toBeInstanceOf(MidStreamError);
    const all = rows(db);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ cost_source: "estimate", call_kind: "turn" });
    expect(all[0]!.output_tokens).toBe(estimateTokens(text));
    expect(all[0]!.input_tokens).toBeGreaterThan(0);
    expect(all[0]!.cost_usd).toBeGreaterThan(0);
  });

  test("an owner Stop that lands after tokens arrived is billed too", async () => {
    await install();
    const controller = new AbortController();
    let sent = false;
    const fetchFn = (async () => new Response(new ReadableStream<Uint8Array>({
      pull(c) {
        if (!sent) { sent = true; c.enqueue(encoder.encode(chunk({ choices: [{ delta: { content: "partial answer text" } }] }))); return; }
        controller.abort();
        c.error(new Error("aborted"));
      },
    }), { status: 200 })) as unknown as typeof fetch;
    const router = new Router([openrouter], new HealthTracker(), fetchFn);
    await expect(router.route({ ...call, signal: controller.signal })).rejects.toBeDefined();
    const all = rows(db);
    expect(all).toHaveLength(1);
    expect(all[0]!.cost_source).toBe("estimate");
  });

  test("a failure with nothing delivered records nothing", async () => {
    await install();
    const router = new Router([openrouter], new HealthTracker(), (async () => new Response("bad", { status: 400 })) as unknown as typeof fetch);
    await expect(router.route(call)).rejects.toBeDefined();
    expect(rows(db)).toHaveLength(0);
  });

  test("the token estimate counts non-ASCII text one token per character", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("你好世界")).toBe(4);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("8. Continue once", () => {
  test("it grants only the scope that stopped the run and never bypasses the others", () => {
    setSpendCaps(db, { perJobUsd: 0.5, perBotDayUsd: 1, dayUsd: 1.2 });
    spend(0.4, { agentID: "a", jobID: "elsewhere" });
    spend(0.5, { agentID: "a", jobID: "r" });
    expect(checkBudget({ agentID: "a", jobID: "r" })).toMatchObject({ reason: "over_cap", scope: "job" });
    expect(grantContinueOnce("r")).toBe(0.5);
    expect(checkBudget({ agentID: "a", jobID: "r" })).toEqual({ ok: true });
    spend(0.05, { agentID: "a", jobID: "r" }); // job: 0.05 of 0.5 granted used; bot a 0.95 < 1; day 0.95 < 1.2
    expect(checkBudget({ agentID: "a", jobID: "r" })).toEqual({ ok: true });
    spend(0.1, { agentID: "a", jobID: "r" }); // bot a is now over its $1 even though the job still has grant left
    expect(checkBudget({ agentID: "a", jobID: "r" })).toMatchObject({ ok: false, scope: "bot" });
  });

  test("a grant made after a bot stop does not lift the job or day cap", () => {
    for (let i = 0; i < 4; i++) spend(0.3, { agentID: "a", jobID: `j${i}` });
    expect(checkBudget({ agentID: "a", jobID: "jx" })).toMatchObject({ scope: "bot" });
    grantContinueOnce("jx");
    expect(checkBudget({ agentID: "a", jobID: "jx" })).toEqual({ ok: true });
    spend(0.5, { agentID: "a", jobID: "jx" });
    expect(checkBudget({ agentID: "a", jobID: "jx" })).toMatchObject({ ok: false, scope: "job" });
    expect(checkBudget({ agentID: "a", jobID: "jy" })).toMatchObject({ ok: false, scope: "bot" });
  });

  test("the amount is the per-job cap, or $0.50 when that cap is off", () => {
    setSpendCaps(db, { perJobUsd: 0.2, dayUsd: 0.1 });
    spend(0.1, { agentID: "a", jobID: "r" });
    expect(checkBudget({ agentID: "a", jobID: "r" })).toMatchObject({ scope: "day" });
    expect(grantContinueOnce("r")).toBe(0.2);
    setSpendCaps(db, { perJobUsd: null });
    spend(0.2, { agentID: "a", jobID: "s" });
    expect(checkBudget({ agentID: "a", jobID: "s" })).toMatchObject({ scope: "day" });
    expect(grantContinueOnce("s")).toBe(0.5);
  });

  test("a run that was never stopped has nothing to continue", () => {
    expect(grantContinueOnce("never-stopped")).toBe(0);
    expect(checkBudget({ agentID: "a", jobID: "never-stopped" })).toEqual({ ok: true });
  });

  test("no tool or agent code can call it: only an owner frame handler may", () => {
    const root = join(import.meta.dir, "..", "src");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) { walk(path); continue; }
        if (!path.endsWith(".ts")) continue;
        const rel = relative(root, path).replace(/\\/g, "/");
        if (rel === "policy/budget.ts") continue;
        if (readFileSync(path, "utf8").includes("grantContinueOnce")) offenders.push(rel);
      }
    };
    walk(root);
    // The one allowed caller is the owner-frame handler S2-2 adds.
    expect(offenders.filter((file) => file !== "ws/dispatch.ts")).toEqual([]);
  });
});
