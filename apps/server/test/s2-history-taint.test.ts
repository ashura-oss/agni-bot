/**
 * Sprint 2, fix round L (C): taint does not stop at the end of a run when its words stay in the thread.
 *
 * A run reads the thread's stored history. If the run before it (a fire of the same recurring job, the turn a wake reports into, the
 * first try of a job that failed) had read outside text, the history holds words that run wrote under that text's influence, and the
 * next run started clean. A run that is not the owner's own chat turn now starts with a `history` source when the thread's last session
 * is marked, or its mark cannot be read. The owner's own chat turn is exempt: the owner is there to see what is said. A task keeps what any
 * of its tries read, and a retry starts with it.
 */
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db";
import { JobRunner } from "../src/jobs/runner";
import { registerTurnJob } from "../src/jobs/turn";
import { HealthTracker } from "../src/models/health";
import type { ProviderConfig } from "../src/models/providers";
import { Router } from "../src/models/router";
import { addTaint, createRunContext } from "../src/policy/context";
import { taskTaint } from "../src/policy/carry";
import { resetPolicyHooks, setPolicyHooks } from "../src/policy/hooks";
import type { RunContext, TaintSource } from "../src/policy/types";
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
const WEB: TaintSource = { kind: "web", label: "evil.example/page", tool: "web_fetch", at: "2026-11-16T10:00:00Z" };
const past = (): string => new Date(Date.now() - 1_000).toISOString();

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; resetPolicyHooks(); resetS2Startup(); });

interface Seen { principal: string; sources: Array<{ kind: string; label: string }> }
/** The taint every run that makes a call has when it makes its first call; `read` runs first and may mark the run, as reading a page would. */
function watch(read?: (run: RunContext) => void): Seen[] {
  const seen: Seen[] = [];
  setPolicyHooks({
    isRunPaused: (run) => {
      read?.(run);
      seen.push({ principal: run.principal.kind, sources: run.taint.sources.map((source) => ({ kind: source.kind, label: source.label })) });
      return null;
    },
  });
  return seen;
}
const kinds = (entry: Seen | undefined): string[] => (entry?.sources ?? []).map((source) => source.kind);
const READS_A_PAGE = (run: RunContext): void => { addTaint(run, WEB); };

/** Fire a job once, to the end. */
async function fire(database: Database, replies: Array<() => Response>): Promise<void> {
  const runner = new JobRunner(database, () => undefined, { maxPerTick: 5 });
  registerTurnJob(runner, { db: database, settings, emit: () => undefined, router: routerOf(replies) });
  await runner.tick();
}
const callThenAnswer = [() => callResponse("load_tools", { names: ["job_list"] }), () => textResponse("Done.")];
const makeDue = (database: Database): void => { database.run("UPDATE jobs SET run_at = ?, state = 'queued' WHERE kind = 'turn' AND state != 'failed'", [past()]); };

describe("the next fire of a recurring job", () => {
  const botJob = (extra: Record<string, unknown> = {}) => ({ agentID: "ea", text: "check the inbox", notify: false, inputRole: "system", scheduledBy: "bot", ownerOnly: false, taint: [], everyMs: 3_600_000, ...extra });

  test("is tainted when the fire before it read outside text", async () => {
    db = openDatabase(":memory:");
    enqueueJob(db, { kind: "turn", payload: botJob() });
    const first = watch(READS_A_PAGE);
    await fire(db, callThenAnswer);
    expect(kinds(first[0]), "fire 1 was not marked; the test is out of step").toContain("web");
    makeDue(db);
    const second = watch();
    await fire(db, callThenAnswer);
    expect(second.length, "fire 2 never made a call").toBeGreaterThan(0);
    expect(kinds(second[0]), "fire 2 started clean over a thread a tainted run wrote in").toContain("history");
  });

  test("starts clean when the fire before it read nothing outside", async () => {
    db = openDatabase(":memory:");
    enqueueJob(db, { kind: "turn", payload: botJob() });
    watch();
    await fire(db, callThenAnswer);
    makeDue(db);
    const second = watch();
    await fire(db, callThenAnswer);
    expect(second.length).toBeGreaterThan(0);
    expect(kinds(second[0])).toEqual([]);
  });

  test("of a job the owner made is not marked: the owner is present", async () => {
    db = openDatabase(":memory:");
    enqueueJob(db, { kind: "turn", payload: { agentID: "ea", text: "check the inbox", notify: false, ownerOnly: true, everyMs: 3_600_000 } });
    watch(READS_A_PAGE);
    await fire(db, callThenAnswer);
    makeDue(db);
    const second = watch();
    await fire(db, callThenAnswer);
    expect(second.length).toBeGreaterThan(0);
    expect(second[0]!.principal).toBe("owner");
    expect(kinds(second[0])).toEqual([]);
  });
});

