/**
 * Sprint 2, fix round L (B): a wake keeps the tools of the run that delegated.
 *
 * A narrowed run (a bot's brief, a delegated task) may delegate. The child is cut to the parent's tools, but the wake that reports back runs
 * as the parent bot, and used to carry no tool list at all: it ran with the bot's whole persona (bash, mail_send), so a narrowed run could
 * get more done through its own wake than it could itself. The delegation's brief now holds the run's tools; the wake carries them; a wake
 * told of several tasks takes the tools every narrowed one allowed; a set that cannot be read leaves only the inert tools.
 */
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db";
import { JobRunner } from "../src/jobs/runner";
import { registerTurnJob } from "../src/jobs/turn";
import { HealthTracker } from "../src/models/health";
import type { ProviderConfig } from "../src/models/providers";
import { Router } from "../src/models/router";
import { createRunContext } from "../src/policy/context";
import { resetPolicyHooks, setPolicyHooks } from "../src/policy/hooks";
import type { RunContext } from "../src/policy/types";
import { resetS2Startup } from "../src/startup/s2";
import { enqueueJob, listJobs, parseJobPayload } from "../src/stores/jobs";
import { createThread } from "../src/stores/threads";
import { registerDelegateTaskTool } from "../src/tools/delegate-task-tool";
import { ToolRegistry } from "../src/tools/registry";
import { buildTaskToolRegistry } from "../src/tools/task-registry";
import { fullCapabilities, seedRootTurn } from "./policy-fixture";

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
const settings = { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 };

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; resetPolicyHooks(); resetS2Startup(); });

/** The tools every run that makes a call has, as the engine sees them: the engine asks about the pause first on every call. */
function watchTools(): Array<{ principal: string; tools: Set<string> }> {
  const seen: Array<{ principal: string; tools: Set<string> }> = [];
  setPolicyHooks({ isRunPaused: (run) => { seen.push({ principal: run.principal.kind, tools: new Set(run.effectiveCapabilities) }); return null; } });
  return seen;
}

/** A run of bot "ea" that was started by another bot and cut to these tools. */
function narrowedParent(database: Database, tools: string[]): RunContext {
  seedRootTurn(database, "trn_root");
  return createRunContext({ db: database, bot: "ea", threadID: "thr_parent", turnID: "trn_parent", rootTurnID: "trn_root", principal: { kind: "peer", from: "boss" }, capabilities: tools, narrowed: true, taint: [], registry: buildTaskToolRegistry(database) });
}
function ownersTurn(database: Database): RunContext {
  seedRootTurn(database, "trn_root");
  return createRunContext({ db: database, bot: "ea", threadID: "thr_parent", turnID: "trn_parent", rootTurnID: "trn_root", principal: { kind: "owner" }, capabilities: fullCapabilities(database), registry: buildTaskToolRegistry(database) });
}

async function delegateFrom(database: Database, run: RunContext): Promise<void> {
  const registry = new ToolRegistry();
  const parent = createThread(database, "ea");
  registerDelegateTaskTool(registry, { db: database, emit: () => undefined, currentAgentID: "ea", channelID: "main", parentTurnID: "trn_parent", parentThreadID: parent.id });
  const tool = registry.get("delegate_task") as unknown as { handler: (args: Record<string, unknown>, ctx: unknown) => Promise<unknown> };
  await tool.handler({ toAgentID: "researcher", goal: "Find the delay" }, { threadID: "thr_parent", turnID: "trn_parent", signal: new AbortController().signal, run, chain: { depth: 1, rootAgentID: "ea", currentAgentID: "ea", handoffSummary: null } });
}

/** Run the delegated child, then the wake it leaves; the tools the wake's run had. */
async function wakeTools(database: Database, run: RunContext): Promise<Set<string>> {
  await delegateFrom(database, run);
  const seen = watchTools();
  const runner = new JobRunner(database, () => undefined, { maxPerTick: 5 });
  registerTurnJob(runner, {
    db: database, settings, emit: () => undefined,
    router: routerOf([() => textResponse("found it"), () => callResponse("load_tools", { names: ["job_list"] }), () => textResponse("Noted.")]),
  });
  await runner.tick();
  expect(listJobs(database, { includeFinished: true }).some((job) => parseJobPayload<{ wakeKey?: string }>(job).wakeKey), "no wake was queued").toBe(true);
  await runner.tick();
  const wake = seen.find((entry) => entry.principal === "wake");
  expect(wake, "the wake never made a call").toBeDefined();
  return wake!.tools;
}

