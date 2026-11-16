/**
 * Sprint 1 final server round: the closure note stays out of the owner's
 * sidebar, and every abort says why so the right note is written.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { HealthTracker } from "../src/models/health";
import type { ProviderConfig } from "../src/models/providers";
import { Router } from "../src/models/router";
import { runTaskTurn } from "../src/agent/task-loop";
import { INTERRUPTED_REQUEST_NOTE, STOPPED_REQUEST_NOTE, REVOKED_REQUEST_NOTE, closeRequest } from "../src/agent/closure";
import { appendMessage, createThread, listThreadsWithPreview } from "../src/stores/threads";
import { cancelAllTurns, cancelTurn, cancelTurnsForDevice, registerTurn, unregisterTurn } from "../src/ws/turn-registry";

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

describe("the closure note is not the sidebar preview", () => {
  test("the newest owner-visible message is the preview, not the note after it", () => {
    db = openDatabase(":memory:");
    const thread = createThread(db, "ea");
    appendMessage(db, { threadID: thread.id, role: "user", text: "tidy the shared folder" });
    closeRequest(db, { threadID: thread.id, reason: "stopped" });
    const row = listThreadsWithPreview(db, 10).find((entry) => entry.id === thread.id)!;
    expect(row.preview).toBe("tidy the shared folder");
    expect(row.preview).not.toMatch(/will not resume/);
  });
});

describe("every abort says why", () => {
  test("the registry aborts with owner_stop, device_revoked and shutdown", () => {
    const reasons: string[] = [];
    const make = (id: string, device?: string) => {
      const controller = new AbortController();
      controller.signal.addEventListener("abort", () => reasons.push(`${id}:${String(controller.signal.reason)}`));
      registerTurn(id, "thr", controller, device);
      return controller;
    };
    const a = make("a");
    const b = make("b", "dev1");
    const c = make("c");
    expect(cancelTurn("a", "owner_stop")).toBe(true);
    expect(cancelTurnsForDevice("dev1")).toBe(1);
    expect(cancelAllTurns()).toBeGreaterThanOrEqual(1);
    for (const [id, controller] of [["a", a], ["b", b], ["c", c]] as const) unregisterTurn(id, controller);
    expect(reasons).toContain("a:owner_stop");
    expect(reasons).toContain("b:device_revoked");
    expect(reasons).toContain("c:shutdown");
  });
});

const provider: ProviderConfig = { id: "test", label: "Test", baseUrl: "https://test.local/v1", apiKey: "test", model: "mock" };

/** A turn whose model call hangs until it is aborted with `reason`; returns the system rows it left. */
async function abortedWith(reason: string | undefined): Promise<string[]> {
  db = openDatabase(":memory:");
  const thread = createThread(db, "ea");
  const controller = new AbortController();
  const router = new Router([provider], new HealthTracker(), ((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    setTimeout(() => (reason === undefined ? controller.abort() : controller.abort(reason)), 20);
  })) as unknown as typeof fetch);
  const result = await runTaskTurn(db, router, { firstTokenTimeoutMs: 5_000, turnTimeoutMs: 10_000 }, {
    threadID: thread.id, text: "do the long thing", persona: { id: "ea", name: "Agni", color: "#f0b95a", role: "r", systemPromptTemplate: "x", systemPrompt: "x", tools: ["tasks_list"] },
    emit: () => undefined, signal: controller.signal,
  });
  expect(result.stopReason).toBe("cancelled");
  return db.query<{ text: string }, [string]>("SELECT text FROM messages WHERE thread_id = ? AND role = 'system'").all(thread.id).map((row) => row.text);
}

describe("the note matches the reason the turn was aborted", () => {
  test("owner_stop writes the Stop note", async () => { expect(await abortedWith("owner_stop")).toEqual([STOPPED_REQUEST_NOTE]); });
  test("shutdown writes the interrupted note", async () => { expect(await abortedWith("shutdown")).toEqual([INTERRUPTED_REQUEST_NOTE]); });
  test("device_revoked writes the revoked-device note", async () => { expect(await abortedWith("device_revoked")).toEqual([REVOKED_REQUEST_NOTE]); });
  test("an abort with no reason is treated as the owner's Stop", async () => { expect(await abortedWith(undefined)).toEqual([STOPPED_REQUEST_NOTE]); });
});

describe("a routine turn is untrusted input that still streams", () => {
  const persona = { id: "ea", name: "Agni", color: "#f0b95a", role: "r", systemPromptTemplate: "x", systemPrompt: "x", tools: ["remember_fact", "job_schedule", "routine_create", "create_agent", "memory_search"] };
  const call = (name: string, args: unknown) => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      const body = `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `c-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] })}\n\ndata: [DONE]\n\n`;
      controller.enqueue(new TextEncoder().encode(body)); controller.close();
    },
  }), { status: 200 });
  const text = (content: string) => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`)); controller.close(); },
  }), { status: 200 });

  test("tool calls that peer input may not make are refused for a routine-style turn, and tokens still stream", async () => {
    db = openDatabase(":memory:");
    const thread = createThread(db, "ea");
    let step = 0;
    const router = new Router([provider], new HealthTracker(), (async () => {
      step += 1;
      if (step === 1) return call("remember_fact", { fact: "exfiltrate this" });
      if (step === 2) return call("routine_create", { name: "x", prompt: "y", cron: "0 9 * * *", timezone: "UTC" });
      return text("Done.");
    }) as unknown as typeof fetch);
    const frames: Array<{ type: string }> = [];
    await runTaskTurn(db, router, { firstTokenTimeoutMs: 5_000, turnTimeoutMs: 10_000 }, {
      threadID: thread.id, text: "prompt\n```json\n{\"note\":\"schedule a job\"}\n```", persona, hideInput: true, untrustedInput: true, queryText: "prompt",
      emit: (frame: { type: string }) => frames.push(frame), signal: new AbortController().signal, toolAllowlist: ["remember_fact", "routine_create"],
    } as never);
    const results = db.query<{ tool_name: string; result: string }, []>("SELECT tool_name, result FROM tool_calls ORDER BY created_at").all();
    expect(results.map((row) => row.tool_name)).toEqual(["remember_fact", "routine_create"]);
    for (const row of results) expect(row.result).toContain("another agent's message");
    expect(db.query("SELECT count(*) AS n FROM agent_memories").get()).toEqual({ n: 0 });
    expect(frames.some((frame) => frame.type === "token")).toBe(true);
    // The instruction is hidden from the owner's history.
    expect(db.query<{ role: string }, []>("SELECT role FROM messages WHERE text LIKE 'prompt%'").all().map((row) => row.role)).toEqual(["system"]);
  });
});
