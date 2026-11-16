/**
 * S2-06: a child's effective tools are its persona's tools, the grant, and the
 * parent's effective capabilities, all intersected. A parent that cannot be
 * read gives the child nothing beyond the inert tools (fail closed).
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { HealthTracker } from "../src/models/health";
import type { ProviderConfig } from "../src/models/providers";
import { Router } from "../src/models/router";
import { handoff } from "../src/agent/handoff";
import { rootGuardrail } from "../src/agent/guardrails";
import { defaultResolvedPersona, type ResolvedPersona } from "../src/agent/personas";
import { createThread } from "../src/stores/threads";
import { ToolRegistry } from "../src/tools/registry";
import { registerDelegateTaskTool } from "../src/tools/delegate-task-tool";
import { JobRunner } from "../src/jobs/runner";
import { registerTurnJob } from "../src/jobs/turn";
import { listJobs, parseJobPayload } from "../src/stores/jobs";
import { createRunContext } from "../src/policy/context";
import { narrowCapabilities, readCapabilities } from "../src/policy/narrowing";
import type { RunContext } from "../src/policy/types";
import { buildTaskToolRegistry } from "../src/tools/task-registry";

const provider: ProviderConfig = { id: "test", label: "Test", baseUrl: "https://test.local/v1", apiKey: "test", model: "mock" };
function streamResponse(events: unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(body)); controller.close(); },
  }), { status: 200 });
}
const callResponse = (name: string, args: unknown): Response =>
  streamResponse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: `call-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] }]);
const textResponse = (text: string): Response => streamResponse([{ choices: [{ delta: { content: text } }] }]);
const routerOf = (replies: Array<() => Response>): Router => {
  let n = 0;
  return new Router([provider], new HealthTracker(), (async () => replies[Math.min(n++, replies.length - 1)]!()) as unknown as typeof fetch);
};

/** What a call to a tool outside the bot's effective set is answered with. */
const NOT_ALLOWED = "tool_not_allowed";

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

function parentRun(database: Database, capabilities: Iterable<string>): RunContext {
  const registry = buildTaskToolRegistry(database);
  return createRunContext({
    db: database, bot: "ea", threadID: "thr_parent", turnID: "trn_parent", rootTurnID: "trn_root",
    principal: { kind: "owner" }, capabilities, registry,
  });
}

describe("narrowCapabilities", () => {
  test("a child keeps only what its parent also holds", () => {
    expect([...narrowCapabilities(["read_file", "write_file", "web_search"], ["read_file", "web_search", "bash"])].sort()).toEqual(["read_file", "web_search"]);
  });

  test("the grant narrows further, and it never widens", () => {
    expect([...narrowCapabilities(["read_file", "write_file"], ["read_file", "write_file", "bash"], ["write_file", "bash"])]).toEqual(["write_file"]);
  });

  test("a parent that cannot be read leaves only the inert tools", () => {
    expect([...narrowCapabilities(["read_file", "write_file", "say", "ask", "load_tools"], undefined)].sort()).toEqual(["ask", "load_tools", "say"]);
    expect([...narrowCapabilities(["read_file", "say"], [])]).toEqual(["say"]);
  });

  test("a stored capability list is read back strictly: anything but a list of names is unreadable", () => {
    expect(readCapabilities(["read_file", "say"])).toEqual(["read_file", "say"]);
    expect(readCapabilities([])).toEqual([]);
    expect(readCapabilities(undefined)).toBeUndefined();
    expect(readCapabilities("read_file")).toBeUndefined();
    expect(readCapabilities(["read_file", 7])).toBeUndefined();
    expect(readCapabilities({ length: 1 })).toBeUndefined();
  });
});

