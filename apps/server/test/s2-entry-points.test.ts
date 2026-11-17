/**
 * Every way model work starts in the files S2-2 owns goes through the pause
 * check, and each one stops in all three states: paused, the bot turned off,
 * and the state unreadable (which counts as paused). Nothing reaches the model
 * and nothing runs.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../src/db";
import { JobRunner, resolveJobAgent } from "../src/jobs/runner";
import { bindPauseStore, isPauseStoreBound, isRunPaused, setAgentEnabled, setAllPaused, unbindPauseStore } from "../src/policy/pause";
import { setAuditSink } from "../src/policy/audit-sink";
import { startupS2Audit, stopPauseWatcher } from "../src/startup/s2-audit";
import { enqueueJob, getJob } from "../src/stores/jobs";
import { insertRoutine } from "../src/stores/routines";
import { createDelegationTask, getTask } from "../src/stores/tasks";
import { nowISO } from "../src/util/ids";
import { sseResponse, startHarness, type Harness, type TestClient } from "./ws-harness";

type State = "paused" | "bot off" | "unreadable";
const STATES: State[] = ["paused", "bot off", "unreadable"];

function applyState(db: Database, state: State, botID: string): void {
  if (state === "paused") setAllPaused(db, true, { actor: "test" });
  else if (state === "bot off") setAgentEnabled(db, botID, false, { actor: "test" });
  else {
    const dead = openDatabase(":memory:");
    dead.close();
    bindPauseStore(dead, { cacheMs: 0 });
  }
}

beforeEach(() => setAuditSink({ record() {} }));
afterEach(() => {
  stopPauseWatcher();
  unbindPauseStore();
  setAuditSink({ record() {} });
});

// --- the real server starts bound ---------------------------------------------------

describe("a real server start binds the pause state before anything can run", () => {
  test("startupS2Audit binds the store", async () => {
    const db = openDatabase(":memory:");
    expect(isPauseStoreBound()).toBe(false);
    await startupS2Audit({ db, config: {} as never });
    expect(isPauseStoreBound()).toBe(true);
    db.close();
  });

  test("serve() runs the startup hooks before the socket opens and before the job runner starts", () => {
    const source = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf8");
    const hooks = source.indexOf("await runStartupHooks(");
    const server = source.indexOf("running = startServer(");
    const runner = source.indexOf("runner.start()");
    const jobs = source.indexOf("registerAllJobs(runner");
    expect(hooks).toBeGreaterThan(0);
    expect(server).toBeGreaterThan(hooks);
    expect(jobs).toBeGreaterThan(hooks);
    expect(runner).toBeGreaterThan(hooks);
  });

  test("the s2 hook list runs the audit hook", () => {
    expect(readFileSync(join(import.meta.dir, "../src/startup/s2.ts"), "utf8")).toContain("startupS2Audit(ctx)");
  });
});

// --- chat entry points -----------------------------------------------------------------

interface WsEntry {
  name: string;
  bot: string;
  /** Send the frame; resolves with what proves it was stopped. */
  act: (client: TestClient) => Promise<void>;
  /** Frame types that must never arrive. */
  never: string[];
}

const WS_ENTRIES: WsEntry[] = [
  { name: "msg.send to the main assistant", bot: "ea", never: ["turn.start"], act: async (c) => c.send({ type: "msg.send", channelId: "main", text: "hello there" }) },
  { name: "msg.send to a specialist", bot: "researcher", never: ["turn.start"], act: async (c) => c.send({ type: "msg.send", channelId: "dm:researcher", toAgentId: "researcher", text: "hello there" }) },
  { name: "an @mention sent from the main chat", bot: "researcher", never: ["turn.start"], act: async (c) => c.send({ type: "msg.send", channelId: "main", text: "@researcher hello there" }) },
  { name: "a remember: capture", bot: "ea", never: ["turn.start"], act: async (c) => c.send({ type: "msg.send", channelId: "main", text: "remember: the code is 1234" }) },
  {
    name: "session.new (summarises the old block)", bot: "ea", never: ["session.start"],
    act: async (c) => {
      c.send({ type: "conversation.open", conversationID: "", agentID: "ea" });
      const opened = await c.next("conversation.ok");
      c.send({ type: "session.new", conversationID: opened.conversationID });
    },
  },
  { name: "bind.direct (may roll the block over)", bot: "researcher", never: ["bind.direct.ok"], act: async (c) => c.send({ type: "bind.direct", agentID: "researcher" }) },
];

