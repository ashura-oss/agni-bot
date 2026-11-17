/**
 * S2-INT item 1 and item 5: the router gate is wired to the real pause switch, a missing pause check
 * refuses, every production caller of the router gets through the real startup hooks, and one model
 * call is one ledger row.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { HealthTracker } from "../src/models/health";
import type { ProviderConfig } from "../src/models/providers";
import { RouteRefusedError, Router, setRouteGate } from "../src/models/router";
import { setUsageRecorder } from "../src/models/usage-hook";
import { setAuditSink } from "../src/policy/audit-sink";
import { configureBudget } from "../src/policy/budget";
import { resetPolicyHooks } from "../src/policy/hooks";
import { setAgentEnabled, setAllPaused, unbindPauseStore } from "../src/policy/pause";
import { startupS2 } from "../src/startup/s2";
import { stopPauseWatcher } from "../src/startup/s2-audit";
import { setPauseCheck } from "../src/startup/s2-ledger";
import { compactChannelHistory } from "../src/agent/compactor";
import { criticReview } from "../src/agent/critic";
import { summarizeBlock } from "../src/agent/rollover";
import { runTaskTurn } from "../src/agent/task-loop";
import { resolvePersona, updatePersona, type ResolvedPersona } from "../src/agent/personas";
import { JobRunner } from "../src/jobs/runner";
import { registerTaggerJob } from "../src/jobs/tagger";
import { enqueueJob } from "../src/stores/jobs";
import { appendChannelMessage } from "../src/stores/channels";
import { ensureConversation, openSession } from "../src/stores/conversations";
import { appendMessage, createThread } from "../src/stores/threads";
import { dayTotals } from "../src/stores/usage";

const provider: ProviderConfig = { id: "test", label: "Test", baseUrl: "https://test.local/v1", apiKey: "k", model: "mock" };
const encoder = new TextEncoder();
const sse = (events: unknown[]): Response => new Response(new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(encoder.encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n"));
    controller.close();
  },
}), { status: 200 });
const usage = { prompt_tokens: 100, completion_tokens: 20 };
const say = (text: string): Response => sse([{ choices: [{ delta: { content: text } }] }, { choices: [], usage }]);

let db: Database;
let fetched = 0;
let answer: () => Response;
const router = (): Router => new Router([provider], new HealthTracker(), (async () => { fetched++; return answer(); }) as unknown as typeof fetch);

interface Row { agent_id: string | null; call_kind: string | null; purpose: string | null; cost_usd: number | null }
const ledger = (): Row[] => db.query<Row, []>("SELECT agent_id, call_kind, purpose, cost_usd FROM usage_ledger ORDER BY created_at, rowid").all();

beforeEach(async () => {
  db = openDatabase(":memory:");
  fetched = 0;
  answer = () => say("ok");
  await startupS2({ db, config: {} as never });
});
afterEach(() => {
  stopPauseWatcher();
  unbindPauseStore();
  setAuditSink({ record() {} });
  setUsageRecorder(() => {});
  setRouteGate(null);
  setPauseCheck(null);
  resetPolicyHooks();
  configureBudget(null);
  db.close();
});

const call = { messages: [{ role: "user" as const, content: "hi" }], firstTokenTimeoutMs: 1000, onDelta: () => {}, agentID: "ea", kind: "turn" as const };

describe("the router gate and the pause switch", () => {
  test("a missing pause check refuses the call: the gate fails closed", async () => {
    setPauseCheck(null);
    const error = await router().route(call).catch((e: unknown) => e) as RouteRefusedError;
    expect(error).toBeInstanceOf(RouteRefusedError);
    expect(error.reason).toBe("pause_check_missing");
    expect(fetched).toBe(0);
  });

  test("pause-all refuses every model call, and nothing is sent", async () => {
    setAllPaused(db, true, { actor: "test" });
    const error = await router().route(call).catch((e: unknown) => e) as RouteRefusedError;
    expect(error.reason).toBe("paused");
    expect(fetched).toBe(0);
    setAllPaused(db, false, { actor: "test" });
    expect((await router().route(call)).text).toBe("ok");
  });

  test("a bot that is off is refused under both of its ids, and another bot is not", async () => {
    setAgentEnabled(db, "ea", false, { actor: "test" });
    for (const agentID of ["ea", "agni"]) {
      const error = await router().route({ ...call, agentID }).catch((e: unknown) => e) as RouteRefusedError;
      expect({ agentID, reason: error.reason }).toEqual({ agentID, reason: "paused" });
    }
    expect(fetched).toBe(0);
    expect((await router().route({ ...call, agentID: "researcher" })).text).toBe("ok");
  });
});

describe("every production caller gets through the real startup hooks", () => {
  test("task loop, compactor, critic, rollover and tagger: none is refused, each is one ledger row", async () => {
    answer = () => say(JSON.stringify({ updated_summary: "s", decisions: ["d"], facts: [] }));
    const r = router();

    // The task loop: a persona under its alias id, as chat turns run.
    const persona: ResolvedPersona = {
      id: "agni", name: "Agni", color: "#f0b95a", role: "front desk",
      systemPromptTemplate: "Be helpful.", systemPrompt: "Be helpful.", tools: ["tasks_list"],
    };
    const thread = createThread(db, persona.id);
    const turn = await runTaskTurn(db, r, { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, {
      threadID: thread.id, text: "hello", persona, emit: () => undefined, signal: new AbortController().signal,
    });
    expect(turn.stopReason).toBe("end");

    // The compactor.
    for (let index = 0; index < 37; index++) {
      appendChannelMessage(db, { channelID: "main", fromType: index % 2 ? "agent" : "user", fromID: index % 2 ? "ea" : "user", text: `message ${index}` });
    }
    await compactChannelHistory(db, r, "main", "ea");

    // The critic.
    updatePersona(db, "ea", { critic: "researcher" });
    const review = criticReview(db, r, 1000, resolvePersona(db, "ea")!);
    expect(await review!({ to: "a@b.c", subject: "Hi", body: "Body" }, new AbortController().signal)).not.toBeNull();

    // The rollover summary.
    const conversation = ensureConversation(db, "ea");
    const block = openSession(db, conversation, "manual", null);
    appendMessage(db, { threadID: block.id, role: "user", text: "we decided to use SQLite" });
    expect(await summarizeBlock({ db, router: r, firstTokenTimeoutMs: 1000 }, conversation, block)).not.toBeNull();

    // The tagger. The compactor left its last messages uncompacted, and the batch reads untagged ones.
    const runner = new JobRunner(db, () => undefined, { maxPerTick: 5 });
    registerTaggerJob(runner, { db, router: r, emit: () => undefined });
    enqueueJob(db, { kind: "tagger", payload: { channelID: "main" }, runAt: new Date().toISOString() });
    await runner.tick();

    const rows = ledger();
    expect(rows.map((row) => row.purpose)).toEqual(["chat", "compaction", "critic", "summary", "tagger"]);
    expect(rows.map((row) => row.call_kind)).toEqual(["turn", "side", "side", "side", "side"]);
    expect(rows.every((row) => row.agent_id !== null)).toBe(true);
    // Every call was priced from the provider's own usage, none left unknown.
    expect(rows.every((row) => row.cost_usd !== null)).toBe(true);
    expect(fetched).toBe(5);
  });
});

describe("one ledger row per model call (item 5)", () => {
  test("a turn with a tool call and a final answer is two calls, two rows, and no per-turn summary row", async () => {
    let request = 0;
    answer = () => (++request === 1
      ? sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "tasks_list", arguments: "{}" } }] } }] }, { choices: [], usage }])
      : say("done"));
    const persona: ResolvedPersona = {
      id: "ea", name: "Agni", color: "#f0b95a", role: "front desk",
      systemPromptTemplate: "Be helpful.", systemPrompt: "Be helpful.", tools: ["tasks_list"],
    };
    const thread = createThread(db, persona.id);
    const turn = await runTaskTurn(db, router(), { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, {
      threadID: thread.id, text: "list my tasks", persona, emit: () => undefined, signal: new AbortController().signal,
    });
    expect(turn.stopReason).toBe("end");
    expect(fetched).toBe(2);
    const rows = ledger();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.call_kind === "turn")).toBe(true);
    // The day's totals still add up across calls.
    expect(dayTotals(db)).toMatchObject({ turns: 2, inputTokens: 200, outputTokens: 40 });
  });
});
