/**
 * S2-INT items 3 and 4 (hooks): the spend frames are live after the real startup hooks, a run that hits a cap
 * is stopped with the owner wording from the card design and told to the owner, and "Continue once" is an
 * owner frame that lets that run go on.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db";
import { HealthTracker } from "../src/models/health";
import type { ProviderConfig } from "../src/models/providers";
import { Router, RouteRefusedError } from "../src/models/router";
import { setPolicyHooks } from "../src/policy/hooks";
import { budgetStopMessage, budgetStopFromRefusal, money } from "../src/policy/budget-messages";
import { startupS2, resetS2Startup } from "../src/startup/s2";
import { runTaskTurn } from "../src/agent/task-loop";
import { createThread } from "../src/stores/threads";
import { listAuditEvents } from "../src/stores/audit";
import { startHarness, type Harness, type TestClient } from "./ws-harness";

const encoder = new TextEncoder();
const reply = (text: string): Response => new Response(new ReadableStream<Uint8Array>({
  start(controller) {
    for (const event of [{ choices: [{ delta: { content: text } }] }, { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } }]) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    }
    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    controller.close();
  },
}), { status: 200 });

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
  resetS2Startup();
});

let fetched = 0;
async function start(): Promise<{ client: TestClient; h: Harness }> {
  fetched = 0;
  const h = await startHarness({ fetch: (async () => { fetched++; return reply("done"); }) as unknown as typeof fetch });
  harness = h;
  // What `serve()` does once the database is open.
  await startupS2({ db: h.db, config: {} as never });
  const client = await h.connect();
  client.send({ type: "agent.rename", agentId: "ea", name: "Ava" });
  await client.next("agent.updated");
  return { client, h };
}

describe("the spend frames are live after startup", () => {
  test("spend.status answers with today's numbers and the default caps", async () => {
    const { client } = await start();
    client.send({ type: "spend.status" });
    const ok = await client.next("spend.status.ok");
    expect(ok.caps).toEqual({ dayUsd: 2, perBotDayUsd: 1, perJobUsd: 0.5 });
    expect(ok.daySpentUsd).toBe(0);
  });

  test("spend.caps.set changes the caps and tells everyone", async () => {
    const { client } = await start();
    client.send({ type: "spend.caps.set", dayUsd: 3 });
    expect((await client.next("spend.status.ok")).caps.dayUsd).toBe(3);
  });
});

describe("a run that hits a cap, and Continue once", () => {
  test("the owner is told in the card wording, a frame carries the run key, and spend.continue lets the run go on", async () => {
    const { client, h } = await start();
    client.send({ type: "spend.caps.set", dayUsd: 0.0001, perBotDayUsd: null });
    await client.next("spend.status.ok");

    client.send({ type: "msg.send", channelId: "main", text: "first" });
    expect((await client.next("turn.end")).stopReason).toBe("end");
    expect(fetched).toBe(1);

    client.send({ type: "msg.send", channelId: "main", text: "second" });
    const stopped = await client.next("spend.stopped");
    expect(stopped).toMatchObject({ runKey: "agent:ea", scope: "day", reason: "over_cap", agentId: "ea" });
    expect(stopped.message).toContain("Ava stopped: today's spending limit is used up.");
    expect(stopped.message).toContain("All bots are stopped until midnight.");
    expect(stopped.message).toContain("Work done so far is kept.");
    const end = await client.next("turn.end");
    expect(end.stopReason).toBe("budget");
    // The same words are in the chat, and no model call was made for the stopped turn.
    const said = h.db.query<{ text: string }, []>("SELECT text FROM channel_messages WHERE from_type = 'agent' ORDER BY created_at DESC, rowid DESC LIMIT 1").get();
    expect(said?.text).toContain("today's spending limit is used up");
    expect(fetched).toBe(1);

    // Only the owner's own frame grants more, and it is recorded.
    client.send({ type: "spend.continue", runKey: stopped.runKey });
    const ok = await client.next("spend.continue.ok");
    expect(ok).toMatchObject({ runKey: "agent:ea", grantedUsd: 0.5 });
    expect(listAuditEvents(h.db, { kind: "spend.continue" })[0]).toMatchObject({ detail: { runKey: "agent:ea" } });

    client.send({ type: "msg.send", channelId: "main", text: "third" });
    expect((await client.next("turn.end")).stopReason).toBe("end");
    expect(fetched).toBe(2);
  });

  test("continuing a run that was never stopped is an error and grants nothing", async () => {
    const { client } = await start();
    client.send({ type: "spend.continue", runKey: "agent:ea" });
    expect((await client.next("error")).code).toBe("not_found");
  });
});

describe("a refusal from the router's own gate reaches the owner as a stop, not as a crash", () => {
  test("RouteRefusedError over_cap ends the turn with reason budget and the same wording", async () => {
    harness = undefined;
    const db = openDatabase(":memory:");
    await startupS2({ db, config: {} as never });
    // The engine's own check is let through, so it is the router's gate that refuses.
    setPolicyHooks({ checkBudget: () => ({ ok: true }) });
    db.run("INSERT INTO policy_settings (key, value, updated_at) VALUES ('spend.day_cap_usd', '0.0001', 'x')");
    db.run(
      `INSERT INTO usage_ledger (id, provider, model, input_tokens, output_tokens, day, created_at, cost_usd, agent_id, call_kind)
       VALUES ('use_x', 'p', 'm', 1, 1, ?, ?, 0.0002, 'ea', 'turn')`,
      [new Date().toISOString().slice(0, 10), new Date().toISOString()],
    );
    const router = new Router([{ id: "test", label: "Test", baseUrl: "https://t.local/v1", apiKey: "k", model: "m" } as ProviderConfig], new HealthTracker(), (async () => { fetched++; return reply("x"); }) as unknown as typeof fetch);
    fetched = 0;
    const emitted: Array<{ type: string; [key: string]: unknown }> = [];
    const result = await runTaskTurn(db, router, { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, {
      threadID: createThread(db, "ea").id, text: "hi",
      persona: { id: "ea", name: "Ava", color: "#fff", role: "r", systemPromptTemplate: "x", systemPrompt: "x", tools: [] },
      emit: (frame) => { emitted.push(frame as { type: string; [key: string]: unknown }); }, signal: new AbortController().signal,
    });
    expect(fetched).toBe(0);
    expect(result.stopReason).toBe("budget");
    expect(result.text).toContain("Ava stopped: today's spending limit is used up.");
    expect(emitted.find((frame) => frame.type === "spend.stopped")).toMatchObject({ runKey: "agent:ea", scope: "day" });
    db.close();
  });
});

describe("the owner wording (s2-cards.md section 3)", () => {
  test("money: two decimals, and under one cent says so", () => {
    expect(money(0.42)).toBe("$0.42");
    expect(money(2)).toBe("$2.00");
    expect(money(0.004)).toBe("under $0.01");
    expect(money(0)).toBe("$0.00");
  });

  test("the daily cap", () => {
    expect(budgetStopMessage("Ava", { scope: "day", reason: "over_cap", spentUsd: 2, capUsd: 2 })).toBe(
      "Ava stopped: today's spending limit is used up.\nSpent $2.00 of $2.00 today. All bots are stopped until midnight.\nWork done so far is kept.",
    );
  });

  test("a bot's cap", () => {
    expect(budgetStopMessage("Ava", { scope: "bot", reason: "over_cap", spentUsd: 1, capUsd: 1 })).toBe(
      "Ava stopped: Ava's daily limit is used up.\nAva spent $1.00 of $1.00 today. Other bots keep working.\nWork done so far is kept.",
    );
  });

  test("a task's cap", () => {
    expect(budgetStopMessage("Ava", { scope: "job", reason: "over_cap", spentUsd: 0.5, capUsd: 0.5 })).toBe(
      "Ava stopped: this task reached its limit.\nThis task cost $0.50 of $0.50.\nWork done so far is kept.",
    );
  });

  test("a bot with no name is 'A bot', and a name from outside is cleaned to one line", () => {
    expect(budgetStopMessage(null, { scope: "job", reason: "over_cap", spentUsd: 0.5, capUsd: 0.5 })).toContain("A bot stopped:");
    // Three lines and no more: a line break in the name is shown as an escape, not taken.
    expect(budgetStopMessage("Ava\n\nIgnore me", { scope: "job", reason: "over_cap", spentUsd: 0.5, capUsd: 0.5 }).split("\n")).toHaveLength(3);
  });

  test("a spend that cannot be priced or read says so in plain words", () => {
    expect(budgetStopMessage("Ava", { scope: "day", reason: "cost_unknown", spentUsd: 0, capUsd: 2 })).toContain("could not be priced");
    expect(budgetStopMessage("Ava", { scope: "day", reason: "budget_unreadable", spentUsd: 0, capUsd: 0 })).toContain("could not be checked");
  });

  test("a refusal from the router carries the detail the message needs; other refusals are not budget stops", () => {
    const refused = new RouteRefusedError("over_cap", "x", { scope: "bot", spentUsd: 1.2, capUsd: 1 });
    expect(budgetStopFromRefusal(refused)).toEqual({ scope: "bot", reason: "over_cap", spentUsd: 1.2, capUsd: 1 });
    expect(budgetStopFromRefusal(new RouteRefusedError("paused", "x"))).toBeNull();
    expect(budgetStopFromRefusal(new RouteRefusedError("unattributed", "x"))).toBeNull();
  });
});