describe("a wake of a narrowed run's delegation", () => {
  test("has only the tools the delegating run had: no bash, no mail", async () => {
    db = openDatabase(":memory:");
    const tools = await wakeTools(db, narrowedParent(db, ["say", "ask", "delegate_task", "task_status", "job_list"]));
    expect(tools.has("bash"), "the wake got a tool the narrowed run could not call").toBe(false);
    expect(tools.has("mail_send"), "the wake got a tool the narrowed run could not call").toBe(false);
    expect(tools.has("say")).toBe(true);
  });

  test("of the owner's own turn keeps the bot's whole persona, as before", async () => {
    db = openDatabase(":memory:");
    const tools = await wakeTools(db, ownersTurn(db));
    expect(tools.has("bash")).toBe(true);
    expect(tools.has("mail_send")).toBe(true);
  });

  test("whose delegating run's tools cannot be read has only the inert tools", async () => {
    db = openDatabase(":memory:");
    const run = narrowedParent(db, ["say"]);
    const broken = { ...run, effectiveCapabilities: undefined } as unknown as RunContext;
    const tools = await wakeTools(db, broken);
    expect(tools.has("bash")).toBe(false);
    expect(tools.has("mail_send")).toBe(false);
  });
});

describe("a wake told of several tasks", () => {
  // A wake the server writes today says whether the run it reports to was cut (`narrowed`); `top` replaces what it says, `{}` leaves it out as a wake
  // queued before the field existed does.
  async function wakeOf(database: Database, results: unknown[], top: Record<string, unknown> = { narrowed: false }): Promise<Set<string>> {
    const parent = createThread(database, "ea");
    const seen = watchTools();
    enqueueJob(database, { kind: "turn", payload: { agentID: "ea", threadID: parent.id, notify: false, inputRole: "system", wakeKey: `wake:${parent.id}`, depth: 1, ownerOnly: true, ...top, results } });
    const runner = new JobRunner(database, () => undefined, { maxPerTick: 5 });
    registerTurnJob(runner, { db: database, settings, emit: () => undefined, router: routerOf([() => callResponse("load_tools", { names: ["job_list"] }), () => textResponse("Noted.")]) });
    await runner.tick();
    const wake = seen.find((entry) => entry.principal === "wake");
    expect(wake, "the wake never made a call").toBeDefined();
    return wake!.tools;
  }
  const item = (extra: Record<string, unknown>) => ({ taskID: `tsk_${Math.random().toString(36).slice(2, 7)}`, agentID: "researcher", summary: "found it", redacted: false, taint: [], ownerOnly: true, ...extra });
  const non = (tools: Set<string>, ...names: string[]): string[] => names.filter((name) => tools.has(name));

  test("take the tools every narrowed task allowed", async () => {
    db = openDatabase(":memory:");
    const tools = await wakeOf(db, [
      item({ narrowed: true, capabilities: ["say", "ask", "recall_fact", "memory_search"] }),
      item({ narrowed: true, capabilities: ["say", "ask", "recall_fact", "web_search"] }),
    ]);
    expect(non(tools, "recall_fact", "memory_search", "web_search", "bash", "mail_send")).toEqual(["recall_fact"]);
  });

  test("are cut by a narrowed task even when another was not", async () => {
    db = openDatabase(":memory:");
    const tools = await wakeOf(db, [item({ narrowed: false }), item({ narrowed: true, capabilities: ["say", "ask", "recall_fact"] })]);
    expect(non(tools, "recall_fact", "memory_search", "bash")).toEqual(["recall_fact"]);
  });

  test("have only the inert tools when a narrowed task's set cannot be read", async () => {
    db = openDatabase(":memory:");
    const tools = await wakeOf(db, [item({ narrowed: true, capabilities: ["say", "recall_fact"] }), item({ narrowed: true, capabilities: "everything" })]);
    expect(non(tools, "recall_fact", "memory_search", "bash", "mail_send")).toEqual([]);
    expect(tools.has("say")).toBe(true);
  });

  test("keep the persona's tools when no task was narrowed", async () => {
    db = openDatabase(":memory:");
    const tools = await wakeOf(db, [item({ narrowed: false }), item({ narrowed: false })]);
    expect(tools.has("bash")).toBe(true);
  });

  test("queued before the field existed have only the inert tools: they came from a delegation, and nothing says it was not cut", async () => {
    db = openDatabase(":memory:");
    // The wake itself says nothing, and neither does any task it reports.
    const tools = await wakeOf(db, [item({}), item({})], {});
    expect(non(tools, "bash", "mail_send", "recall_fact", "memory_search")).toEqual([]);
    expect(tools.has("say")).toBe(true);
  });

  test("with one task that says nothing are cut by it, even when the others were not", async () => {
    db = openDatabase(":memory:");
    const tools = await wakeOf(db, [item({ narrowed: false }), item({})]);
    expect(non(tools, "bash", "mail_send", "recall_fact")).toEqual([]);
  });
});
