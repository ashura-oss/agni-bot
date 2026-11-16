/**
 * Sprint 1, T1: the turn loop. One test per bug in `project-log/sprints/sprint-1.md`
 * (S1-03, 04, 05, 08, 14, 15, 16, 18, 26, 27, 30), turn side.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db";
import { HealthTracker } from "../src/models/health";
import type { ChatMessage } from "../src/models/client";
import type { ProviderConfig } from "../src/models/providers";
import { Router } from "../src/models/router";
import * as taskLoop from "../src/agent/task-loop";
import { runTaskTurn, startParallelReads } from "../src/agent/task-loop";
import { MAX_CHAIN_STEPS, MAX_DELEGATED_STEPS } from "../src/agent/guardrails";
import { answerFormAndWake } from "../src/agent/form-broker";
import { resolveApprovalWaiter } from "../src/agent/approval-broker";
import type { ResolvedPersona } from "../src/agent/personas";
import { createThread, createTurn } from "../src/stores/threads";

const provider: ProviderConfig = {
  id: "test", label: "Test", baseUrl: "https://test.local/v1", apiKey: "test", model: "mock",
};
const persona: ResolvedPersona = {
  id: "agni", name: "Agni", color: "#f0b95a", role: "front desk",
  systemPromptTemplate: "Be helpful.", systemPrompt: "Be helpful.",
  tools: ["tasks_list"],
};
type Frame = { type: string; [key: string]: unknown };
const settings = { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 };

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

function streamResponse(events: unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(body)); controller.close(); },
  }), { status: 200 });
}
type Call = { id: string; name: string; args: unknown };
const callsResponse = (calls: Call[], usage?: { prompt_tokens: number; completion_tokens: number }): Response => streamResponse([
  {
    choices: [{ delta: { tool_calls: calls.map((call, index) => ({ index, id: call.id, type: "function", function: { name: call.name, arguments: typeof call.args === "string" ? call.args : JSON.stringify(call.args) } })) } }],
    ...(usage ? { usage } : {}),
  },
]);
const textResponse = (text: string, usage?: { prompt_tokens: number; completion_tokens: number }): Response =>
  streamResponse([{ choices: [{ delta: { content: text } }], ...(usage ? { usage } : {}) }]);

function routerFor(respond: (request: number, body: Record<string, unknown>) => Response): Router {
  let request = 0;
  return new Router([provider], new HealthTracker(), (async (_input: string | URL | Request, init?: RequestInit) => {
    request += 1;
    return respond(request, JSON.parse(String(init?.body)) as Record<string, unknown>);
  }) as unknown as typeof fetch);
}
const sessionLog = (threadID: string): ChatMessage[] =>
  JSON.parse(db!.query<{ message_log: string }, [string]>("SELECT message_log FROM agent_sessions WHERE thread_id = ?").get(threadID)!.message_log) as ChatMessage[];
const toolRows = (turnID: string): number => db!.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM tool_calls WHERE turn_id = ?").get(turnID)!.n;
const scratchOutside = (): string => join(tmpdir(), `agni-t1-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);

describe("S1-04 stop and timeout stop the rest of a step", () => {
  test("after Stop, remaining calls get a cancelled result, nothing runs, and no approval card is raised", async () => {
    db = openDatabase(":memory:");
    const p = { ...persona, tools: ["tasks_list", "write_file"] };
    const thread = createThread(db, p.id);
    const outside = scratchOutside();
    const router = routerFor((request) => request === 1
      ? callsResponse([
        { id: "call-1", name: "tasks_list", args: { status: "open" } },
        { id: "call-2", name: "write_file", args: { path: outside, content: "x" } },
        { id: "call-3", name: "tasks_list", args: { status: "done" } },
      ])
      : textResponse("should never be asked"));
    const stop = new AbortController();
    const emitted: Frame[] = [];
    const result = await runTaskTurn(db, router, settings, {
      threadID: thread.id, text: "go", persona: p, signal: stop.signal,
      emit: (frame) => {
        emitted.push(frame as Frame);
        if (frame.type === "tool.end") stop.abort();
      },
    });
    rmSync(outside, { force: true });

    expect(result.stopReason).toBe("cancelled");
    expect(toolRows(result.turnID)).toBe(1);
    expect(emitted.some((frame) => frame.type === "approval.request")).toBe(false);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM approvals").get()!.n).toBe(0);
    const results = sessionLog(thread.id).filter((message) => message.role === "tool");
    expect(results.map((message) => message.toolCallID)).toEqual(["call-1", "call-2", "call-3"]);
    expect(results[1]!.content).toBe(JSON.stringify({ skipped: true, reason: "cancelled" }));
    expect(results[2]!.content).toBe(JSON.stringify({ skipped: true, reason: "cancelled" }));
  });
});

describe("S1-08 per-response cap, output tokens, duplicate guard", () => {
  test("calls beyond 25 in one response are not executed, and each still gets a result", async () => {
    db = openDatabase(":memory:");
    const thread = createThread(db, persona.id);
    const calls: Call[] = Array.from({ length: 30 }, (_, index) => ({
      id: `call-${index}`, name: "tasks_list", args: { status: index < 20 ? "open" : "done", limit: (index % 20) + 1 },
    }));
    const router = routerFor((request) => request === 1 ? callsResponse(calls) : textResponse("done"));
    const result = await runTaskTurn(db, router, settings, {
      threadID: thread.id, text: "list everything", persona, emit: () => undefined, signal: new AbortController().signal,
    });

    expect(result.stopReason).toBe("end");
    expect(toolRows(result.turnID)).toBe(25);
    const results = sessionLog(thread.id).filter((message) => message.role === "tool");
    expect(results).toHaveLength(30);
    const capped = results.slice(25);
    expect(capped.map((message) => message.toolCallID)).toEqual(["call-25", "call-26", "call-27", "call-28", "call-29"]);
    for (const message of capped) expect(message.content).toContain("per-response cap");
  });

  test("every chat step sends max_tokens: 8192 by default, AGNI_MAX_OUTPUT_TOKENS overrides it", async () => {
    const sent: unknown[] = [];
    const run = async (): Promise<void> => {
      db = openDatabase(":memory:");
      const thread = createThread(db, persona.id);
      const router = routerFor((_request, body) => { sent.push(body.max_tokens); return textResponse("hi"); });
      await runTaskTurn(db, router, settings, { threadID: thread.id, text: "hi", persona, emit: () => undefined, signal: new AbortController().signal });
      db.close(); db = undefined;
    };
    const saved = process.env.AGNI_MAX_OUTPUT_TOKENS;
    try {
      delete process.env.AGNI_MAX_OUTPUT_TOKENS;
      await run();
      process.env.AGNI_MAX_OUTPUT_TOKENS = "1234";
      await run();
      process.env.AGNI_MAX_OUTPUT_TOKENS = "not a number";
      await run();
    } finally {
      if (saved === undefined) delete process.env.AGNI_MAX_OUTPUT_TOKENS; else process.env.AGNI_MAX_OUTPUT_TOKENS = saved;
    }
    expect(sent).toEqual([8192, 1234, 8192]);
  });

  test("a bounded run still uses its own tokenLimit path", async () => {
    db = openDatabase(":memory:");
    const thread = createThread(db, persona.id);
    let sent: unknown;
    const router = routerFor((_request, body) => { sent = body.max_tokens; return textResponse("hi"); });
    await runTaskTurn(db, router, settings, { threadID: thread.id, text: "hi", persona, maxTokens: 500, emit: () => undefined, signal: new AbortController().signal });
    expect(sent).toBe(500);
  });

  test("the duplicate guard sees through key order, whitespace and padded strings", async () => {
    db = openDatabase(":memory:");
    const thread = createThread(db, persona.id);
    const router = routerFor((request) => request === 1
      ? callsResponse([
        { id: "d1", name: "tasks_list", args: "{\"status\":\"open\",\"limit\":5}" },
        { id: "d2", name: "tasks_list", args: "{ \"limit\": 5,   \"status\": \"open\" }" },
        { id: "d3", name: "tasks_list", args: "{\"status\":\" open \",\"limit\":5}" },
      ])
      : textResponse("done"));
    const result = await runTaskTurn(db, router, settings, {
      threadID: thread.id, text: "list", persona, emit: () => undefined, signal: new AbortController().signal,
    });
    expect(toolRows(result.turnID)).toBe(1);
    const results = sessionLog(thread.id).filter((message) => message.role === "tool");
    expect(results[1]!.content).toContain("Duplicate");
    expect(results[2]!.content).toContain("Duplicate");
  });

  test("the parallel-read starter uses the same normalised signature", () => {
    const call = (id: string, args: string) => ({ id, type: "function", function: { name: "memory_search", arguments: args } }) as never;
    const started = startParallelReads(
      [call("a", "{\"query\":\"x\",\"limit\":2}"), call("b", "{ \"limit\": 2, \"query\": \"x\" }")],
      new Map(), 0, 3, () => false, async (c: { id: string }) => c.id,
    );
    expect([...started.keys()]).toEqual(["a"]);
  });
});

describe("S1-18 chain ceilings", () => {
  test("the ceilings are 48 and 24", () => {
    expect(MAX_CHAIN_STEPS).toBe(48);
    expect(MAX_DELEGATED_STEPS).toBe(24);
  });
});

describe("S1-05 turn timer and pending cards", () => {
  test("the turn timer does not run while an approval waits on the owner", async () => {
    db = openDatabase(":memory:");
    const p = { ...persona, tools: ["write_file"] };
    const thread = createThread(db, p.id);
    const outside = scratchOutside();
    const router = routerFor((request) => request === 1
      ? callsResponse([{ id: "w", name: "write_file", args: { path: outside, content: "hello" } }])
      : textResponse("Wrote it."));
    try {
      const result = await runTaskTurn(db, router, { firstTokenTimeoutMs: 1000, turnTimeoutMs: 200 }, {
        threadID: thread.id, text: "write outside", persona: p, signal: new AbortController().signal,
        emit: (frame) => {
          if (frame.type !== "approval.request") return;
          const requestID = String(frame.requestID);
          // The owner takes twice the turn timeout to decide.
          setTimeout(() => {
            db!.run("UPDATE approvals SET status = 'decided', decision = 'once', decided_at = ? WHERE id = ?", [new Date().toISOString(), requestID]);
            resolveApprovalWaiter(requestID, "once");
          }, 450);
        },
      });
      expect(result.stopReason).toBe("end");
      expect(db.query("SELECT tool_name, ok FROM tool_calls WHERE turn_id = ?").get(result.turnID)).toEqual({ tool_name: "write_file", ok: 1 });
    } finally {
      rmSync(outside, { force: true });
    }
  });

  test("the turn timer does not run while an owner form waits either", async () => {
    db = openDatabase(":memory:");
    const thread = createThread(db, persona.id);
    const router = routerFor((request) => request === 1
      ? callsResponse([{ id: "q", name: "ask", args: { question: "Which?", options: ["a", "b"] } }])
      : textResponse("Got it."));
    const result = await runTaskTurn(db, router, { firstTokenTimeoutMs: 1000, turnTimeoutMs: 200 }, {
      threadID: thread.id, text: "ask me", persona, signal: new AbortController().signal,
      emit: (frame) => {
        if (frame.type === "form.request") setTimeout(() => answerFormAndWake(db!, String(frame.requestID), "a"), 450);
      },
    });
    expect(result.stopReason).toBe("end");
  });

  test("the timer still fires for a turn that is not waiting on the owner", async () => {
    db = openDatabase(":memory:");
    const thread = createThread(db, persona.id);
    const router = new Router([provider], new HealthTracker(), ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))) as unknown as typeof fetch);
    const result = await runTaskTurn(db, router, { firstTokenTimeoutMs: 1000, turnTimeoutMs: 150 }, {
      threadID: thread.id, text: "hang", persona, emit: () => undefined, signal: new AbortController().signal,
    });
    expect(result.stopReason).toBe("timeout");
  });

  test("a card still pending when the turn is stopped is expired and closed as cancelled, before turn.end", async () => {
    db = openDatabase(":memory:");
    const p = { ...persona, tools: ["write_file"] };
    const thread = createThread(db, p.id);
    const outside = scratchOutside();
    const router = routerFor((request) => request === 1
      ? callsResponse([{ id: "w", name: "write_file", args: { path: outside, content: "x" } }, { id: "q", name: "ask", args: { question: "Which?" } }])
      : textResponse("unreachable"));
    const stop = new AbortController();
    const emitted: Frame[] = [];
    const result = await runTaskTurn(db, router, settings, {
      threadID: thread.id, text: "go", persona: p, signal: stop.signal,
      emit: (frame) => {
        emitted.push(frame as Frame);
        if (frame.type === "approval.request") setTimeout(() => stop.abort(), 50);
      },
    });
    rmSync(outside, { force: true });

    expect(result.stopReason).toBe("cancelled");
    const row = db.query<{ id: string; status: string }, [string]>("SELECT id, status FROM approvals WHERE turn_id = ?").get(result.turnID)!;
    expect(row.status).toBe("expired");
    const closed = emitted.filter((frame) => frame.type === "approval.closed");
    expect(closed).toEqual([{ type: "approval.closed", requestID: row.id, kind: "approval", reason: "cancelled" }]);
    expect(emitted.findIndex((frame) => frame.type === "approval.closed")).toBeLessThan(emitted.findIndex((frame) => frame.type === "turn.end"));
  });

  test("a pending form is expired and closed when the turn is stopped", async () => {
    db = openDatabase(":memory:");
    const thread = createThread(db, persona.id);
    const router = routerFor(() => callsResponse([{ id: "q", name: "ask", args: { question: "Which?", options: ["a"] } }]));
    const stop = new AbortController();
    const emitted: Frame[] = [];
    const result = await runTaskTurn(db, router, settings, {
      threadID: thread.id, text: "ask", persona, signal: stop.signal,
      emit: (frame) => {
        emitted.push(frame as Frame);
        if (frame.type === "form.request") setTimeout(() => stop.abort(), 50);
      },
    });
    const form = db.query<{ id: string; status: string }, [string]>("SELECT id, status FROM forms WHERE turn_id = ?").get(result.turnID)!;
    expect(form.status).toBe("expired");
    expect(emitted.filter((frame) => frame.type === "approval.closed")).toEqual([{ type: "approval.closed", requestID: form.id, kind: "form", reason: "cancelled" }]);
  });

  test("expiring a turn's pending rows uses reason expired for any other stop, and leaves other turns alone", async () => {
    db = openDatabase(":memory:");
    const thread = createThread(db, persona.id);
    createTurn(db, { id: "trn_a", threadID: thread.id, agentID: persona.id });
    createTurn(db, { id: "trn_b", threadID: thread.id, agentID: persona.id });
    const now = new Date().toISOString();
    db.run("INSERT INTO approvals (id, thread_id, turn_id, action, preview, status, created_at) VALUES ('apr_a', ?, 'trn_a', 'x', 'x', 'pending', ?), ('apr_b', ?, 'trn_b', 'x', 'x', 'pending', ?), ('apr_done', ?, 'trn_a', 'x', 'x', 'decided', ?)", [thread.id, now, thread.id, now, thread.id, now]);
    const { expirePendingForTurn } = await import("../src/agent/pending-cards");
    const emitted: unknown[] = [];
    expirePendingForTurn(db, "trn_a", "expired", (frame) => emitted.push(frame));
    expect(emitted).toEqual([{ type: "approval.closed", requestID: "apr_a", kind: "approval", reason: "expired" }]);
    const status = (id: string): string => db!.query<{ status: string }, [string]>("SELECT status FROM approvals WHERE id = ?").get(id)!.status;
    expect([status("apr_a"), status("apr_b"), status("apr_done")]).toEqual(["expired", "pending", "decided"]);
  });
});

describe("S1-03 a resumed session runs under the caller's turn ID", () => {
  test("turn.start, the session row and the result all carry the new ID, and the old call is not replayed", async () => {
    db = openDatabase(":memory:");
    const thread = createThread(db, persona.id);
    createTurn(db, { id: "trn_old", threadID: thread.id, agentID: persona.id });
    const log = [
      { role: "user", content: "Add a task" },
      { role: "assistant", content: "", toolCalls: [{ id: "call-x", type: "function", function: { name: "task_create", arguments: "{\"title\":\"Do not duplicate\"}" } }] },
    ];
    db.run("INSERT INTO agent_sessions (thread_id, turn_id, state, message_log, max_steps, max_tokens, created_at, updated_at) VALUES (?, 'trn_old', 'running', ?, 0, 0, datetime('now'), datetime('now'))", [thread.id, JSON.stringify(log)]);
    db.run("INSERT INTO tool_calls (id, thread_id, turn_id, call_id, tool_name, args, result, ok, created_at) VALUES ('tcl_x', ?, 'trn_old', 'call-x', 'task_create', '{}', NULL, 0, datetime('now'))", [thread.id]);
    const emitted: Frame[] = [];
    const result = await runTaskTurn(db, routerFor(() => textResponse("Resumed.")), settings, {
      threadID: thread.id, turnID: "trn_new", text: "Continue", persona,
      emit: (frame) => emitted.push(frame as Frame), signal: new AbortController().signal,
    });

    expect(result.turnID).toBe("trn_new");
    expect(emitted.find((frame) => frame.type === "turn.start")).toMatchObject({ turnID: "trn_new" });
    expect(emitted.find((frame) => frame.type === "turn.end")).toMatchObject({ turnID: "trn_new" });
    expect(db.query("SELECT turn_id, state FROM agent_sessions WHERE thread_id = ?").get(thread.id)).toEqual({ turn_id: "trn_new", state: "done" });
    expect(db.query<{ stop_reason: string }, []>("SELECT stop_reason FROM turns WHERE id = 'trn_new'").get()?.stop_reason).toBe("end");
    // The dead turn is closed, and the uncertain side effect is not repeated.
    expect(db.query<{ state: string }, []>("SELECT state FROM turns WHERE id = 'trn_old'").get()?.state).toBe("done");
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tasks").get()!.n).toBe(0);
    expect(db.query<{ result: string }, []>("SELECT result FROM tool_calls WHERE id = 'tcl_x'").get()!.result).toContain("was not repeated");
  });
});

describe("S1-14 compaction cuts at a step boundary and keeps the current request", () => {
  // A step with two parallel calls: an assistant message and two results.
  const step = (n: number, size = 3_500): ChatMessage[] => [
    { role: "assistant", content: "", toolCalls: [
      { id: `c${n}a`, type: "function", function: { name: "tasks_list", arguments: "{}" } },
      { id: `c${n}b`, type: "function", function: { name: "tasks_list", arguments: "{\"status\":\"done\"}" } },
    ] },
    { role: "tool", toolCallID: `c${n}a`, content: `result ${n}a ${"r".repeat(size)}` },
    { role: "tool", toolCallID: `c${n}b`, content: `result ${n}b ${"r".repeat(size)}` },
  ];
  const history = (): ChatMessage[] => [
    { role: "user", content: "an old question" },
    { role: "assistant", content: "an old answer" },
  ];

  test("the kept tail never starts with a tool result and never separates a result from its call", () => {
    const messages: ChatMessage[] = [...history(), { role: "user", content: "THE CURRENT REQUEST" }];
    for (let n = 0; n < 6; n += 1) messages.push(...step(n));
    const { messages: kept } = taskLoop.compact(messages, null);
    expect(kept[0]!.role).not.toBe("tool");
    const calls = new Set(kept.flatMap((message) => message.toolCalls?.map((call) => call.id) ?? []));
    for (const message of kept) if (message.role === "tool") expect(calls.has(message.toolCallID!)).toBe(true);
  });

  test("the current user message stays verbatim, outside the summary, however long the step chain", () => {
    const messages: ChatMessage[] = [...history(), { role: "user", content: "THE CURRENT REQUEST" }];
    for (let n = 0; n < 12; n += 1) messages.push(...step(n));
    const { messages: kept, summary } = taskLoop.compact(messages, null);
    expect(kept.some((message) => message.role === "user" && message.content === "THE CURRENT REQUEST")).toBe(true);
    expect(summary ?? "").not.toContain("THE CURRENT REQUEST");
  });
});

describe("S1-27 long messages are cut with a notice", () => {
  test("a user message over 48,000 characters is cut there and says how much was kept", () => {
    const long = "a".repeat(60_000);
    const { messages: kept } = taskLoop.compact([{ role: "user", content: long }], null);
    const text = kept[0]!.content;
    expect(text.startsWith("a".repeat(48_000))).toBe(true);
    expect(text.slice(48_000)).toContain("kept 48000 of 60000 characters");
    expect(text.length).toBeLessThan(48_400);
  });

  test("a message under the limit is untouched, and a cut message is not cut again on the next step", () => {
    const fits = "b".repeat(30_000);
    expect(taskLoop.compact([{ role: "user", content: fits }], null).messages[0]!.content).toBe(fits);
    const once = taskLoop.compact([{ role: "user", content: "c".repeat(60_000) }], null).messages;
    const twice = taskLoop.compact(once, null).messages;
    expect(twice[0]!.content).toBe(once[0]!.content);
  });
});

describe("S1-15 the off-road guard on Windows paths", () => {
  const win = { cwd: "C:\\agni bot fork\\worktrees\\s1-t1-turn-loop", platform: "win32" as NodeJS.Platform };
  const posix = { cwd: "/srv/agni", platform: "linux" as NodeJS.Platform };

  test("a drive-absolute or UNC path outside the checkout is the owner's own file", () => {
    expect(taskLoop.readsAppSource("read_file", { path: "C:\\Users\\me\\Documents\\notes.txt" }, win)).toBe(false);
    expect(taskLoop.readsAppSource("read_file", { path: "D:/work/report.md" }, win)).toBe(false);
    expect(taskLoop.readsAppSource("read_file", { path: "\\\\nas\\share\\report.md" }, win)).toBe(false);
    expect(taskLoop.readsAppSource("bash", { command: "cat C:\\Users\\me\\Documents\\notes.txt" }, win)).toBe(false);
    expect(taskLoop.readsAppSource("bash", { command: "cat 'D:/work/report.md'" }, win)).toBe(false);
  });

  test("a path inside the checkout is still app source, case-insensitively and with either separator", () => {
    expect(taskLoop.readsAppSource("read_file", { path: "C:\\AGNI BOT FORK\\worktrees\\s1-t1-turn-loop\\x.ts" }, win)).toBe(true);
    expect(taskLoop.readsAppSource("read_file", { path: "c:/agni bot fork/worktrees/s1-t1-turn-loop/x.ts" }, win)).toBe(true);
    expect(taskLoop.readsAppSource("bash", { command: "cat \"C:/Agni Bot Fork/worktrees/s1-t1-turn-loop/x.ts\"" }, win)).toBe(true);
  });

  test("a relative path, and the app's own markers, are still app source", () => {
    expect(taskLoop.readsAppSource("read_file", { path: "notes.txt" }, win)).toBe(true);
    expect(taskLoop.readsAppSource("read_file", { path: "apps\\server\\src\\x.ts" }, win)).toBe(true);
    expect(taskLoop.readsAppSource("bash", { command: "cat package.json" }, win)).toBe(true);
  });

  test("posix behaviour is unchanged", () => {
    expect(taskLoop.readsAppSource("read_file", { path: "/home/me/notes.txt" }, posix)).toBe(false);
    expect(taskLoop.readsAppSource("read_file", { path: "/srv/agni/x.ts" }, posix)).toBe(true);
    expect(taskLoop.readsAppSource("read_file", { path: "~/notes.txt" }, posix)).toBe(false);
  });
});

describe("S1-16 the ledger totals every step", () => {
  test("two steps are summed into the ledger row and turn.end.usage", async () => {
    db = openDatabase(":memory:");
    const thread = createThread(db, persona.id);
    const router = routerFor((request) => request === 1
      ? callsResponse([{ id: "u1", name: "tasks_list", args: {} }], { prompt_tokens: 100, completion_tokens: 10 })
      : textResponse("done", { prompt_tokens: 200, completion_tokens: 20 }));
    const emitted: Frame[] = [];
    const result = await runTaskTurn(db, router, settings, {
      threadID: thread.id, text: "list", persona, emit: (frame) => emitted.push(frame as Frame), signal: new AbortController().signal,
    });
    const total = db.query<{ i: number; o: number }, [string]>("SELECT SUM(input_tokens) AS i, SUM(output_tokens) AS o FROM usage_ledger WHERE turn_id = ?").get(result.turnID)!;
    expect(total).toEqual({ i: 300, o: 30 });
    expect(emitted.find((frame) => frame.type === "turn.end")).toMatchObject({ usage: { inputTokens: 300, outputTokens: 30 } });
    expect(db.query("SELECT input_tokens, output_tokens FROM turns WHERE id = ?").get(result.turnID)).toEqual({ input_tokens: 300, output_tokens: 30 });
  });
});

describe("S1-26 deferred tools must be loaded before they are called", () => {
  const many = ["tasks_list", "task_create", "memory_search", "recall_fact", "remember_fact", "web_search", "web_fetch", "handoff", "delegate_task", "job_list", "links_search", "task_update", "write_file"];

  test("a call to an unloaded deferred tool is refused with the loader named, with no approval card", async () => {
    db = openDatabase(":memory:");
    const p = { ...persona, tools: many };
    const thread = createThread(db, p.id);
    const outside = scratchOutside();
    const router = routerFor((request) => request === 1
      ? callsResponse([{ id: "blind", name: "write_file", args: { path: outside, content: "x" } }])
      : textResponse("ok"));
    const emitted: Frame[] = [];
    const result = await runTaskTurn(db, router, settings, {
      threadID: thread.id, text: "write", persona: p, emit: (frame) => emitted.push(frame as Frame), signal: new AbortController().signal,
    });
    rmSync(outside, { force: true });
    expect(emitted.some((frame) => frame.type === "approval.request")).toBe(false);
    const row = db.query<{ result: string; ok: number }, [string]>("SELECT result, ok FROM tool_calls WHERE turn_id = ?").get(result.turnID)!;
    expect(row.ok).toBe(0);
    expect(row.result).toContain("load_tools");
    expect(row.result).toContain("write_file");
  });

  test("after load_tools the same tool runs", async () => {
    db = openDatabase(":memory:");
    const p = { ...persona, tools: many };
    const thread = createThread(db, p.id);
    const router = routerFor((request) => request === 1
      ? callsResponse([{ id: "l", name: "load_tools", args: { names: ["job_list"] } }])
      : request === 2 ? callsResponse([{ id: "j", name: "job_list", args: {} }]) : textResponse("ok"));
    const result = await runTaskTurn(db, router, settings, {
      threadID: thread.id, text: "jobs", persona: p, emit: () => undefined, signal: new AbortController().signal,
    });
    expect(db.query<{ ok: number }, [string]>("SELECT ok FROM tool_calls WHERE turn_id = ? AND tool_name = 'job_list'").get(result.turnID)?.ok).toBe(1);
  });
});

describe("S1-30 the turn's failure travels in turn.end, not an error frame", () => {
  test("a guardrail stop emits no error frame and posts a plain sentence", async () => {
    db = openDatabase(":memory:");
    const thread = createThread(db, persona.id);
    const router = routerFor(() => callsResponse([{ id: "loop", name: "tasks_list", args: { status: "open", limit: 5 } }]));
    const emitted: Frame[] = [];
    const result = await runTaskTurn(db, router, settings, {
      threadID: thread.id, text: "loop forever", persona, emit: (frame) => emitted.push(frame as Frame), signal: new AbortController().signal,
    });
    expect(result.stopReason).toBe("error");
    expect(emitted.some((frame) => frame.type === "error")).toBe(false);
    expect(emitted.find((frame) => frame.type === "turn.end")).toMatchObject({ stopReason: "error" });
    expect(result.text).toBe("I stopped: this chain of work hit its step limit.");
    expect(db.query<{ step_count: number }, [string]>("SELECT step_count FROM agent_sessions WHERE thread_id = ?").get(thread.id)?.step_count).toBe(MAX_CHAIN_STEPS);
    expect(db.query<{ text: string }, [string]>("SELECT text FROM messages WHERE thread_id = ? AND role = 'assistant'").get(thread.id)?.text).toBe(result.text);
  });

  test("a failed model call emits no error frame and posts a plain sentence without the raw error", async () => {
    db = openDatabase(":memory:");
    const thread = createThread(db, persona.id);
    const router = new Router([], new HealthTracker(), (async () => textResponse("x")) as unknown as typeof fetch);
    const emitted: Frame[] = [];
    const result = await runTaskTurn(db, router, settings, {
      threadID: thread.id, text: "hello", persona, emit: (frame) => emitted.push(frame as Frame), signal: new AbortController().signal,
    });
    expect(result.stopReason).toBe("error");
    expect(emitted.some((frame) => frame.type === "error")).toBe(false);
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.text).not.toContain("no model providers configured");
    expect(emitted.find((frame) => frame.type === "turn.end")).toMatchObject({ stopReason: "error" });
  });
});
