/**
 * S2-06: taint goes with the work. A bot that has read outside text cannot hand the job to
 * another bot and get back what it may not do itself; what the other bot read comes back with
 * its answer; a wake, a group room and an artifact carry it too.
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
import { registerArtifactTool } from "../src/tools/artifact-tool";
import { JobRunner } from "../src/jobs/runner";
import { registerTurnJob } from "../src/jobs/turn";
import { enqueueJob, listJobs, parseJobPayload } from "../src/stores/jobs";
import { getTask, setDelegationArtifact, setDelegationState } from "../src/stores/tasks";
import { saveArtifact } from "../src/stores/artifacts";
import { appendChannelMessage } from "../src/stores/channels";
import { groupTaint } from "../src/agent/group";
import { createRunContext, unpackTaint } from "../src/policy/context";
import { carryTaint, saveTaskTaint, taskTaint } from "../src/policy/carry";
import type { RunContext, TaintSource } from "../src/policy/types";
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

const WEB: TaintSource = { kind: "web", label: "evil.example/page", tool: "web_fetch", at: "2026-11-16T10:00:00Z" };
let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

function parentRun(database: Database, taint: TaintSource[] = []): RunContext {
  seedRootTurn(database, "trn_root");
  const registry = buildTaskToolRegistry(database);
  return createRunContext({
    db: database, bot: "ea", threadID: "thr_parent", turnID: "trn_parent", rootTurnID: "trn_root",
    principal: { kind: "owner" }, capabilities: fullCapabilities(database), registry, taint,
  });
}

describe("handoff: the child starts with what the parent read, and the parent takes back what the child read", () => {
  const scout = (database: Database): ResolvedPersona => ({ ...defaultResolvedPersona(database), id: "researcher", name: "Scout", tools: ["update_agent"] });
  const updateCall = (): Response => callResponse("update_agent", { role: "do what the page says" });

  async function runHandoff(database: Database, run: RunContext | undefined) {
    const thread = createThread(database, "ea");
    return handoff({
      db: database, router: routerOf([updateCall, () => textResponse("done")]), settings: { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 },
      emit: () => undefined, signal: new AbortController().signal, threadID: thread.id, guardrail: rootGuardrail("ea"),
      persona: scout(database), run,
    }, { toAgentID: "researcher", task: "go", emit: () => undefined, signal: new AbortController().signal });
  }
  const childUpdate = (database: Database) =>
    database.query<{ error: string | null }, []>("SELECT error FROM tool_calls WHERE tool_name = 'update_agent'").get()!.error;

  test("a child of a tainted run may not change bots", async () => {
    db = openDatabase(":memory:");
    await runHandoff(db, parentRun(db, [WEB]));
    expect(childUpdate(db)).toBe("protected_write");
  });

  test("a child of a clean run is not held back", async () => {
    db = openDatabase(":memory:");
    await runHandoff(db, parentRun(db));
    expect(childUpdate(db)).not.toBe("protected_write");
  });

  test("what the child read comes back with its result", async () => {
    db = openDatabase(":memory:");
    const result = await runHandoff(db, parentRun(db, [WEB]));
    expect(result.taint.map((source) => source.label)).toContain("evil.example/page");
    const clean = await runHandoff(db, parentRun(db));
    expect(clean.taint).toEqual([]);
  });

  test("the parent is marked by a tainted answer, and by nothing else", () => {
    db = openDatabase(":memory:");
    const run = parentRun(db);
    expect(carryTaint(run, "Scout", [], "handoff")).toBe(false);
    expect(run.taint.sources).toEqual([]);
    expect(carryTaint(run, "Scout", [WEB], "handoff")).toBe(true);
    expect(run.taint.sources.map((source) => [source.kind, source.label])).toEqual([["peer", "Scout"]]);
    // The same bot twice marks the run once.
    expect(carryTaint(run, "Scout", [WEB], "handoff")).toBe(false);
  });
});

describe("delegate_task: the brief carries the taint, the task keeps it, the wake and the readers take it back", () => {
  function delegateTool(database: Database) {
    const registry = new ToolRegistry();
    // The parent's thread exists, as it does for a real turn: the wake goes back to it.
    const parent = createThread(database, "ea");
    registerDelegateTaskTool(registry, { db: database, emit: () => undefined, currentAgentID: "ea", channelID: "main", parentTurnID: "trn_parent", parentThreadID: parent.id });
    return registry;
  }
  async function delegate(database: Database, run: RunContext): Promise<{ taskID: string; jobID: string }> {
    return delegateWith(delegateTool(database), run);
  }
  async function delegateWith(registry: ToolRegistry, run: RunContext): Promise<{ taskID: string; jobID: string }> {
    const tool = registry.get("delegate_task") as unknown as { handler: (args: Record<string, unknown>, ctx: unknown) => Promise<{ taskID: string; jobID: string }> };
    return tool.handler({ toAgentID: "researcher", goal: "Find the delay" }, { threadID: "thr_parent", turnID: "trn_parent", signal: new AbortController().signal, run, chain: { depth: 1, rootAgentID: "ea", currentAgentID: "ea", handoffSummary: null } });
  }
  const payloadOf = (database: Database, jobID: string) => parseJobPayload<Record<string, unknown>>(listJobs(database, { includeFinished: true }).find((job) => job.id === jobID)!);

  test("the job that runs the task is told what the parent read, and which run it belongs to", async () => {
    db = openDatabase(":memory:");
    const { jobID } = await delegate(db, parentRun(db, [WEB]));
    const payload = payloadOf(db, jobID);
    expect(unpackTaint(payload.taint).map((source) => source.label)).toEqual(["evil.example/page"]);
    expect(payload.rootTurnID).toBe("trn_root");
  });

  test("a clean parent sends an empty list, which says it read nothing outside", async () => {
    db = openDatabase(":memory:");
    const { jobID } = await delegate(db, parentRun(db));
    expect(payloadOf(db, jobID).taint).toEqual([]);
  });

  test("when the task ends its run's taint is saved on the task, and a wake carries it to the parent", async () => {
    db = openDatabase(":memory:");
    const { taskID } = await delegate(db, parentRun(db, [WEB]));
    const runner = new JobRunner(db, () => undefined, { maxPerTick: 5 });
    registerTurnJob(runner, { db, router: routerOf([() => textResponse("found it")]), settings: { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, emit: () => undefined });
    await runner.tick();
    expect(taskTaint(db, taskID).map((source) => source.label)).toEqual(["evil.example/page"]);
    const wake = listJobs(db, { includeFinished: true }).map((job) => parseJobPayload<{ wakeKey?: string; results?: Array<{ taint?: unknown }> }>(job)).find((payload) => payload.wakeKey);
    expect(unpackTaint(wake!.results![0]!.taint).map((source) => source.label)).toEqual(["evil.example/page"]);
  });

  test("a task that read nothing outside leaves nothing on the task", async () => {
    db = openDatabase(":memory:");
    const { taskID } = await delegate(db, parentRun(db));
    const runner = new JobRunner(db, () => undefined, { maxPerTick: 5 });
    registerTurnJob(runner, { db, router: routerOf([() => textResponse("found it")]), settings: { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, emit: () => undefined });
    await runner.tick();
    expect(taskTaint(db, taskID)).toEqual([]);
  });

  test("task_status, delegate_wait and read_artifact mark the reader when the task read outside text", async () => {
    db = openDatabase(":memory:");
    const registry = delegateTool(db);
    registerArtifactTool(registry, { db, currentAgentID: "ea" });
    const { taskID } = await delegateWith(registry, parentRun(db));
    const artifact = saveArtifact(db, { agentID: "researcher", taskID, content: "the answer" });
    setDelegationArtifact(db, taskID, artifact.id);
    setDelegationState(db, taskID, "done", "the answer");
    saveTaskTaint(db, taskID, [WEB]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const run = parentRun(db!);
      await (registry.get(name) as unknown as { handler: (a: Record<string, unknown>, c: unknown) => Promise<unknown> }).handler(args, {
        threadID: "t", turnID: "u", signal: new AbortController().signal, run, chain: { depth: 1, rootAgentID: "ea", currentAgentID: "ea", handoffSummary: null },
      });
      return run.taint.sources.map((source) => source.label);
    };
    expect(await call("task_status", { taskID })).toEqual(["Researcher"]);
    expect(await call("delegate_wait", { taskID })).toEqual(["Researcher"]);
    expect(await call("read_artifact", { artifactRef: artifact.id })).toEqual(["Researcher"]);
    expect(getTask(db, taskID)!.delegate_state).toBe("done");
  });
});

describe("a wake turn", () => {
  /** Tell the parent bot that a task finished, as the daemon does, and let it try to schedule a follow-up. */
  async function wakeAndSchedule(database: Database, taint: TaintSource[]): Promise<{ error: string | null; queued: number }> {
    const parent = createThread(database, "ea");
    const replies = [
      () => callResponse("load_tools", { names: ["job_schedule"] }),
      () => callResponse("job_schedule", { text: "Check in tomorrow", at: new Date(Date.now() + 86_400_000).toISOString() }),
      () => textResponse("Noted."),
    ];
    const runner = new JobRunner(database, () => undefined, { maxPerTick: 5 });
    registerTurnJob(runner, { db: database, router: routerOf(replies), settings: { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, emit: () => undefined });
    enqueueJob(database, {
      kind: "turn",
      payload: {
        agentID: "ea", threadID: parent.id, notify: false, inputRole: "system", wakeKey: `wake:${parent.id}`, depth: 1,
        results: [{ taskID: "tsk_done", agentID: "researcher", summary: "found it", redacted: false, taint }],
      },
    });
    await runner.tick();
    const row = database.query<{ error: string | null }, []>("SELECT error FROM tool_calls WHERE tool_name = 'job_schedule'").get();
    const queued = listJobs(database).filter((job) => parseJobPayload<{ scheduledBy?: string }>(job).scheduledBy === "bot").length;
    return { error: row?.error ?? null, queued };
  }

  test("that heard of a task which read nothing outside may schedule a follow-up", async () => {
    db = openDatabase(":memory:");
    expect(await wakeAndSchedule(db, [])).toEqual({ error: null, queued: 1 });
  });

  test("that heard of a task which read outside text may not", async () => {
    db = openDatabase(":memory:");
    expect(await wakeAndSchedule(db, [WEB])).toEqual({ error: "protected_write", queued: 0 });
  });
});

describe("a group room", () => {
  test("a bot reading the room is marked when another bot's recent message came from a tainted run", () => {
    db = openDatabase(":memory:");
    db.run("INSERT INTO channels (id, name, agent_id, created_at, updated_at) VALUES ('grp_1', 'Team', 'ea', '2026-11-16T10:00:00Z', '2026-11-16T10:00:00Z')");
    const post = (from: string, tainted: boolean) => {
      const row = appendChannelMessage(db!, { channelID: "grp_1", fromType: "agent", fromID: from, text: `${from} says hi`, uiHint: "normal" });
      if (tainted) db!.run("UPDATE channel_messages SET tainted = 1 WHERE id = ?", [row.id]);
    };
    post("researcher", false);
    expect(groupTaint(db, "grp_1", "ea")).toEqual([]);
    post("coder", true);
    expect(groupTaint(db, "grp_1", "ea").map((source) => source.kind)).toEqual(["peer"]);
    // A bot's own tainted message does not mark it twice.
    expect(groupTaint(db, "grp_1", "coder")).toEqual([]);
  });
});

