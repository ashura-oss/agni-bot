import { afterEach, describe, expect, test } from "bun:test";
import { createMockProvider } from "../../../tools/mock-provider/src/server";
import { startProxy, type ProxyHandle } from "../proxy";
import { priceFor, SpendGuard, worstCaseUsd } from "../spend";

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

/** An upstream that answers with fixed JSON and records what it received. */
function fakeUpstream(answer: unknown) {
  const seen: Array<{ authorization: string | null; body: any; path: string; method: string }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      seen.push({ authorization: req.headers.get("authorization"), body: await req.json().catch(() => null), path: u.pathname + u.search, method: req.method });
      return Response.json(answer);
    },
  });
  stops.push(() => void server.stop(true));
  return { base: `http://127.0.0.1:${server.port}`, seen };
}

function proxy(upstreamBase: string, guard: SpendGuard, upstreamKey?: string): ProxyHandle {
  const p = startProxy({ upstreamBase, guard, ...(upstreamKey ? { upstreamKey } : {}) });
  stops.push(p.stop);
  return p;
}

const MODEL = "deepseek/deepseek-v4.1-flash-1017";
const chat = (over: Record<string, unknown> = {}) => ({
  model: MODEL,
  messages: [{ role: "user", content: "hello" }],
  tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
  stream: true,
  max_tokens: 100,
  ...over,
});
const post = (p: ProxyHandle, body: unknown, authorization = "Bearer placeholder") =>
  fetch(`${p.url}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization }, body: JSON.stringify(body) });

describe("eval proxy", () => {
  test("a streamed call passes through and is recorded and charged", async () => {
    const mock = createMockProvider({ script: [{ text: "hi there", usage: { in: 100, out: 10 } }] });
    stops.push(mock.stop);
    const guard = new SpendGuard(1);
    const p = proxy(`http://127.0.0.1:${mock.port}`, guard);
    const res = await post(p, chat());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("hi there");
    await Bun.sleep(20);
    expect(p.calls).toHaveLength(1);
    const c = p.calls[0]!;
    expect(c.model).toBe(MODEL);
    expect(c.hadTools).toBe(true);
    expect(c.promptTokens).toBe(100);
    expect(c.completionTokens).toBe(10);
    expect(c.contentLen).toBe("hi there".length);
    expect(c.firstMs).toBeGreaterThanOrEqual(0);
    expect(c.finish).toBe("stop");
    expect(c.cachedReported).toBe(false);
    // No provider cost: 100 in and 10 out at the table price (0.036 and 0.5 per million).
    expect(c.chargedUsd).toBeCloseTo((100 * 0.036 + 10 * 0.5) / 1e6, 12);
    expect(guard.spentUsd).toBeCloseTo(c.chargedUsd, 12);
  });

  test("the real key replaces the server's header and is never recorded", async () => {
    const up = fakeUpstream({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.002 } });
    const p = proxy(up.base, new SpendGuard(1), "sk-test-REAL-KEY");
    await (await post(p, chat({ stream: false }))).text();
    expect(up.seen[0]!.authorization).toBe("Bearer sk-test-REAL-KEY");
    const recorded = JSON.stringify(p.calls);
    expect(recorded).not.toContain("sk-test-REAL-KEY");
    expect(recorded).not.toContain("placeholder");
    expect(p.calls[0]!.chargedUsd).toBe(0.002);
    expect(p.calls[0]!.reportedCostUsd).toBe(0.002);
  });

  test("without a key the server's own header is passed on", async () => {
    const up = fakeUpstream({ choices: [] });
    const p = proxy(up.base, new SpendGuard(1));
    await (await post(p, chat({ stream: false }), "Bearer stub-key")).text();
    expect(up.seen[0]!.authorization).toBe("Bearer stub-key");
  });

  test("the cap refuses a call before it reaches the provider", async () => {
    const up = fakeUpstream({ choices: [] });
    const guard = new SpendGuard(0.0001);
    const p = proxy(up.base, guard);
    const res = await post(p, chat({ max_tokens: 100_000 }));
    expect(res.status).toBe(402);
    expect(((await res.json()) as any).error.message).toContain("eval spend cap");
    expect(up.seen).toHaveLength(0);
    expect(p.calls[0]!.blocked).toBe(true);
    expect(guard.blockedCalls).toBe(1);
    expect(guard.spentUsd).toBe(0);
  });

  test("a call that reports no usage is charged its whole worst case", async () => {
    const up = fakeUpstream({ choices: [] });
    const guard = new SpendGuard(1);
    const p = proxy(up.base, guard);
    const body = chat({ stream: false });
    await (await post(p, body)).text();
    const expected = worstCaseUsd({ ...body, usage: { include: true } }, priceFor(MODEL));
    expect(p.calls[0]!.chargedUsd).toBeCloseTo(expected, 12);
  });

  test("cached tokens are recorded only when the provider reports them", async () => {
    const up = fakeUpstream({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 600 } } });
    const p = proxy(up.base, new SpendGuard(1));
    await (await post(p, chat({ stream: false }))).text();
    expect(p.calls[0]!.cachedReported).toBe(true);
    expect(p.calls[0]!.cachedTokens).toBe(600);
  });

  test("only POST /api/v1/chat/completions is forwarded; other paths and methods never reach the provider", async () => {
    const up = fakeUpstream({ choices: [] });
    const guard = new SpendGuard(1);
    const p = proxy(up.base, guard);
    const origin = p.url.replace(/\/api\/v1$/, "");
    const json = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(chat({ stream: false })) };
    expect((await fetch(`${p.url}/models`)).status).toBe(404);
    expect((await fetch(`${p.url}/key`)).status).toBe(404);
    expect((await fetch(`${p.url}/embeddings`, json)).status).toBe(404);
    expect((await fetch(`${origin}/v1/chat/completions`, json)).status).toBe(404);
    expect((await fetch(`${origin}/api/v1/chat/completions/../../admin`, json)).status).toBe(404);
    expect((await fetch(`${p.url}/chat/completions`, { method: "GET" })).status).toBe(404);
    expect((await fetch(`${p.url}/chat/completions`, { method: "PUT", body: "{}" })).status).toBe(404);
    expect(up.seen).toHaveLength(0);
    expect(guard.spentUsd).toBe(0);
    expect(p.calls.every((c) => c.status === 404 && (c.error ?? "").includes("is not forwarded"))).toBe(true);
  });

  test("the forwarded call goes to the chat path with no query string", async () => {
    const up = fakeUpstream({ choices: [] });
    const p = proxy(up.base, new SpendGuard(1));
    await (await fetch(`${p.url}/chat/completions?redirect=http://evil.example`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(chat({ stream: false })) })).text();
    expect(up.seen.map((s) => `${s.method} ${s.path}`)).toEqual(["POST /api/v1/chat/completions"]);
  });

  test("chat bodies ask the provider for usage; nothing else in the body changes", async () => {
    const up = fakeUpstream({ choices: [] });
    const p = proxy(up.base, new SpendGuard(1));
    const body = chat({ stream: false, temperature: 0.7 });
    await (await post(p, body)).text();
    expect(up.seen[0]!.body).toEqual({ ...body, usage: { include: true } });
  });
});
