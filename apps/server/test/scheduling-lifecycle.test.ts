/**
 * Sprint 1, T5: scheduling, background jobs and the delegated-task lifecycle.
 *
 * S1-12 cancel stops a running child turn, S1-13 a job that needed approval
 * is never "done", S1-21 a result the parent already read is not announced
 * again, S1-22 wake turns keep the peer-input gate, S1-23 a scheduled reply
 * reaches the owner's chat, S1-24 "run now" never starts a second copy,
 * S1-38 monthly repeats keep their day of the month.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { ServerFrameBody } from "@agni/protocol";
import { openDatabase } from "../src/db";
import { HealthTracker } from "../src/models/health";
import type { ProviderConfig } from "../src/models/providers";
import { Router } from "../src/models/router";
import { ToolRegistry } from "../src/tools/registry";
import { registerDelegateTaskTool } from "../src/tools/delegate-task-tool";
import { createJobTools, scheduleJob } from "../src/tools/jobs-tool";
import { JobRunner } from "../src/jobs/runner";
import { parentAlreadyRead, registerTurnJob } from "../src/jobs/turn";
import { registerTaskReminderJob, scheduleTaskReminder } from "../src/jobs/task-reminders";
import { resolveApprovalWaiter } from "../src/agent/approval-broker";
import { cancelThreadTurn, fitToolResult } from "../src/agent/task-loop";
import { cancelDelegation, createTask, getTask, setDelegationState } from "../src/stores/tasks";
import { claimDueJob, enqueueJob, getJob, listJobs, parseJobPayload, wakeJob } from "../src/stores/jobs";
import { createThread, createTurn } from "../src/stores/threads";

const provider: ProviderConfig = {
  id: "test", label: "Test", baseUrl: "https://test.local/v1", apiKey: "test", model: "mock",
};

type Scripted = { text: string } | { tool: string; args: Record<string, unknown> } | "hang";

function sse(events: unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(body)); controller.close(); },
  }), { status: 200 });
}

/** A router that plays a script, one entry per model call, and counts the calls. */
function scriptedRouter(script: Scripted[]): { router: Router; calls: () => number } {
  let index = 0;
  const fetchStub = ((_url: unknown, init?: RequestInit) => {
    const step = script[Math.min(index, script.length - 1)]!;
    index += 1;
    if (step === "hang") {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }
    if ("text" in step) return Promise.resolve(sse([{ choices: [{ delta: { content: step.text } }] }]));
    return Promise.resolve(sse([{ choices: [{ delta: { tool_calls: [{
      index: 0, id: `call-${index}`, type: "function", function: { name: step.tool, arguments: JSON.stringify(step.args) },
    }] } }] }]));
  }) as unknown as typeof fetch;
  return { router: new Router([provider], new HealthTracker(), fetchStub), calls: () => index };
}

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

const settings = { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 };

/** Queue a delegation the way the model would. */
async function delegate(database: Database, parentThreadID: string, goal = "Find the delay"): Promise<{ taskID: string; jobID: string }> {
  const registry = new ToolRegistry();
  registerDelegateTaskTool(registry, {
    db: database, emit: () => undefined, currentAgentID: "ea", channelID: "main",
    parentTurnID: "trn_parent", parentThreadID,
  });
  const tool = registry.get("delegate_task") as unknown as {
    handler: (args: Record<string, unknown>, ctx: { threadID: string; turnID: string; signal: AbortSignal }) => Promise<unknown>;
  };
  return (await tool.handler(
    { toAgentID: "researcher", goal },
    { threadID: parentThreadID, turnID: "trn_parent", signal: new AbortController().signal },
  )) as { taskID: string; jobID: string };
}

