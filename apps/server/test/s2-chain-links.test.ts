/**
 * Sprint 2, fix round K: every boundary that stores text carries the chain's owner bit forward (`ownerOnly`, `policy/carry.ts`).
 *
 * A job a run schedules, a delegation, a handoff, a wake and a resumed task each start a run from stored text. The flags go with
 * them the way taint does, and a run is shown the engine's own view of them: the engine asks about the pause first on every call, so a
 * test that watches that hook sees each run exactly as the policy does.
 */
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { handoff } from "../src/agent/handoff";
import { rootGuardrail } from "../src/agent/guardrails";
import { defaultResolvedPersona, type ResolvedPersona } from "../src/agent/personas";
import { openDatabase } from "../src/db";
import { JobRunner } from "../src/jobs/runner";
import { registerTurnJob } from "../src/jobs/turn";
import { HealthTracker } from "../src/models/health";
import type { ProviderConfig } from "../src/models/providers";
import { Router } from "../src/models/router";
import { createRunContext } from "../src/policy/context";
import { resetPolicyHooks, setPolicyHooks } from "../src/policy/hooks";
import { resetS2Startup } from "../src/startup/s2";
import type { RunContext } from "../src/policy/types";
import { enqueueJob, listJobs, parseJobPayload } from "../src/stores/jobs";
import { getTask } from "../src/stores/tasks";
import { createThread } from "../src/stores/threads";
import { registerDelegateTaskTool } from "../src/tools/delegate-task-tool";
import { createJobTools } from "../src/tools/jobs-tool";
import { ToolRegistry } from "../src/tools/registry";
import { buildTaskToolRegistry } from "../src/tools/task-registry";
import { fullCapabilities, seedRootTurn } from "./policy-fixture";
import { say, scenarioTest, useScenarios } from "./scenarios/harness";
import { call, playTurn, scripted } from "./invariants/support";

const scenarios = useScenarios();

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

interface SeenRun { principal: string; jobID: string | null; ownerOnly: unknown }
/** Every run that makes a tool call from now on, as the engine saw it. */
function watchRuns(): SeenRun[] {
  const seen: SeenRun[] = [];
  setPolicyHooks({ isRunPaused: (run) => { seen.push({ principal: run.principal.kind, jobID: run.jobID, ownerOnly: run.ownerOnly }); return null; } });
  return seen;
}

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; resetPolicyHooks(); resetS2Startup(); });

const payloadOf = (database: Database, jobID: string): Record<string, unknown> => parseJobPayload<Record<string, unknown>>(listJobs(database, { includeFinished: true }).find((job) => job.id === jobID)!);

function ownersRun(database: Database): RunContext {
  seedRootTurn(database, "trn_root");
  return createRunContext({ db: database, bot: "ea", threadID: "thr_parent", turnID: "trn_parent", rootTurnID: "trn_root", principal: { kind: "owner" }, capabilities: fullCapabilities(database), registry: buildTaskToolRegistry(database) });
}
function wakeRun(database: Database, ownerOnly: boolean): RunContext {
  seedRootTurn(database, "trn_root");
  return createRunContext({ db: database, bot: "ea", threadID: "thr_parent", turnID: "trn_wake", rootTurnID: "trn_root", principal: { kind: "wake" }, capabilities: fullCapabilities(database), registry: buildTaskToolRegistry(database), ownerOnly });
}

describe("job_schedule: a job a run schedules is bot-made and keeps the run's marker", () => {
  const callJobSchedule = async (database: Database, run: RunContext | undefined): Promise<{ id: string }> => {
    const handler = createJobTools(database)[0]!.handler as unknown as (args: unknown, ctx: unknown) => Promise<{ id: string }>;
    return handler({ text: "do the next round", at: new Date(Date.now() + 3_600_000).toISOString() }, { threadID: "thr", turnID: "trn", signal: new AbortController().signal, run, ownerApproved: true, chain: { depth: 1, rootAgentID: "ea", currentAgentID: "ea", handoffSummary: null } });
  };

  test("from the owner's own turn: the owner's marker, and a bot's link", async () => {
    db = openDatabase(":memory:");
    expect(payloadOf(db, (await callJobSchedule(db, ownersRun(db))).id).ownerOnly).toBe(false);
  });

  test("from a run that cannot say where it came from, or with no run at all: the unknown chain", async () => {
    db = openDatabase(":memory:");
    expect(payloadOf(db, (await callJobSchedule(db, wakeRun(db, false))).id).ownerOnly).toBe(false);
    expect(payloadOf(db, (await callJobSchedule(db, undefined)).id).ownerOnly).toBe(false);
  });
});

