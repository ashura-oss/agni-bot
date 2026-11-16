/**
 * S2-09 (the parts in the tools) and the carried item about wake turns: scheduling is allowed
 * when the run read nothing outside, whatever started it; a bot may have only so many jobs of
 * its own; a run may have only so many delegations going at once.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { createJobTools, scheduleJob } from "../src/tools/jobs-tool";
import { ToolRegistry } from "../src/tools/registry";
import { registerDelegateTaskTool } from "../src/tools/delegate-task-tool";
import { buildTaskToolRegistry } from "../src/tools/task-registry";
import { createRunContext } from "../src/policy/context";
import type { PrincipalKind, RunContext, TaintSource } from "../src/policy/types";
import { DEFAULT_MAX_CONCURRENT_DELEGATIONS as MAX_CONCURRENT_DELEGATIONS, DEFAULT_MAX_SELF_SCHEDULED_JOBS as MAX_SELF_SCHEDULED_JOBS } from "../src/agent/guardrails";
import { createThread } from "../src/stores/threads";

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

const WEB: TaintSource = { kind: "web", label: "evil.example/page", tool: "web_fetch", at: "2026-11-16T10:00:00Z" };
const tomorrow = (): string => new Date(Date.now() + 86_400_000).toISOString();

function runOf(database: Database, principal: PrincipalKind, taint: TaintSource[] = [], bot = "ea"): RunContext {
  const registry = buildTaskToolRegistry(database);
  return createRunContext({ db: database, bot, threadID: "thr", turnID: "trn", principal: { kind: principal }, capabilities: registry.list().map((tool) => tool.name), registry, taint });
}
const ctxOf = (run: RunContext) => ({
  threadID: "thr", turnID: "trn", signal: new AbortController().signal, run,
  // What the old flag said: any run the owner did not start itself.
  peerInput: run.principal.kind !== "owner",
  chain: { depth: 1, rootAgentID: run.bot, currentAgentID: run.bot, handoffSummary: null },
});
const schedule = (database: Database) => createJobTools(database)[0]!.handler as unknown as (args: unknown, ctx: unknown) => Promise<{ id?: string; error?: string }>;

describe("job_schedule follows the taint rule", () => {
  test("a wake or a scheduled job that read nothing outside may schedule work", async () => {
    db = openDatabase(":memory:");
    for (const principal of ["owner", "job", "wake"] as const) {
      const result = await schedule(db)({ text: `Check in (${principal})`, at: tomorrow() }, ctxOf(runOf(db, principal)));
      expect({ principal, scheduled: Boolean(result.id) }).toEqual({ principal, scheduled: true });
    }
  });

  test("once the run read outside text it may not, whoever started it", async () => {
    db = openDatabase(":memory:");
    for (const principal of ["owner", "job", "wake"] as const) {
      const result = await schedule(db)({ text: "Check in", at: tomorrow() }, ctxOf(runOf(db, principal, [WEB])));
      expect({ principal, error: result.error }).toEqual({ principal, error: expect.stringContaining("read outside content") });
    }
  });

  test("a bot's brief from another bot or a routine's saved state still may not", async () => {
    db = openDatabase(":memory:");
    for (const principal of ["peer", "routine"] as const) {
      const result = await schedule(db)({ text: "Check in", at: tomorrow() }, ctxOf(runOf(db, principal)));
      expect({ principal, error: result.error }).toEqual({ principal, error: "not done: this turn started from another agent's message" });
    }
  });

  test("a call with no run behind it keeps the old gate", async () => {
    db = openDatabase(":memory:");
    const ctx = { threadID: "thr", turnID: "trn", signal: new AbortController().signal, peerInput: true, chain: { depth: 1, rootAgentID: "ea", currentAgentID: "ea", handoffSummary: null } };
    expect(await schedule(db)({ text: "Check in", at: tomorrow() }, ctx)).toEqual({ error: "not done: this turn started from another agent's message" });
  });
});

describe("a bot's own scheduled jobs are capped", () => {
  test("the eleventh is refused with a way out, and cancelling one makes room", () => {
    db = openDatabase(":memory:");
    const ids: string[] = [];
    for (let i = 0; i < MAX_SELF_SCHEDULED_JOBS; i += 1) ids.push(scheduleJob(db, { text: `Job ${i}`, at: tomorrow() }, "ea").id);
    expect(() => scheduleJob(db!, { text: "One more", at: tomorrow() }, "ea")).toThrow(/10 scheduled jobs/);
    expect(() => scheduleJob(db!, { text: "One more", at: tomorrow() }, "ea")).toThrow(/job_cancel/);
    // Another bot has its own allowance.
    expect(scheduleJob(db, { text: "Mine", at: tomorrow() }, "researcher").id).toBeTruthy();
    db.run("DELETE FROM jobs WHERE id = ?", [ids[0]!]);
    expect(scheduleJob(db, { text: "One more", at: tomorrow() }, "ea").id).toBeTruthy();
  });

  test("a job that has finished does not count", () => {
    db = openDatabase(":memory:");
    for (let i = 0; i < MAX_SELF_SCHEDULED_JOBS; i += 1) scheduleJob(db, { text: `Job ${i}`, at: tomorrow() }, "ea");
    db.run("UPDATE jobs SET state = 'done'");
    expect(scheduleJob(db, { text: "Fresh", at: tomorrow() }, "ea").id).toBeTruthy();
  });
});

describe("delegations running at once are capped", () => {
  test("the fifth is refused until one finishes", async () => {
    db = openDatabase(":memory:");
    const registry = new ToolRegistry();
    const parent = createThread(db, "ea");
    registerDelegateTaskTool(registry, { db, emit: () => undefined, currentAgentID: "ea", channelID: "main", parentTurnID: "trn_p", parentThreadID: parent.id });
    const run = runOf(db, "owner");
    const delegate = (goal: string) => (registry.get("delegate_task") as unknown as { handler: (a: unknown, c: unknown) => Promise<{ taskID?: string }> })
      .handler({ toAgentID: "researcher", goal }, ctxOf(run));
    const started: Array<string | undefined> = [];
    for (let i = 0; i < MAX_CONCURRENT_DELEGATIONS; i += 1) started.push((await delegate(`Goal number ${i}`)).taskID);
    await expect(delegate("Goal number five")).rejects.toThrow(/4 is the most at once/);
    // Another run has its own allowance.
    const other = runOf(db, "owner");
    other.rootTurnID = "trn_other_root";
    const handler = (registry.get("delegate_task") as unknown as { handler: (a: unknown, c: unknown) => Promise<{ taskID?: string }> }).handler;
    expect((await handler({ toAgentID: "researcher", goal: "A different run's goal" }, ctxOf(other))).taskID).toBeTruthy();
    // One finishes: there is room again.
    db.run("UPDATE jobs SET state = 'done' WHERE json_extract(payload, '$.delegationTaskID') = ?", [started[0]!]);
    expect((await delegate("Goal number six")).taskID).toBeTruthy();
  });
});