async function wsHarness(): Promise<{ h: Harness; client: TestClient; calls: () => number }> {
  let calls = 0;
  const fetcher = (async () => { calls += 1; return sseResponse("model answer"); }) as unknown as typeof fetch;
  const h = await startHarness({ fetch: fetcher });
  setAuditSink({ record() {} });
  bindPauseStore(h.db, { cacheMs: 0 });
  const client = await h.connect();
  client.send({ type: "agent.rename", agentId: "ea", name: "Agni" });
  await client.next("agent.updated");
  calls = 0;
  return { h, client, calls: () => calls };
}

describe("chat entry points x state", () => {
  for (const entry of WS_ENTRIES) {
    for (const state of STATES) {
      test(`${entry.name} while ${state}: no model call, nothing starts`, async () => {
        const { h, client, calls } = await wsHarness();
        try {
          applyState(h.db, state, entry.bot);
          await entry.act(client);
          await Bun.sleep(250);
          expect(calls()).toBe(0);
          for (const type of entry.never) expect(client.seen().some((frame) => frame.type === type)).toBe(false);
        } finally {
          await h.stop();
        }
      });
    }
  }

  for (const state of STATES) {
    test(`a message queued behind a running turn is not started when that turn ends while ${state}`, async () => {
      let calls = 0;
      let open!: () => void;
      const gate = new Promise<void>((resolve) => { open = resolve; });
      const fetcher = (async () => { calls += 1; await gate; return sseResponse("model answer"); }) as unknown as typeof fetch;
      const h = await startHarness({ fetch: fetcher });
      try {
        bindPauseStore(h.db, { cacheMs: 0 });
        const client = await h.connect();
        client.send({ type: "agent.rename", agentId: "ea", name: "Agni" });
        await client.next("agent.updated");
        client.send({ type: "msg.send", channelId: "main", text: "first, runs" });
        await client.next("turn.start");
        client.send({ type: "msg.send", channelId: "main", text: "second, queued" });
        await Bun.sleep(100);
        // Set directly, so the running turn is not cancelled: it ends by itself and drains the queue.
        applyState(h.db, state, "ea");
        open();
        await client.next("turn.end", { timeoutMs: 5000 });
        await Bun.sleep(300);
        expect(calls).toBe(1);
        expect(client.seen().filter((frame) => frame.type === "turn.start")).toHaveLength(0);
      } finally {
        open();
        await h.stop();
      }
    });

    test(`a message a previous process left queued is not started at boot while ${state}`, async () => {
      let calls = 0;
      const fetcher = (async () => { calls += 1; return sseResponse("model answer"); }) as unknown as typeof fetch;
      const db = openDatabase(":memory:");
      const frame = { type: "msg.send", channelId: "main", text: "left over from before" };
      db.run("INSERT INTO queued_messages (id, frame, text, device_id, device_name, created_at) VALUES ('qmsg_old', ?, ?, 'dev_x', 'phone', ?)", [JSON.stringify(frame), frame.text, nowISO()]);
      db.run("INSERT INTO devices (id, name, token_hash, created_at) VALUES ('dev_x', 'phone', 'hash_x', ?)", [nowISO()]);
      applyState(db, state, "ea");
      if (state !== "unreadable") bindPauseStore(db, { cacheMs: 0 });
      const h = await startHarness({ db, fetch: fetcher });
      try {
        await Bun.sleep(300);
        expect(calls).toBe(0);
      } finally {
        await h.stop();
      }
    });
  }
});

// --- job entry points ----------------------------------------------------------------------

const PAST = "2020-01-01T00:00:00.000Z";

interface JobEntry {
  name: string;
  kind: string;
  bot: string;
  states: State[];
  make: (db: Database) => { payload: Record<string, unknown> };
}