describe("delegate_task: the brief and the job carry the chain on", () => {
  function delegateTool(database: Database): ToolRegistry {
    const registry = new ToolRegistry();
    const parent = createThread(database, "ea");
    registerDelegateTaskTool(registry, { db: database, emit: () => undefined, currentAgentID: "ea", channelID: "main", parentTurnID: "trn_parent", parentThreadID: parent.id });
    return registry;
  }
  async function delegate(database: Database, run: RunContext | undefined, goal = "Find the delay"): Promise<{ taskID: string; jobID: string }> {
    const tool = delegateTool(database).get("delegate_task") as unknown as { handler: (args: Record<string, unknown>, ctx: unknown) => Promise<{ taskID: string; jobID: string }> };
    return tool.handler({ toAgentID: "researcher", goal }, { threadID: "thr_parent", turnID: "trn_parent", signal: new AbortController().signal, run, chain: { depth: 1, rootAgentID: "ea", currentAgentID: "ea", handoffSummary: null } });
  }
  const briefOwnerOnly = (database: Database, taskID: string): unknown => (JSON.parse(getTask(database, taskID)!.brief!) as { ownerOnly?: unknown }).ownerOnly;

  test("from the owner's own turn the chain stays the owner's, on the job and on the task's brief", async () => {
    db = openDatabase(":memory:");
    const { taskID, jobID } = await delegate(db, ownersRun(db));
    expect(payloadOf(db, jobID).ownerOnly).toBe(true);
    expect(briefOwnerOnly(db, taskID)).toBe(true);
  });

  test("from a run a bot started, the link is a bot's and the marker is kept", async () => {
    db = openDatabase(":memory:");
    const { taskID, jobID } = await delegate(db, wakeRun(db, true));
    expect(payloadOf(db, jobID).ownerOnly).toBe(false);
    expect(briefOwnerOnly(db, taskID)).toBe(false);
  });

  test("from a chain already marked, it stays marked; from no run at all, it reads as unknown", async () => {
    db = openDatabase(":memory:");
    const marked = await delegate(db, wakeRun(db, false));
    expect(payloadOf(db, marked.jobID).ownerOnly).toBe(false);
    const orphan = await delegate(db, undefined, "Find the other delay");
    expect(payloadOf(db, orphan.jobID).ownerOnly).toBe(false);
    expect(briefOwnerOnly(db, orphan.taskID)).toBe(false);
  });
});

describe("handoff: the child keeps the marker of the chain it was handed", () => {
  async function runHandoff(database: Database, run: RunContext | undefined): Promise<void> {
    const thread = createThread(database, "ea");
    const scout: ResolvedPersona = { ...defaultResolvedPersona(database), id: "researcher", name: "Scout", tools: ["update_agent"] };
    await handoff({
      db: database, router: routerOf([() => callResponse("update_agent", { role: "x" }), () => textResponse("done")]), settings,
      emit: () => undefined, signal: new AbortController().signal, threadID: thread.id, guardrail: rootGuardrail("ea"), persona: scout, run,
    }, { toAgentID: "researcher", task: "go", emit: () => undefined, signal: new AbortController().signal });
  }

  test("a child of the owner's own turn carries the owner's chain as it is; a child of a run with no record does not", async () => {
    db = openDatabase(":memory:");
    const seen = watchRuns();
    await runHandoff(db, ownersRun(db));
    const child = seen.filter((run) => run.principal === "peer");
    expect(child.length, "the child never made a call").toBeGreaterThan(0);
    expect(child.map((run) => run.ownerOnly), "the handoff dropped the owner's bit").toEqual(child.map(() => true));
    seen.length = 0;
    await runHandoff(db, wakeRun(db, false));
    const orphan = seen.filter((run) => run.principal === "peer");
    expect(orphan.length).toBeGreaterThan(0);
    expect(orphan.map((run) => run.ownerOnly)).toEqual(orphan.map(() => false));
  });

  test("a child of a run a bot started is a bot-chained run, and the marker is kept", async () => {
    db = openDatabase(":memory:");
    const seen = watchRuns();
    await runHandoff(db, wakeRun(db, true));
    const child = seen.filter((run) => run.principal === "peer");
    expect(child.length).toBeGreaterThan(0);
    expect(child.map((run) => run.ownerOnly)).toEqual(child.map(() => false));
  });
});

