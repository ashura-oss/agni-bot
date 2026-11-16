/**
 * An answer the model had to stop writing (finish reason "length") is not a
 * finished answer, and a budgeted turn's per-step ceiling is not 2,048.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { HealthTracker } from "../src/models/health";
import type { ProviderConfig } from "../src/models/providers";
import { Router } from "../src/models/router";
import { runTaskTurn } from "../src/agent/task-loop";
import type { ResolvedPersona } from "../src/agent/personas";
import { createThread } from "../src/stores/threads";

const provider: ProviderConfig = { id: "test", label: "Test", baseUrl: "https://test.local/v1", apiKey: "test", model: "mock" };
const persona: ResolvedPersona = {
  id: "agni", name: "Agni", color: "#f0b95a", role: "front desk",
  systemPromptTemplate: "Be helpful.", systemPrompt: "Be helpful.", tools: ["tasks_list"],
};
const settings = { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 };
let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

function stream(events: unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(body)); controller.close(); },
  }), { status: 200 });
}
const text = (content: string, finish: "stop" | "length" = "stop", out = 50): Response =>
  stream([{ choices: [{ delta: { content } }] }, { choices: [{ delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: out } }]);

interface Sent { max_tokens?: number; messages: Array<{ role: string; content: unknown }> }
function scripted(steps: Response[]): { router: Router; sent: Sent[] } {
  const sent: Sent[] = [];
  const router = new Router([provider], new HealthTracker(), (async (_url: unknown, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Sent);
    return steps[Math.min(sent.length - 1, steps.length - 1)]!;
  }) as unknown as typeof fetch);
  return { router, sent };
}
async function run(router: Router, extra: { maxTokens?: number } = {}) {
  db = openDatabase(":memory:");
  const thread = createThread(db, persona.id);
  return runTaskTurn(db, router, settings, { threadID: thread.id, text: "write the essay", persona, emit: () => undefined, signal: new AbortController().signal, ...extra });
}

describe("per-step output ceiling of a budgeted turn", () => {
  test("is the default output ceiling, not 2,048, while the budget allows it", async () => {
    const { router, sent } = scripted([text("done")]);
    await run(router, { maxTokens: 20_000 });
    expect(sent[0]!.max_tokens).toBe(8_192);
  });

  test("never asks for more than the budget that is left", async () => {
    const { router, sent } = scripted([text("done")]);
    await run(router, { maxTokens: 3_000 });
    expect(sent[0]!.max_tokens).toBe(3_000);
  });
});

describe("an answer cut off at the output ceiling is not a finished answer", () => {
  test("the model is asked to carry on, and the pieces become one answer", async () => {
    const { router, sent } = scripted([text("First half of the essay, ", "length", 8_192), text("second half.", "stop", 30)]);
    const result = await run(router, { maxTokens: 20_000 });
    expect(result.stopReason).toBe("end");
    expect(result.text).toBe("First half of the essay, second half.");
    // The second request carries the first half as the assistant's own words, then the ask to continue.
    const last = sent[1]!.messages.slice(-2);
    expect(last[0]).toMatchObject({ role: "assistant", content: "First half of the essay, " });
    expect(last[1]!.role).toBe("user");
  });

  test("a chat turn without a budget is handled the same way", async () => {
    const { router } = scripted([text("Part one. ", "length", 8_192), text("Part two.", "stop", 30)]);
    const result = await run(router);
    expect(result.stopReason).toBe("end");
    expect(result.text).toBe("Part one. Part two.");
  });

  test("still cut off after two continuations, the turn ends as not finished with a plain note", async () => {
    const { router, sent } = scripted([text("a ", "length", 8_192), text("b ", "length", 8_192), text("c ", "length", 8_192), text("never reached", "stop")]);
    const result = await run(router, { maxTokens: 100_000 });
    expect(result.stopReason).toBe("budget");
    expect(sent).toHaveLength(3);
    expect(result.text.startsWith("a b c")).toBe(true);
    expect(result.text).toMatch(/cut off/i);
  });
});