const JOB_ENTRIES: JobEntry[] = [
  { name: "a scheduled turn of the main assistant", kind: "turn", bot: "ea", states: STATES, make: () => ({ payload: { text: "go" } }) },
  { name: "a scheduled turn under the agni alias", kind: "turn", bot: "ea", states: STATES, make: () => ({ payload: { text: "go", agentID: "agni" } }) },
  { name: "a scheduled turn of a specialist", kind: "turn", bot: "researcher", states: STATES, make: () => ({ payload: { text: "go", agentID: "researcher" } }) },
  {
    name: "a delegated task", kind: "turn", bot: "researcher", states: STATES,
    make: (db) => ({ payload: { text: "go", agentID: "researcher", delegationTaskID: createDelegationTask(db, { ownerAgentID: "researcher", brief: { goal: "look it up" } as never }).id } }),
  },
  { name: "a wake of the parent bot", kind: "turn", bot: "ea", states: STATES, make: () => ({ payload: { text: "wake", agentID: "ea", wakeKey: "thr_1", results: [{ taskID: "tsk_1", agentID: "researcher", summary: "done", redacted: false }] } }) },
  {
    name: "a routine", kind: "routine", bot: "researcher", states: STATES,
    make: (db) => {
      // The routine row points at a job row; this one is parked far in the future.
      db.run("INSERT INTO jobs (id, kind, payload, run_at, enabled, created_at, updated_at) VALUES ('job_x', 'routine', '{}', '2099-01-01T00:00:00.000Z', 1, ?, ?)", [nowISO(), nowISO()]);
      insertRoutine(db, {
        id: "rtn_x", jobID: "job_x", agentID: "researcher", name: "Check", prompt: "p", cron: "0 9 * * *", timezone: "UTC",
        misfire: "run_once", preflight: { kind: "none" }, maxTokens: 1000, maxExecutionMs: 1000, allowedDomains: [], threadID: null,
        lastStateHash: null, stateContext: null, successStreak: 0, failureStreak: 0, createdAt: nowISO(), updatedAt: nowISO(),
      });
      return { payload: { routineID: "rtn_x" } };
    },
  },
  // Housekeeping that calls the model waits too, for pause-all and an unreadable state (it belongs to no one bot).
  ...["tagger", "summary.rollup", "rollover.summarize", "memory.consolidate", "memory.embed", "harness.review"].map((kind): JobEntry => (
    { name: `the internal ${kind} job`, kind, bot: "ea", states: ["paused", "unreadable"], make: () => ({ payload: {} }) }
  )),
];

describe("job entry points x state", () => {
  for (const entry of JOB_ENTRIES) {
    for (const state of entry.states) {
      test(`${entry.name} while ${state}: the handler never runs`, async () => {
        const db = openDatabase(":memory:");
        setAuditSink({ record() {} });
        bindPauseStore(db, { cacheMs: 0 });
        const ran: string[] = [];
        const runner = new JobRunner(db, () => undefined, { pollMs: 60_000, maxPerTick: 20, concurrency: 1 });
        runner.register(entry.kind, async (job) => { ran.push(job.id); });
        const { payload } = entry.make(db);
        const job = enqueueJob(db, { kind: entry.kind, payload, runAt: PAST });
        applyState(db, state, entry.bot);
        await runner.tick();
        expect(ran).toEqual([]);
        // Skipped or deferred, never claimed and left running.
        expect(getJob(db, job.id)?.state).not.toBe("running");
        db.close();
      });
    }
  }

  test("an unreadable state requeues the job a little later instead of running it or closing it", async () => {
    const db = openDatabase(":memory:");
    const ran: string[] = [];
    const runner = new JobRunner(db, () => undefined, { pollMs: 60_000, concurrency: 1 });
    runner.register("turn", async (job) => { ran.push(job.id); });
    const job = enqueueJob(db, { kind: "turn", payload: { text: "go" }, runAt: PAST });
    applyState(db, "unreadable", "ea");
    await runner.tick();
    const row = getJob(db, job.id)!;
    expect(ran).toEqual([]);
    expect(row.state).toBe("queued");
    expect(row.attempts).toBe(0);
    const wait = Date.parse(row.run_at) - Date.now();
    expect(wait).toBeGreaterThan(1_000);
    expect(wait).toBeLessThan(120_000);
    unbindPauseStore();
    bindPauseStore(db, { cacheMs: 0 });
    db.run("UPDATE jobs SET run_at = ? WHERE id = ?", [PAST, job.id]);
    await runner.tick();
    expect(ran).toEqual([job.id]);
    db.close();
  });
});