function wakeRows(database: Database) {
  return listJobs(database, { includeFinished: true, limit: 100 })
    .filter((job) => job.kind === "turn" && typeof parseJobPayload<{ wakeKey?: string }>(job).wakeKey === "string");
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("S1-12: cancelling a running delegated task stops it", () => {
  test("the child turn is aborted, the task stays cancelled, and nothing is announced", async () => {
    db = openDatabase(":memory:");
    const parent = createThread(db, "ea");
    const queued = await delegate(db, parent.id);
    const frames: ServerFrameBody[] = [];
    const script = scriptedRouter(["hang"]);
    const runner = new JobRunner(db, (frame) => frames.push(frame), { maxPerTick: 5 });
    registerTurnJob(runner, { db, router: script.router, settings, emit: (frame) => frames.push(frame) });

    const running = runner.tick();
    await until(() => script.calls() > 0);
    expect(getTask(db, queued.taskID)?.delegate_state).toBe("running");

    cancelDelegation(db, queued.taskID);
    await running;

    const task = getTask(db, queued.taskID)!;
    expect(task.delegate_state).toBe("failed");
    expect(task.result).toBe("cancelled by user");
    // No result for the parent, and no notification that something finished.
    expect(wakeRows(db)).toHaveLength(0);
    expect(frames.filter((frame) => frame.type === "notify")).toHaveLength(0);
    // The child turn really ended; it was not left running to finish later.
    expect(frames.some((frame) => frame.type === "turn.end")).toBe(true);
    // The job is not retried.
    expect(getJob(db, queued.jobID)?.state).not.toBe("queued");
  });
});

describe("S1-24: run now on a running job", () => {
  test("a running job is left alone and the caller is told", () => {
    db = openDatabase(":memory:");
    const job = enqueueJob(db, { kind: "routine", payload: { routineID: "r1" } });
    expect(claimDueJob(db)?.id).toBe(job.id);

    expect(wakeJob(db, job.id)).toBe("running");
    // Still the one running copy, and nothing is queued for a second one.
    expect(getJob(db, job.id)?.state).toBe("running");
    expect(claimDueJob(db)).toBeNull();
  });

  test("an idle job is made due, and a missing one is reported", () => {
    db = openDatabase(":memory:");
    const job = enqueueJob(db, { kind: "routine", payload: {}, runAt: "2999-01-01T00:00:00.000Z" });
    expect(wakeJob(db, job.id)).toBe("woken");
    expect(claimDueJob(db)?.id).toBe(job.id);
    expect(wakeJob(db, "job_missing")).toBe("not_found");
  });
});

describe("S1-38: monthly repeats keep the original day", () => {
  test("Jan 31 goes Feb 28, Mar 31, Apr 30 and May 31 in order", async () => {
    db = openDatabase(":memory:");
    const database = db;
    const runner = new JobRunner(database, () => undefined);
    registerTaskReminderJob(runner, { db: database, emit: () => undefined });
    const start = new Date(2027, 0, 31, 10, 0, 0);
    const task = createTask(database, { title: "Pay rent", reminderAt: start.toISOString(), repeatRule: "monthly" });
    scheduleTaskReminder(database, task.id);

    const seen: Array<[number, number]> = [];
    for (let i = 0; i < 4; i += 1) {
      database.run("UPDATE jobs SET run_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", [getTask(database, task.id)!.reminder_job_id]);
      await runner.tick();
      const next = new Date(getTask(database, task.id)!.reminder_at!);
      seen.push([next.getMonth() + 1, next.getDate()]);
    }
    expect(seen).toEqual([[2, 28], [3, 31], [4, 30], [5, 31]]);
  });

  test("a leap February lands on the 29th and March returns to the 31st", async () => {
    db = openDatabase(":memory:");
    const database = db;
    const runner = new JobRunner(database, () => undefined);
    registerTaskReminderJob(runner, { db: database, emit: () => undefined });
    const task = createTask(database, { title: "Leap", reminderAt: new Date(2028, 0, 31, 9, 30, 0).toISOString(), repeatRule: "monthly" });
    scheduleTaskReminder(database, task.id);

    const seen: Array<[number, number]> = [];
    for (let i = 0; i < 2; i += 1) {
      database.run("UPDATE jobs SET run_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", [getTask(database, task.id)!.reminder_job_id]);
      await runner.tick();
      const next = new Date(getTask(database, task.id)!.reminder_at!);
      seen.push([next.getMonth() + 1, next.getDate()]);
    }
    expect(seen).toEqual([[2, 29], [3, 31]]);
  });

  test("a due date repeats with its own original day", async () => {
    db = openDatabase(":memory:");
    const database = db;
    const runner = new JobRunner(database, () => undefined);
    registerTaskReminderJob(runner, { db: database, emit: () => undefined });
    const task = createTask(database, {
      title: "Rent", reminderAt: new Date(2027, 0, 30, 9, 0, 0).toISOString(),
      dueAt: new Date(2027, 0, 31, 18, 0, 0).toISOString(), repeatRule: "monthly",
    });
    scheduleTaskReminder(database, task.id);
    for (let i = 0; i < 2; i += 1) {
      database.run("UPDATE jobs SET run_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", [getTask(database, task.id)!.reminder_job_id]);
      await runner.tick();
    }
    const after = getTask(database, task.id)!;
    expect(new Date(after.due_at!).getDate()).toBe(31);
    expect(new Date(after.reminder_at!).getDate()).toBe(30);
  });
});

describe("S1-21: a result the parent already read is not announced again", () => {
  test("the wake is skipped when delegate_wait already returned the finished task", async () => {
    db = openDatabase(":memory:");
    const parent = createThread(db, "ea");
    const queued = await delegate(db, parent.id);
    const child = scriptedRouter([{ text: "Found it: the invoice was misfiled." }, { text: "Told the owner AGAIN." }]);
    // One job per tick: the child runs first, and the parent reads the result before the wake does.
    const runner = new JobRunner(db, () => undefined, { maxPerTick: 1 });
    registerTurnJob(runner, { db, router: child.router, settings, emit: () => undefined });

    await runner.tick();
    expect(wakeRows(db)).toHaveLength(1);
    const modelCallsBeforeWake = child.calls();

    // The parent's own turn read the result through delegate_wait.
    createTurn(db, { id: "trn_parent", threadID: parent.id, agentID: "ea" });
    db.run(
      "INSERT INTO tool_calls (id, thread_id, turn_id, call_id, tool_name, args, result, ok, error, created_at) VALUES ('tcl_1', ?, 'trn_parent', 'call_w', 'delegate_wait', ?, ?, 1, NULL, ?)",
      [parent.id, JSON.stringify({ taskID: queued.taskID }), JSON.stringify({ taskID: queued.taskID, state: "done", result: "Found it", terminal: true }), new Date().toISOString()],
    );

    await runner.tick();
    expect(child.calls()).toBe(modelCallsBeforeWake);
    const wake = wakeRows(db)[0]!;
    expect(wake.state).toBe("done");
    expect(wake.result).toMatch(/already/i);
  });

  test("an unread result still wakes the parent", async () => {
    db = openDatabase(":memory:");
    const parent = createThread(db, "ea");
    await delegate(db, parent.id);
    const script = scriptedRouter([{ text: "Found it." }, { text: "The research finished: it was misfiled." }]);
    const runner = new JobRunner(db, () => undefined, { maxPerTick: 5 });
    registerTurnJob(runner, { db, router: script.router, settings, emit: () => undefined });
    await runner.tick();
    await runner.tick();
    expect(script.calls()).toBe(2);
  });

  test("parentAlreadyRead reads the task from the tool call's own arguments and result", async () => {
    db = openDatabase(":memory:");
    const database = db;
    const parent = createThread(database, "ea");
    createTurn(database, { id: "trn_parent", threadID: parent.id, agentID: "ea" });
    const waited = await delegate(database, parent.id, "Wait for me");
    const polled = await delegate(database, parent.id, "Poll me");
    const unrelated = await delegate(database, parent.id, "Not read");
    setDelegationState(database, waited.taskID, "done", "Found it");
    setDelegationState(database, polled.taskID, "done", "Found it too");

    // The real tools, run the way the loop runs them, stored the way the loop stores them.
    const registry = new ToolRegistry();
    registerDelegateTaskTool(registry, {
      db: database, emit: () => undefined, currentAgentID: "ea", channelID: "main",
      parentTurnID: "trn_parent", parentThreadID: parent.id,
    });
    const ctx = { threadID: parent.id, turnID: "trn_parent", signal: new AbortController().signal };
    let n = 0;
    for (const [name, taskID] of [["delegate_wait", waited.taskID], ["task_status", polled.taskID]] as const) {
      const tool = registry.get(name) as unknown as { handler: (args: Record<string, unknown>, ctx: unknown) => Promise<unknown> };
      const args = { taskID, ...(name === "delegate_wait" ? { timeoutMs: 1000 } : {}) };
      const result = await tool.handler(args, ctx);
      n += 1;
      database.run(
        "INSERT INTO tool_calls (id, thread_id, turn_id, call_id, tool_name, args, result, ok, error, created_at) VALUES (?, ?, 'trn_parent', ?, ?, ?, ?, 1, NULL, ?)",
        [`tcl_${n}`, parent.id, `call_${n}`, name, JSON.stringify(args), fitToolResult(result), new Date().toISOString()],
      );
    }

    expect(parentAlreadyRead(database, parent.id, waited.taskID)).toBe(true);
    expect(parentAlreadyRead(database, parent.id, polled.taskID)).toBe(true);
    expect(parentAlreadyRead(database, parent.id, unrelated.taskID)).toBe(false);
    // Another thread's reading does not count.
    expect(parentAlreadyRead(database, createThread(database, "ea").id, waited.taskID)).toBe(false);
  });

  test("a wait that timed out before the result existed does not count as read", async () => {
    db = openDatabase(":memory:");
    const database = db;
    const parent = createThread(database, "ea");
    createTurn(database, { id: "trn_parent", threadID: parent.id, agentID: "ea" });
    const queued = await delegate(database, parent.id);
    database.run(
      "INSERT INTO tool_calls (id, thread_id, turn_id, call_id, tool_name, args, result, ok, error, created_at) VALUES ('tcl_x', ?, 'trn_parent', 'call_x', 'delegate_wait', ?, ?, 1, NULL, ?)",
      [parent.id, JSON.stringify({ taskID: queued.taskID }), JSON.stringify({ taskID: queued.taskID, state: "running", terminal: false, waitTimedOut: true }), new Date().toISOString()],
    );
    expect(parentAlreadyRead(database, parent.id, queued.taskID)).toBe(false);
  });

  test("a finished delegation closes the task", async () => {
    db = openDatabase(":memory:");
    const parent = createThread(db, "ea");
    const queued = await delegate(db, parent.id);
    const script = scriptedRouter([{ text: "All done." }]);
    const runner = new JobRunner(db, () => undefined, { maxPerTick: 1 });
    registerTurnJob(runner, { db, router: script.router, settings, emit: () => undefined });
    await runner.tick();

    const task = getTask(db, queued.taskID)!;
    expect(task.delegate_state).toBe("done");
    expect(task.status).toBe("done");
  });

  test("a failed delegation does not claim the task is done", () => {
    db = openDatabase(":memory:");
    const parent = createThread(db, "ea");
    return delegate(db, parent.id).then((queued) => {
      setDelegationState(db!, queued.taskID, "failed", "boom");
      expect(getTask(db!, queued.taskID)?.status).toBe("open");
    });
  });
});

describe("S1-13: a background job that needed approval is never reported done", () => {
  // mail_send is a deferred tool for the assistant: the model loads it first, then calls it.
  const load = { tool: "load_tools", args: { names: ["mail_send"] } } as const;
  const mail = { tool: "mail_send", args: { account: "owner@example.com", to: "a@example.com", subject: "Hi", body: "Hello" } } as const;
  const job = (database: Database) => enqueueJob(database, { kind: "turn", payload: { text: "Email the owner's report.", agentID: "ea", inputRole: "system" } });

  /** What the owner's client does: record the decision on the card, then answer the waiting turn. */
  function ownerDecides(database: Database, frame: ServerFrameBody): void {
    if (frame.type !== "approval.request") return;
    setTimeout(() => {
      database.run("UPDATE approvals SET status = 'decided', decision = 'reject' WHERE id = ?", [frame.requestID]);
      resolveApprovalWaiter(frame.requestID, "reject");
    }, 5);
  }

  test("a denied approval ends the job as not done, even when the model carries on", async () => {
    db = openDatabase(":memory:");
    const database = db;
    const frames: ServerFrameBody[] = [];
    const script = scriptedRouter([load, mail, { text: "Done, the email is on its way." }]);
    const emit = (frame: ServerFrameBody): void => { frames.push(frame); ownerDecides(database, frame); };
    const runner = new JobRunner(database, emit, { retryDelayMs: 1 });
    registerTurnJob(runner, { db: database, router: script.router, settings, emit });
    const queued = job(database);

    await runner.tick();

    const row = getJob(database, queued.id)!;
    expect(row.state).toBe("failed");
    expect(row.result).toMatch(/not done/i);
    expect(row.result).toMatch(/denied/i);
    expect(row.result).toContain("mail_send");
    expect(frames.some((frame) => frame.type === "notify" && /Done, the email/.test(frame.body))).toBe(false);
  });

  test("an approval that ends with no decision fails the job once, naming the approval, without retries", async () => {
    db = openDatabase(":memory:");
    const database = db;
    const script = scriptedRouter([load, mail, { text: "unreachable" }]);
    // Nobody answers: the turn is stopped while the card is open. This does not depend on how
    // long the daemon waits for an owner, only on the turn ending with the card undecided.
    const emit = (frame: ServerFrameBody): void => {
      if (frame.type !== "approval.request") return;
      setTimeout(() => {
        const threadID = database.query<{ thread_id: string }, [string]>("SELECT thread_id FROM approvals WHERE id = ?").get(frame.requestID)!.thread_id;
        cancelThreadTurn(threadID);
      }, 20);
    };
    const runner = new JobRunner(database, emit, { retryDelayMs: 1 });
    registerTurnJob(runner, { db: database, router: script.router, settings, emit });
    const queued = job(database);

    await runner.tick();

    const row = getJob(database, queued.id)!;
    expect(row.state).toBe("failed");
    expect(row.attempts).toBe(1);
    expect(row.result).toMatch(/not done/i);
    expect(row.result).toMatch(/not given/i);
    expect(row.result).toContain("mail_send");
  });
});

describe("S1-13: an approval that expired is blocked too", () => {
  test("a gated call recorded as approval_expired ends the job as not done", async () => {
    db = openDatabase(":memory:");
    const database = db;
    const thread = createThread(database, "ea");
    // What the turn loop leaves when the owner never answered within its wait ceiling.
    createTurn(database, { id: "trn_gate", threadID: thread.id, agentID: "ea" });
    const later = new Date(Date.now() + 60_000).toISOString();
    database.run(
      "INSERT INTO approvals (id, thread_id, turn_id, action, preview, status, decision, call_id, tool_name, created_at) VALUES ('apr_x', ?, 'trn_gate', 'send', 'send', 'expired', NULL, 'call_x', 'mail_send', ?)",
      [thread.id, later],
    );
    database.run(
      "INSERT INTO tool_calls (id, thread_id, turn_id, call_id, tool_name, args, result, ok, error, created_at) VALUES ('tcl_x', ?, 'trn_gate', 'call_x', 'mail_send', '{}', ?, 0, 'approval_expired', ?)",
      [thread.id, JSON.stringify({ error: "not approved" }), later],
    );
    const script = scriptedRouter([{ text: "Done, the email is on its way." }]);
    const runner = new JobRunner(database, () => undefined, { retryDelayMs: 1 });
    registerTurnJob(runner, { db: database, router: script.router, settings, emit: () => undefined });
    const queued = enqueueJob(database, { kind: "turn", payload: { text: "Email the report.", agentID: "ea", threadID: thread.id, inputRole: "system" } });

    await runner.tick();

    const row = getJob(database, queued.id)!;
    expect(row.state).toBe("failed");
    expect(row.result).toMatch(/not done/i);
    expect(row.result).toMatch(/expired/i);
    expect(row.result).toContain("mail_send");
  });
});

describe("S1-23: a scheduled reply reaches the owner's chat", () => {
  test("the reminder is posted to the agent's channel as the agent's message", async () => {
    db = openDatabase(":memory:");
    const frames: ServerFrameBody[] = [];
    const script = scriptedRouter([{ text: "Reminder: call the dentist." }]);
    const runner = new JobRunner(db, (frame) => frames.push(frame));
    registerTurnJob(runner, { db, router: script.router, settings, emit: (frame) => frames.push(frame) });
    scheduleJob(db, {
      text: "Remind the owner: call the dentist. Post it as a short reminder message in the chat.",
      at: new Date(Date.now() - 1000).toISOString(),
    }, "ea");

    await runner.tick();

    const rows = db.query<{ from_type: string; from_id: string; text: string }, []>(
      "SELECT from_type, from_id, text FROM channel_messages WHERE channel_id = 'main'",
    ).all();
    expect(rows.some((row) => row.from_type === "agent" && row.from_id === "ea" && row.text === "Reminder: call the dentist.")).toBe(true);
    // And the live chat is told, so it never shows an empty "no reply" bubble.
    expect(frames.some((frame) => frame.type === "msg.new" && frame.channelId === "main" && frame.text === "Reminder: call the dentist.")).toBe(true);
    // The internal instruction is never posted as a chat message.
    expect(rows.some((row) => row.text.includes("Post it as a short reminder"))).toBe(false);
  });

  test("another bot's reminder goes to that bot's own channel", async () => {
    db = openDatabase(":memory:");
    const script = scriptedRouter([{ text: "Time to stretch." }]);
    const runner = new JobRunner(db, () => undefined);
    registerTurnJob(runner, { db, router: script.router, settings, emit: () => undefined });
    scheduleJob(db, { text: "Remind the owner to stretch.", at: new Date(Date.now() - 1000).toISOString() }, "researcher");

    await runner.tick();

    const rows = db.query<{ text: string }, []>("SELECT text FROM channel_messages WHERE channel_id = 'dm:researcher'").all();
    expect(rows.map((row) => row.text)).toEqual(["Time to stretch."]);
  });
});

describe("S1-22: wake turns", () => {
  test("a wake turn keeps the peer-input gate on job_schedule (a deliberate refusal)", async () => {
    db = openDatabase(":memory:");
    const [schedule] = createJobTools(db);
    const handler = schedule!.handler as unknown as (args: unknown, ctx: unknown) => Promise<unknown>;
    const ctx = {
      threadID: "thr", turnID: "trn", signal: new AbortController().signal, peerInput: true,
      chain: { depth: 1, rootAgentID: "ea", currentAgentID: "ea" },
    };
    const refused = await handler({ text: "Check in tomorrow", at: new Date(Date.now() + 60_000).toISOString() }, ctx);
    expect(refused).toEqual({ error: "not done: this turn started from another agent's message" });
    // The same call from the owner's own turn is accepted: the caller check is not the blocker.
    const accepted = (await handler({ text: "Check in tomorrow", at: new Date(Date.now() + 60_000).toISOString() }, { ...ctx, peerInput: false })) as { id?: string };
    expect(accepted.id).toBeTruthy();
  });
});