describe("a job's fire starts with the chain its payload carries", () => {
  async function fire(database: Database, payload: Record<string, unknown>): Promise<SeenRun[]> {
    const seen = watchRuns();
    enqueueJob(database, { kind: "turn", payload: { agentID: "ea", text: "do it", notify: false, ...payload } });
    const runner = new JobRunner(database, () => undefined, { maxPerTick: 5 });
    registerTurnJob(runner, { db: database, router: routerOf([() => callResponse("load_tools", { names: ["job_list"] }), () => textResponse("ok")]), settings, emit: () => undefined });
    await runner.tick();
    return seen.filter((run) => run.jobID !== null);
  }

  test("an owner-made job (its marker on the payload) fires as the owner's work", async () => {
    db = openDatabase(":memory:");
    const [run] = await fire(db, { ownerOnly: true });
    expect(run, "the fire never made a tool call").toBeDefined();
    expect({ principal: run!.principal, ownerOnly: run!.ownerOnly }).toEqual({ principal: "owner", ownerOnly: true });
  });

  test("a job with no marker, a marker that cannot be read, or one that says it was bot-chained is not the owner's", async () => {
    for (const [what, payload] of [
      ["no marker", {}],
      ["a string", { ownerOnly: "owner" }],
      ["a list", { ownerOnly: [true, false] }],
      ["null", { ownerOnly: null }],
      ["a string that says true", { ownerOnly: "true" }],
      ["a bot's link", { inputRole: "system", ownerOnly: false }],
    ] as const) {
      db = openDatabase(":memory:");
      const [run] = await fire(db, payload);
      expect(run, `${what}: the fire never made a tool call`).toBeDefined();
      expect({ what, ownersWork: run!.ownerOnly === true }).toEqual({ what, ownersWork: false });
      db.close();
      db = undefined;
    }
  });
});

describe("a wake: it reports back inside the chain the task came from", () => {
  function delegateFrom(database: Database, run: RunContext): Promise<{ taskID: string; jobID: string }> {
    const registry = new ToolRegistry();
    const parent = createThread(database, "ea");
    registerDelegateTaskTool(registry, { db: database, emit: () => undefined, currentAgentID: "ea", channelID: "main", parentTurnID: "trn_parent", parentThreadID: parent.id });
    const tool = registry.get("delegate_task") as unknown as { handler: (args: Record<string, unknown>, ctx: unknown) => Promise<{ taskID: string; jobID: string }> };
    return tool.handler({ toAgentID: "researcher", goal: "Find the delay" }, { threadID: "thr_parent", turnID: "trn_parent", signal: new AbortController().signal, run, chain: { depth: 1, rootAgentID: "ea", currentAgentID: "ea", handoffSummary: null } });
  }
  /** Run the child, then the wake it leaves, and report the wake's payload and the runs seen. */
  async function throughWake(database: Database, run: RunContext): Promise<{ wake: Record<string, unknown>; seen: SeenRun[] }> {
    await delegateFrom(database, run);
    const seen = watchRuns();
    const runner = new JobRunner(database, () => undefined, { maxPerTick: 5 });
    registerTurnJob(runner, {
      db: database, settings, emit: () => undefined,
      router: routerOf([() => textResponse("found it"), () => callResponse("load_tools", { names: ["job_list"] }), () => textResponse("Noted.")]),
    });
    await runner.tick();
    const wakeRow = listJobs(database, { includeFinished: true }).find((job) => parseJobPayload<{ wakeKey?: string }>(job).wakeKey);
    expect(wakeRow, "no wake was queued").toBeDefined();
    const wake = parseJobPayload<Record<string, unknown>>(wakeRow!);
    await runner.tick();
    return { wake, seen: seen.filter((entry) => entry.principal === "wake") };
  }

  test("the owner's own turn delegated: the wake is the owner's chain, on its payload and on its run", async () => {
    db = openDatabase(":memory:");
    const { wake, seen } = await throughWake(db, ownersRun(db));
    expect(wake.ownerOnly, "the wake dropped the chain the task came from").toBe(true);
    expect((wake.results as Array<{ ownerOnly?: unknown }>)[0]!.ownerOnly).toBe(true);
    expect(seen.length, "the wake never made a call").toBeGreaterThan(0);
    expect(seen[0]!.ownerOnly).toBe(true);
  });

  test("a bot delegated: the wake is a bot-chained run", async () => {
    db = openDatabase(":memory:");
    const { wake, seen } = await throughWake(db, wakeRun(db, true));
    expect(wake.ownerOnly).toBe(false);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]!.ownerOnly).toBe(false);
  });

  test("a wake told of several tasks is the owner's only if every task's chain is", async () => {
    db = openDatabase(":memory:");
    const parent = createThread(db, "ea");
    const seen = watchRuns();
    enqueueJob(db, {
      kind: "turn",
      payload: {
        agentID: "ea", threadID: parent.id, notify: false, inputRole: "system", wakeKey: `wake:${parent.id}`, depth: 1, ownerOnly: true,
        results: [
          { taskID: "tsk_a", agentID: "researcher", summary: "found it", redacted: false, taint: [], ownerOnly: true },
          { taskID: "tsk_b", agentID: "researcher", summary: "found more", redacted: false, taint: [], ownerOnly: false },
        ],
      },
    });
    const runner = new JobRunner(db, () => undefined, { maxPerTick: 5 });
    registerTurnJob(runner, { db, settings, emit: () => undefined, router: routerOf([() => callResponse("load_tools", { names: ["job_list"] }), () => textResponse("Noted.")]) });
    await runner.tick();
    const run = seen.find((entry) => entry.principal === "wake");
    expect(run, "the wake never made a call").toBeDefined();
    expect(run!.ownerOnly).toBe(false);
  });

  test("a result with no record of its chain makes the wake a bot's", async () => {
    db = openDatabase(":memory:");
    const parent = createThread(db, "ea");
    const seen = watchRuns();
    enqueueJob(db, {
      kind: "turn",
      payload: { agentID: "ea", threadID: parent.id, notify: false, inputRole: "system", wakeKey: `wake:${parent.id}`, depth: 1, ownerOnly: true, results: [{ taskID: "tsk_a", agentID: "researcher", summary: "found it", redacted: false, taint: [] }] },
    });
    const runner = new JobRunner(db, () => undefined, { maxPerTick: 5 });
    registerTurnJob(runner, { db, settings, emit: () => undefined, router: routerOf([() => callResponse("load_tools", { names: ["job_list"] }), () => textResponse("Noted.")]) });
    await runner.tick();
    const run = seen.find((entry) => entry.principal === "wake");
    expect(run).toBeDefined();
    expect(run!.ownerOnly, "a result with no chain record was taken as the owner's").toBe(false);
  });
});