describe("handoff: the child cannot call what its parent could not", () => {
  const scout = (database: Database): ResolvedPersona => ({ ...defaultResolvedPersona(database), id: "researcher", name: "Scout", tools: ["recall_fact", "web_search"] });

  async function runHandoff(database: Database, run: RunContext | undefined) {
    const thread = createThread(database, "ea");
    return handoff({
      db: database, router: routerOf([() => callResponse("web_search", { query: "anything" }), () => textResponse("done")]), settings: { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 },
      emit: () => undefined, signal: new AbortController().signal, threadID: thread.id, guardrail: rootGuardrail("ea"),
      persona: scout(database), run,
    }, { toAgentID: "researcher", task: "go", emit: () => undefined, signal: new AbortController().signal });
  }
  const searchError = (database: Database) =>
    database.query<{ error: string | null }, []>("SELECT error FROM tool_calls WHERE tool_name = 'web_search'").get()!.error;

  test("a tool its parent lacks is refused", async () => {
    db = openDatabase(":memory:");
    await runHandoff(db, parentRun(db, ["recall_fact", "say", "ask", "handoff"]));
    expect(searchError(db)).toBe(NOT_ALLOWED);
  });

  test("a tool its parent holds still runs", async () => {
    db = openDatabase(":memory:");
    await runHandoff(db, parentRun(db, ["recall_fact", "web_search", "say", "ask", "handoff"]));
    expect(searchError(db)).not.toBe(NOT_ALLOWED);
  });

  test("a delegation with no run behind it gets nothing beyond the inert tools", async () => {
    db = openDatabase(":memory:");
    await runHandoff(db, undefined);
    expect(searchError(db)).toBe(NOT_ALLOWED);
  });
});

describe("delegate_task: the job carries the parent's capabilities, and the child runs inside them", () => {
  function delegate(database: Database, run: RunContext): Promise<{ taskID: string; jobID: string }> {
    const registry = new ToolRegistry();
    const parent = createThread(database, "ea");
    registerDelegateTaskTool(registry, { db: database, emit: () => undefined, currentAgentID: "ea", channelID: "main", parentTurnID: "trn_parent", parentThreadID: parent.id });
    const tool = registry.get("delegate_task") as unknown as { handler: (args: Record<string, unknown>, ctx: unknown) => Promise<{ taskID: string; jobID: string }> };
    return tool.handler({ toAgentID: "researcher", goal: "Find the delay" }, { threadID: "thr_parent", turnID: "trn_parent", signal: new AbortController().signal, run, chain: { depth: 1, rootAgentID: "ea", currentAgentID: "ea", handoffSummary: null } });
  }
  const payloadOf = (database: Database, jobID: string) => parseJobPayload<Record<string, unknown>>(listJobs(database, { includeFinished: true }).find((job) => job.id === jobID)!);

  async function runJob(database: Database): Promise<string | null> {
    const runner = new JobRunner(database, () => undefined, { maxPerTick: 1 });
    registerTurnJob(runner, { db: database, router: routerOf([() => callResponse("web_search", { query: "anything" }), () => textResponse("done")]), settings: { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, emit: () => undefined });
    await runner.tick();
    return database.query<{ error: string | null }, []>("SELECT error FROM tool_calls WHERE tool_name = 'web_search'").get()?.error ?? null;
  }

  test("the payload lists exactly what the parent could call", async () => {
    db = openDatabase(":memory:");
    const { jobID } = await delegate(db, parentRun(db, ["recall_fact", "say"]));
    expect([...(payloadOf(db, jobID).capabilities as string[])].sort()).toEqual(["recall_fact", "say"]);
  });

  test("a researcher whose delegator cannot search is refused the search", async () => {
    db = openDatabase(":memory:");
    await delegate(db, parentRun(db, ["recall_fact", "say", "ask", "delegate_task"]));
    expect(await runJob(db)).toBe(NOT_ALLOWED);
  });

  test("a researcher whose delegator can search may", async () => {
    db = openDatabase(":memory:");
    await delegate(db, parentRun(db, ["recall_fact", "web_search", "say", "ask", "delegate_task"]));
    expect(await runJob(db)).not.toBe(NOT_ALLOWED);
  });

  test("a queued delegation whose payload has no readable capabilities gets nothing beyond the inert tools", async () => {
    for (const broken of [undefined, "web_search", [1, 2]]) {
      const database = openDatabase(":memory:");
      try {
        const { jobID } = await delegate(database, parentRun(database, ["recall_fact", "web_search", "say", "ask", "delegate_task"]));
        const payload = { ...payloadOf(database, jobID) };
        if (broken === undefined) delete payload.capabilities; else payload.capabilities = broken;
        database.run("UPDATE jobs SET payload = ? WHERE id = ?", [JSON.stringify(payload), jobID]);
        expect(await runJob(database), `capabilities ${JSON.stringify(broken)}`).toBe(NOT_ALLOWED);
      } finally {
        database.close();
      }
    }
  });
});
