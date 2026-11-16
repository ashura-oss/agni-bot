/**
 * S2-INT item 6: a bot job runs as the bot the runner resolved and checked against the pause switch
 * (`ctx.agentID`), never as a second resolution of the payload.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { JobRunner, type JobContext, type JobHandler } from "../src/jobs/runner";
import { registerRoutineJob } from "../src/jobs/routine";
import { registerTurnJob } from "../src/jobs/turn";
import { HealthTracker } from "../src/models/health";
import { Router } from "../src/models/router";
import { enqueueJob } from "../src/stores/jobs";
import { insertRoutine } from "../src/stores/routines";
import { nowISO } from "../src/util/ids";

let db: Database;
afterEach(() => db.close());
beforeEach(() => { db = openDatabase(":memory:"); });

const encoder = new TextEncoder();
const router = (): Router => new Router(
  [{ id: "t", label: "T", baseUrl: "https://t.local/v1", apiKey: "k", model: "m" }], new HealthTracker(),
  (async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "done" } }] })}\n\ndata: [DONE]\n\n`));
      controller.close();
    },
  }), { status: 200 })) as unknown as typeof fetch,
);
const settings = { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 };
const PAST = "2020-01-01T00:00:00.000Z";
const turnAgents = (): string[] => db.query<{ agent_id: string }, []>("SELECT agent_id FROM turns ORDER BY rowid").all().map((row) => row.agent_id);

/** The handlers a job file registers, so a test can hand one a context of its own. */
function handlersOf(register: (runner: JobRunner) => void): Map<string, JobHandler> {
  const handlers = new Map<string, JobHandler>();
  register({ register: (kind: string, handler: JobHandler) => { handlers.set(kind, handler); } } as unknown as JobRunner);
  return handlers;
}

describe("a turn job", () => {
  test("runs as the bot the runner checked, even when the payload spells it in a way a second lookup would miss", async () => {
    const runner = new JobRunner(db, () => undefined, { pollMs: 60_000 });
    registerTurnJob(runner, { db, router: router(), settings, emit: () => undefined });
    // The runner trims the name, finds the researcher and checks its switch; running the payload's own text
    // again would find nobody and fall back to the default bot.
    enqueueJob(db, { kind: "turn", payload: { text: "hello", agentID: " researcher " }, runAt: PAST });
    await runner.tick();
    expect(turnAgents()).toEqual(["researcher"]);
    runner.stop();
  });

  test("takes its bot from the context, not from the payload", async () => {
    const turn = handlersOf((runner) => registerTurnJob(runner, { db, router: router(), settings, emit: () => undefined })).get("turn")!;
    const job = enqueueJob(db, { kind: "turn", payload: { text: "hello", agentID: "ea" }, runAt: PAST });
    const ctx: JobContext = { emit: () => undefined, agentID: "researcher" };
    await turn(job, ctx);
    expect(turnAgents()).toEqual(["researcher"]);
  });

  test("a context with no bot for a bot job is refused, not run as the default bot", async () => {
    const turn = handlersOf((runner) => registerTurnJob(runner, { db, router: router(), settings, emit: () => undefined })).get("turn")!;
    const job = enqueueJob(db, { kind: "turn", payload: { text: "hello", agentID: "researcher" }, runAt: PAST });
    await expect(turn(job, { emit: () => undefined, agentID: null })).rejects.toThrow(/no bot/);
    expect(turnAgents()).toEqual([]);
  });
});

describe("a routine job", () => {
  const routineFor = (agentID: string): string => {
    const job = enqueueJob(db, { kind: "routine", payload: { routineID: "rtn_1" }, runAt: PAST });
    insertRoutine(db, {
      id: "rtn_1", jobID: job.id, agentID, name: "Check", prompt: "p", cron: "0 9 * * *", timezone: "UTC",
      misfire: "run_once", preflight: { kind: "none" }, maxTokens: 1000, maxExecutionMs: 5000, allowedDomains: [], threadID: null,
      lastStateHash: null, stateContext: null, successStreak: 0, failureStreak: 0, createdAt: nowISO(), updatedAt: nowISO(),
    });
    return job.id;
  };

  test("takes its bot from the context, not from a second read of the routine", async () => {
    const handlers = handlersOf((runner) => registerRoutineJob(runner, { db, router: router(), settings, emit: () => undefined }));
    const jobID = routineFor("ea");
    const job = db.query<import("../src/stores/jobs").JobRow, [string]>("SELECT * FROM jobs WHERE id = ?").get(jobID)!;
    // The routine was handed to another bot after the runner checked the first one.
    await handlers.get("routine")!(job, { emit: () => undefined, agentID: "researcher" });
    expect(turnAgents()).toEqual(["researcher"]);
  });

  test("runs as the routine's own bot through the real runner", async () => {
    const runner = new JobRunner(db, () => undefined, { pollMs: 60_000 });
    registerRoutineJob(runner, { db, router: router(), settings, emit: () => undefined });
    routineFor("researcher");
    await runner.tick();
    expect(turnAgents()).toEqual(["researcher"]);
    runner.stop();
  });
});