describe("one function decides which bot a job runs as", () => {
  test("the handler is given the same bot the pause gate checked", async () => {
    const db = openDatabase(":memory:");
    bindPauseStore(db, { cacheMs: 0 });
    const seen: Array<string | null> = [];
    const runner = new JobRunner(db, () => undefined, { pollMs: 60_000, concurrency: 1 });
    runner.register("turn", async (_job, ctx) => { seen.push(ctx.agentID); });
    enqueueJob(db, { kind: "turn", payload: { text: "a", agentID: "agni" }, runAt: PAST });
    enqueueJob(db, { kind: "turn", payload: { text: "b" }, runAt: PAST });
    enqueueJob(db, { kind: "turn", payload: { text: "c", agentID: "researcher" }, runAt: PAST });
    await runner.tick();
    expect(seen).toEqual(["ea", "ea", "researcher"]);
    db.close();
  });

  test("a job whose bot does not exist does not run as the default bot: it is recorded", async () => {
    const db = openDatabase(":memory:");
    bindPauseStore(db, { cacheMs: 0 });
    const ran: string[] = [];
    const runner = new JobRunner(db, () => undefined, { pollMs: 60_000, concurrency: 1 });
    runner.register("turn", async (job) => { ran.push(job.id); });
    const job = enqueueJob(db, { kind: "turn", payload: { text: "a", agentID: "ghost" }, runAt: PAST });
    setAgentEnabled(db, "ea", false, { actor: "test" });
    await runner.tick();
    expect(ran).toEqual([]);
    expect(getJob(db, job.id)).toMatchObject({ state: "failed" });
    expect(getJob(db, job.id)!.result).toContain("not run");
    expect(getJob(db, job.id)!.result).toContain("ghost");
    db.close();
  });

  test("a delegation to a bot that does not exist is failed, so its parent is told", async () => {
    const db = openDatabase(":memory:");
    bindPauseStore(db, { cacheMs: 0 });
    const runner = new JobRunner(db, () => undefined, { pollMs: 60_000, concurrency: 1 });
    runner.register("turn", async () => { throw new Error("must not run"); });
    const task = createDelegationTask(db, { ownerAgentID: "researcher", brief: { goal: "look it up" } as never });
    enqueueJob(db, { kind: "turn", payload: { text: "go", agentID: "ghost", delegationTaskID: task.id }, runAt: PAST });
    await runner.tick();
    expect(getTask(db, task.id)).toMatchObject({ delegate_state: "failed" });
    db.close();
  });

  test("a routine that is gone, or whose bot is gone, does not run", async () => {
    const db = openDatabase(":memory:");
    bindPauseStore(db, { cacheMs: 0 });
    const ran: string[] = [];
    const runner = new JobRunner(db, () => undefined, { pollMs: 60_000, concurrency: 1 });
    runner.register("routine", async (job) => { ran.push(job.id); });
    enqueueJob(db, { kind: "routine", payload: { routineID: "rtn_missing" }, runAt: PAST });
    const job = enqueueJob(db, { kind: "routine", payload: { routineID: "rtn_orphan" }, runAt: PAST });
    insertRoutine(db, {
      id: "rtn_orphan", jobID: job.id, agentID: "ghost", name: "Check", prompt: "p", cron: "0 9 * * *", timezone: "UTC",
      misfire: "run_once", preflight: { kind: "none" }, maxTokens: 1000, maxExecutionMs: 1000, allowedDomains: [], threadID: null,
      lastStateHash: null, stateContext: null, successStreak: 0, failureStreak: 0, createdAt: nowISO(), updatedAt: nowISO(),
    });
    await runner.tick();
    expect(ran).toEqual([]);
    db.close();
  });

  test("resolveJobAgent canonicalises a routine's bot and leaves housekeeping with no bot", () => {
    const db = openDatabase(":memory:");
    const routineJob = enqueueJob(db, { kind: "routine", payload: { routineID: "rtn_a" } });
    insertRoutine(db, {
      id: "rtn_a", jobID: routineJob.id, agentID: "agni", name: "Check", prompt: "p", cron: "0 9 * * *", timezone: "UTC",
      misfire: "run_once", preflight: { kind: "none" }, maxTokens: 1000, maxExecutionMs: 1000, allowedDomains: [], threadID: null,
      lastStateHash: null, stateContext: null, successStreak: 0, failureStreak: 0, createdAt: nowISO(), updatedAt: nowISO(),
    });
    expect(resolveJobAgent(db, getJob(db, routineJob.id)!)).toEqual({ ok: true, agentID: "ea" });
    const tag = enqueueJob(db, { kind: "tagger", payload: {} });
    expect(resolveJobAgent(db, getJob(db, tag.id)!)).toEqual({ ok: true, agentID: null });
    expect(isRunPaused({ agentID: "ea" }).paused).toBe(false);
    db.close();
  });
});