describe("a wake", () => {
  /** A thread whose last session has this record of what it read (the column is null when no record was kept). */
  function parentThread(database: Database, taint: string | null | undefined): string {
    const thread = createThread(database, "ea");
    if (taint === undefined) return thread.id;
    database.run(
      "INSERT INTO agent_sessions (thread_id, turn_id, state, message_log, step_count, token_count, max_steps, max_tokens, created_at, updated_at, taint) VALUES (?, 'trn_before', 'done', '[]', 0, 0, 0, 0, datetime('now'), datetime('now'), ?)",
      [thread.id, taint],
    );
    return thread.id;
  }
  async function wake(database: Database, threadID: string): Promise<Seen | undefined> {
    enqueueJob(database, {
      kind: "turn",
      payload: { agentID: "ea", threadID, notify: false, inputRole: "system", wakeKey: `wake:${threadID}`, depth: 1, ownerOnly: true, results: [{ taskID: "tsk_a", agentID: "researcher", summary: "found it", redacted: false, taint: [], ownerOnly: true }] },
    });
    const seen = watch();
    await fire(database, callThenAnswer);
    return seen.find((entry) => entry.principal === "wake");
  }

  test("into a thread whose last session read outside text, with results that read nothing, is tainted", async () => {
    db = openDatabase(":memory:");
    const entry = await wake(db, parentThread(db, JSON.stringify([WEB])));
    expect(entry, "the wake never made a call").toBeDefined();
    expect(kinds(entry)).toContain("history");
  });

  test("into a thread whose mark cannot be read, or was never kept, is tainted", async () => {
    for (const taint of ["not json", "{}", null]) {
      db = openDatabase(":memory:");
      const entry = await wake(db, parentThread(db, taint));
      expect({ taint, kinds: kinds(entry) }).toEqual({ taint, kinds: expect.arrayContaining(["history"]) as unknown as string[] });
      db.close();
      db = undefined;
    }
  });

  test("into a thread whose last session read nothing, or a thread with no session yet, is clean", async () => {
    for (const taint of ["[]", undefined]) {
      db = openDatabase(":memory:");
      const entry = await wake(db, parentThread(db, taint));
      expect(entry, "the wake never made a call").toBeDefined();
      expect({ taint, kinds: kinds(entry) }).toEqual({ taint, kinds: [] });
      db.close();
      db = undefined;
    }
  });
});

describe("a retry", () => {
  test("of a job keeps what the first try read", async () => {
    db = openDatabase(":memory:");
    enqueueJob(db, { kind: "turn", payload: { agentID: "ea", text: "check the inbox", notify: false, inputRole: "system", scheduledBy: "bot", ownerOnly: false, taint: [] } });
    const first = watch(READS_A_PAGE);
    await fire(db, [() => callResponse("load_tools", { names: ["job_list"] }), () => { throw new Error("the model went away"); }]);
    expect(kinds(first[0]), "the first try was not marked; the test is out of step").toContain("web");
    expect(listJobs(db, { includeFinished: true })[0]!.attempts, "the first try did not fail; the test is out of step").toBe(1);
    makeDue(db);
    const second = watch();
    await fire(db, callThenAnswer);
    expect(second.length, "the retry never made a call").toBeGreaterThan(0);
    expect(kinds(second[0]), "the retry started clean after a try that read outside text").not.toEqual([]);
  });

  describe("of a delegated task", () => {
    async function delegate(database: Database): Promise<{ taskID: string }> {
      seedRootTurn(database, "trn_root");
      const run = createRunContext({ db: database, bot: "ea", threadID: "thr_parent", turnID: "trn_parent", rootTurnID: "trn_root", principal: { kind: "owner" }, capabilities: fullCapabilities(database), registry: buildTaskToolRegistry(database) });
      const registry = new ToolRegistry();
      const parent = createThread(database, "ea");
      registerDelegateTaskTool(registry, { db: database, emit: () => undefined, currentAgentID: "ea", channelID: "main", parentTurnID: "trn_parent", parentThreadID: parent.id });
      const tool = registry.get("delegate_task") as unknown as { handler: (args: Record<string, unknown>, ctx: unknown) => Promise<{ taskID: string }> };
      return tool.handler({ toAgentID: "researcher", goal: "Find the delay" }, { threadID: "thr_parent", turnID: "trn_parent", signal: new AbortController().signal, run, chain: { depth: 1, rootAgentID: "ea", currentAgentID: "ea", handoffSummary: null } });
    }

    test("starts with what its first try read, and the task keeps it", async () => {
      db = openDatabase(":memory:");
      const task = await delegate(db);
      const first = watch(READS_A_PAGE);
      await fire(db, [() => callResponse("load_tools", { names: ["job_list"] }), () => { throw new Error("the model went away"); }]);
      expect(kinds(first[0]), "the first try was not marked; the test is out of step").toContain("web");
      const job = listJobs(db, { includeFinished: true }).find((row) => parseJobPayload<{ delegationTaskID?: string }>(row).delegationTaskID);
      expect(job?.attempts, "the first try did not fail; the test is out of step").toBe(1);
      expect(taskTaint(db, task.taskID).map((source) => source.kind)).toContain("web");
      makeDue(db);
      const second = watch();
      await fire(db, callThenAnswer);
      expect(second.length, "the retry never made a call").toBeGreaterThan(0);
      expect(second[0]!.sources.map((source) => source.label), "the retry did not start with what the first try read").toContain(WEB.label);
      expect(taskTaint(db, task.taskID).map((source) => source.label), "the task lost what its first try read").toContain(WEB.label);
    });
  });
});
