/**
 * Sprint 1, wave 2, W2-B items 1 to 5: the turn loop and its tools.
 * One block per item in the brief. Items 6 to 9 are in `w2b-platform.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { openDatabase } from "../src/db";
import { HealthTracker } from "../src/models/health";
import type { ProviderConfig } from "../src/models/providers";
import { Router } from "../src/models/router";
import { runTaskTurn } from "../src/agent/task-loop";
import type { ResolvedPersona } from "../src/agent/personas";
import { mcpHub } from "../src/plugins/mcp";
import { resetSecretBroker, resolveSecret } from "../src/agent/secret-broker";
import { resolveApprovalWaiter } from "../src/agent/approval-broker";
import { createThread } from "../src/stores/threads";
import { DEFAULT_AGENT_TOOLS } from "../src/agent/personas";
import { ToolRegistry } from "../src/tools/registry";
import { registerArtifactTool } from "../src/tools/artifact-tool";
import { registerDelegateTaskTool } from "../src/tools/delegate-task-tool";
import { saveArtifact } from "../src/stores/artifacts";
import { getTask, setDelegationArtifact, setDelegationState } from "../src/stores/tasks";
import { fitToolResult } from "../src/agent/task-loop";
import { listJobs, parseJobPayload } from "../src/stores/jobs";
import { JobRunner } from "../src/jobs/runner";
import { registerTurnJob, summarizeResult } from "../src/jobs/turn";
import { buildTaskToolRegistry, deferredTools } from "../src/tools/task-registry";

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
const callsResponse = (calls: Call[]): Response => streamResponse([
  {
    choices: [{ delta: { tool_calls: calls.map((call, index) => ({ index, id: call.id, type: "function", function: { name: call.name, arguments: typeof call.args === "string" ? call.args : JSON.stringify(call.args) } })) } }],
  },
]);
const textResponse = (text: string): Response => streamResponse([{ choices: [{ delta: { content: text } }] }]);
function routerFor(respond: (request: number, body: Record<string, unknown>) => Response): Router {
  let request = 0;
  return new Router([provider], new HealthTracker(), (async (_input: string | URL | Request, init?: RequestInit) => {
    request += 1;
    return respond(request, JSON.parse(String(init?.body)) as Record<string, unknown>);
  }) as unknown as typeof fetch);
}

describe("W2-B 1: the broker validates arguments and shows the MCP note", () => {
  test("a call with invalid arguments raises no approval card and returns the field error", async () => {
    db = openDatabase(":memory:");
    const p = { ...persona, tools: ["write_file"] };
    const thread = createThread(db, p.id);
    // No path: the tool will refuse this call, so the owner is not asked about it.
    const router = routerFor((request) => request === 1
      ? callsResponse([{ id: "call-1", name: "write_file", args: { content: "x" } }])
      : textResponse("done"));
    const emitted: Frame[] = [];
    await runTaskTurn(db, router, settings, {
      threadID: thread.id, text: "go", persona: p, signal: new AbortController().signal,
      emit: (frame) => { emitted.push(frame as Frame); },
    });
    expect(emitted.some((frame) => frame.type === "approval.request")).toBe(false);
    const row = db.query<{ error: string | null }, []>("SELECT error FROM tool_calls").get()!;
    expect(row.error).toContain('"path" is required');
  });

  test("an MCP tool with a read-only hint shows the not-verified note on its card", async () => {
    db = openDatabase(":memory:");
    const mcp = new McpServer({ name: "fake", version: "1" });
    mcp.registerTool("wipe", { description: "wipes", inputSchema: { target: z.string() }, annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: "text", text: "wiped" }] }));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverSide);
    await mcpHub.connect("w2bplug", "http://unused", undefined, clientSide);
    try {
      const p = { ...persona, tools: ["mcp_*"] };
      const thread = createThread(db, p.id);
      const router = routerFor((request, body) => {
        if (request === 1) {
          // mcp tools are deferred only above the threshold, but load first if the hint list shows them.
          return callsResponse([{ id: "call-1", name: "mcp_w2bplug_wipe", args: { target: "all" } }]);
        }
        void body;
        return textResponse("done");
      });
      const emitted: Frame[] = [];
      const stop = new AbortController();
      await runTaskTurn(db, router, settings, {
        threadID: thread.id, text: "go", persona: p, signal: stop.signal,
        emit: (frame) => {
          emitted.push(frame as Frame);
          if (frame.type === "approval.request") setTimeout(() => stop.abort(), 20);
        },
      });
      const card = emitted.find((frame) => frame.type === "approval.request");
      expect(card).toBeDefined();
      expect(String(card!.preview)).toContain("not verified");
    } finally {
      await mcpHub.disconnect("w2bplug");
    }
  });
});

describe("W2-B 2: the deferral threshold counts only the tools a bot was given", () => {
  test("a bot with the default tools defers nothing, so update_agent is callable on its first call", async () => {
    db = openDatabase(":memory:");
    const p = { ...persona, id: "fresh_bot", tools: [...DEFAULT_AGENT_TOOLS] };
    const thread = createThread(db, p.id);
    const sent: Array<{ tools: Array<{ function: { name: string } }> }> = [];
    const router = routerFor((_request, body) => { sent.push(body as never); return textResponse("hi"); });
    await runTaskTurn(db, router, settings, {
      threadID: thread.id, text: "hello", persona: p, signal: new AbortController().signal, emit: () => undefined,
    });
    const names = sent[0]!.tools.map((tool) => tool.function.name);
    expect(names).toContain("update_agent");
    expect(names).not.toContain("load_tools");
  });

  test("the implicit tools do not count, but a real toolset past the threshold still defers", () => {
    db = openDatabase(":memory:");
    const registry = buildTaskToolRegistry(db);
    const implicit = ["say", "ask", "run_privileged", "draft_email"];
    expect(deferredTools(registry, [...DEFAULT_AGENT_TOOLS, ...implicit])).toEqual([]);
    const many = [...DEFAULT_AGENT_TOOLS, "grep", "glob", "bash", "mail_search", ...implicit];
    expect(deferredTools(registry, many)).toContain("grep");
  });
});

describe("W2-B 3: long results", () => {
  const bigText = (n: number): string => `${"a".repeat(n - 4)}-END`;

  test("a 4,000-character read_artifact result reaches the model intact", async () => {
    db = openDatabase(":memory:");
    const p = { ...persona, tools: ["read_artifact"] };
    const thread = createThread(db, p.id);
    const artifact = saveArtifact(db, { agentID: p.id, content: bigText(4_000) });
    const router = routerFor((request) => request === 1
      ? callsResponse([{ id: "call-1", name: "read_artifact", args: { artifactRef: artifact.id } }])
      : textResponse("done"));
    await runTaskTurn(db, router, settings, {
      threadID: thread.id, text: "read it", persona: p, signal: new AbortController().signal, emit: () => undefined,
    });
    const stored = db.query<{ result: string }, []>("SELECT result FROM tool_calls").get()!.result;
    const parsed = JSON.parse(stored) as { text: string; truncated?: boolean };
    expect(parsed.truncated).toBeUndefined();
    expect(parsed.text.length).toBe(4_000);
    expect(parsed.text.endsWith("-END")).toBe(true);
  });

  test("read_artifact pages with offset and limit until the whole text has been read", async () => {
    db = openDatabase(":memory:");
    const registry = new ToolRegistry();
    registerArtifactTool(registry, { db, currentAgentID: "ea" });
    const full = Array.from({ length: 2_000 }, (_, i) => `w${i}`).join(" ");
    const artifact = saveArtifact(db, { agentID: "ea", content: full });
    const handler = registry.get("read_artifact")!.handler as unknown as (a: Record<string, unknown>, c: unknown) => Promise<{ text: string; totalChars: number; nextOffset?: number }>;
    const ctx = { threadID: "t", turnID: "u", signal: new AbortController().signal };
    let offset = 0;
    let rebuilt = "";
    for (let i = 0; i < 20; i++) {
      const page = await handler({ artifactRef: artifact.id, offset, limit: 3_000 }, ctx);
      expect(page.totalChars).toBe(full.length);
      expect(page.text.length).toBeLessThanOrEqual(3_000);
      rebuilt += page.text;
      if (page.nextOffset === undefined) break;
      offset = page.nextOffset;
    }
    expect(rebuilt).toBe(full);
    // No limit asked for: a page is at most 4,000 characters.
    const first = await handler({ artifactRef: artifact.id }, ctx);
    expect(first.text.length).toBe(4_000);
    expect(first.nextOffset).toBe(4_000);
  });

  test("a delegated result is cut at 4,000 characters and ends with a pointer to the full text", () => {
    expect(summarizeResult("short answer")).toBe("short answer");
    const out = summarizeResult("word ".repeat(2_000), "art_abc");
    expect(out.length).toBeLessThanOrEqual(4_000);
    expect(out.endsWith("full result: read_artifact art_abc")).toBe(true);
    // Without an artifact there is nothing to point at.
    expect(summarizeResult("word ".repeat(2_000)).length).toBeLessThanOrEqual(4_000);
  });

  test("the wake path hands a summary-visibility result over up to 4,000 characters, not 240", async () => {
    db = openDatabase(":memory:");
    db.run("UPDATE agents SET visibility = 'summary' WHERE id = 'researcher'");
    const parentThread = createThread(db, "ea");
    const registry = new ToolRegistry();
    registerDelegateTaskTool(registry, { db, emit: () => undefined, currentAgentID: "ea", channelID: "main", parentTurnID: "trn_p", parentThreadID: parentThread.id });
    const delegate = registry.get("delegate_task")!.handler as unknown as (a: Record<string, unknown>, c: unknown) => Promise<{ taskID: string }>;
    const queued = await delegate({ toAgentID: "researcher", goal: "Report" }, { threadID: "t", turnID: "u", signal: new AbortController().signal });
    const long = Array.from({ length: 700 }, (_, i) => `row${i}`).join(" ");
    const runner = new JobRunner(db, () => undefined, { maxPerTick: 5 });
    registerTurnJob(runner, { db, router: routerFor(() => textResponse(long)), settings, emit: () => undefined });
    await runner.tick();

    const task = getTask(db, queued.taskID)!;
    expect(task.result!.length).toBeLessThanOrEqual(4_000);
    expect(task.result!.endsWith(`full result: read_artifact ${task.artifact_id}`)).toBe(true);
    const wake = listJobs(db, { includeFinished: true })
      .map((job) => parseJobPayload<{ wakeKey?: string; results?: Array<{ summary: string; redacted: boolean }> }>(job))
      .find((payload) => typeof payload.wakeKey === "string")!;
    const item = wake.results![0]!;
    expect(item.redacted).toBe(false);
    expect(item.summary.length).toBeGreaterThan(3_000);
    expect(item.summary.endsWith(`full result: read_artifact ${task.artifact_id}`)).toBe(true);
  });
});

describe("W2-B 4: run_privileged does not spend the turn's clock while the owner types", () => {
  test("a password given after the turn timeout would have fired still runs the command", async () => {
    db = openDatabase(":memory:");
    resetSecretBroker();
    const p = { ...persona, tools: ["bash"] };
    const thread = createThread(db, p.id);
    const router = routerFor((request) => request === 1
      ? callsResponse([{ id: "call-1", name: "run_privileged", args: { command: "cat", purpose: "wait on the owner" } }])
      : textResponse("Done."));
    const result = await runTaskTurn(db, router, { firstTokenTimeoutMs: 1000, turnTimeoutMs: 500 }, {
      threadID: thread.id, text: "go", persona: p, signal: new AbortController().signal,
      emit: (frame) => {
        const typed = frame as Frame;
        if (typed.type === "approval.request") {
          db!.run("UPDATE approvals SET status = 'decided', decision = 'once', decided_at = ? WHERE id = ?", [new Date().toISOString(), String(typed.requestID)]);
          resolveApprovalWaiter(String(typed.requestID), "once");
        }
        // The owner takes longer than the whole turn clock to type the password.
        if (typed.type === "secret.request") setTimeout(() => resolveSecret(String(typed.requestID), "pw"), 900);
      },
    });
    resetSecretBroker();
    expect(result.stopReason).toBe("end");
    expect(result.text).toBe("Done.");
  });

  test("the pause is bounded by the owner-wait ceiling", async () => {
    db = openDatabase(":memory:");
    resetSecretBroker();
    const p = { ...persona, tools: ["bash"] };
    const thread = createThread(db, p.id);
    const router = routerFor((request) => request === 1
      ? callsResponse([{ id: "call-1", name: "run_privileged", args: { command: "cat", purpose: "wait on the owner" } }])
      : textResponse("Done."));
    const result = await runTaskTurn(db, router, { firstTokenTimeoutMs: 1000, turnTimeoutMs: 500, ownerWaitMs: 150 }, {
      threadID: thread.id, text: "go", persona: p, signal: new AbortController().signal,
      emit: (frame) => {
        const typed = frame as Frame;
        if (typed.type === "approval.request") {
          db!.run("UPDATE approvals SET status = 'decided', decision = 'once', decided_at = ? WHERE id = ?", [new Date().toISOString(), String(typed.requestID)]);
          resolveApprovalWaiter(String(typed.requestID), "once");
        }
        if (typed.type === "secret.request") setTimeout(() => resolveSecret(String(typed.requestID), "pw"), 1_500);
      },
    });
    resetSecretBroker();
    expect(result.stopReason).toBe("timeout");
  });
});

describe("W2-B 5: an owner question that expires says so plainly", () => {
  test("ask and draft_email results say nobody answered in time, as an approval does", async () => {
    db = openDatabase(":memory:");
    const p = { ...persona, tools: ["mail_send"] };
    const thread = createThread(db, p.id);
    const router = routerFor((request) => request === 1
      ? callsResponse([
        { id: "q", name: "ask", args: { question: "Which?", options: ["a"] } },
        { id: "d", name: "draft_email", args: { to: "a@example.com", subject: "Hi", body: "Hello" } },
      ])
      : textResponse("Carried on."));
    const result = await runTaskTurn(db, router, { firstTokenTimeoutMs: 1000, turnTimeoutMs: 60_000, ownerWaitMs: 100 }, {
      threadID: thread.id, text: "ask", persona: p, signal: new AbortController().signal, emit: () => undefined,
    });
    expect(result.stopReason).toBe("end");
    const rows = db.query<{ tool_name: string; result: string }, []>("SELECT tool_name, result FROM tool_calls ORDER BY created_at").all();
    const ask = JSON.parse(rows.find((row) => row.tool_name === "ask")!.result) as { answered: boolean; note: string };
    expect(ask.answered).toBe(false);
    expect(ask.note).toContain("nobody answered in time");
    const draft = JSON.parse(rows.find((row) => row.tool_name === "draft_email")!.result) as { decided: boolean; note: string };
    expect(draft.decided).toBe(false);
    expect(draft.note).toContain("nobody answered in time");
  });
});

describe("W2-B 3 (follow-up): the task view carries a 4,000-character result intact", () => {
  test("task_status returns a 4,000-character result whole, and the loop does not shrink it", async () => {
    db = openDatabase(":memory:");
    const registry = new ToolRegistry();
    registerDelegateTaskTool(registry, { db, emit: () => undefined, currentAgentID: "ea", channelID: "main", parentTurnID: "trn_p", parentThreadID: "thr_p" });
    const ctx = { threadID: "t", turnID: "u", signal: new AbortController().signal };
    const call = (name: string, args: Record<string, unknown>) =>
      (registry.get(name)!.handler as unknown as (a: Record<string, unknown>, c: unknown) => Promise<Record<string, unknown>>)(args, ctx);
    const queued = await call("delegate_task", { toAgentID: "researcher", goal: "Report" }) as { taskID: string };
    const text = `${"b".repeat(3_996)}-END`;
    const artifact = saveArtifact(db, { taskID: queued.taskID, agentID: "researcher", content: text });
    setDelegationArtifact(db, queued.taskID, artifact.id);
    setDelegationState(db, queued.taskID, "done", text);

    const view = await call("task_status", { taskID: queued.taskID });
    expect(view.result).toBe(text);
    const sent = JSON.parse(fitToolResult(view, 6_000, 4_000)) as { result: string };
    expect(sent.result).toBe(text);
  });
});