describe("a resumed task goes on in the chain it was delegated in", () => {
  scenarioTest("through the real loop: the owner's answer resumes the child, and the resumed job carries the brief's chain", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    s.model.queue(...scripted(true, [call("delegate_task", { toAgentID: "coder", goal: "Replace the contents of the ledger file with a fresh one." }, "call_delegate"), say("The coder is on it.")]));
    await playTurn(s, a, "refresh the ledger", { answer: () => "once" });
    s.model.queue(call("request_owner_input", { question: "Which fresh contents?" }, "call_ask"));
    const parked = (): { id: string; q: string } | null => {
      const row = s.get<{ id: string; pending_question_id: string | null; delegate_state: string }>("SELECT id, pending_question_id, delegate_state FROM tasks WHERE owner_agent_id = 'coder'");
      return row?.delegate_state === "needs_input" && row.pending_question_id ? { id: row.id, q: row.pending_question_id } : null;
    };
    for (let tick = 0; tick < 6 && parked() === null; tick += 1) await s.runner().tick();
    const task = parked();
    expect(task, "the coder never parked on its question; the script is out of step").not.toBeNull();
    const brief = JSON.parse(s.get<{ brief: string }>("SELECT brief FROM tasks WHERE id = ?", task!.id)!.brief) as { ownerOnly?: unknown };
    expect(brief.ownerOnly, "the owner's own turn delegated, so the brief says the chain is the owner's").toBe(true);

    a.send({ type: "task.answer", taskID: task!.id, questionID: task!.q, text: "Just empty it." });
    await a.waitFor("task.answer.ok", { why: "the answer to be accepted" });
    const resumed = s.get<{ payload: string }>("SELECT j.payload FROM jobs j JOIN tasks t ON t.job_id = j.id WHERE t.id = ?", task!.id)!;
    expect((JSON.parse(resumed.payload) as { ownerOnly?: unknown }).ownerOnly, "the resumed run did not keep the chain it was delegated in").toBe(true);
  });
});

test("the owner's own CLI job is stamped as the owner's work", async () => {
  const { ownerJobPayload } = await import("../src/jobs/owner-job");
  expect(ownerJobPayload({ text: "weekly check" }).ownerOnly).toBe(true);
});
