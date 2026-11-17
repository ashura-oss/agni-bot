/**
 * Sprint 2, fix round L (G): a job keeps the web limits of the routine that asked for it.
 *
 * A routine runs with a list of domains its web tools may reach (empty: none). When the owner approves a repeating job from such a
 * run's card, the job was made with no list, and every fire could reach any site. The run's list now goes with the job, and on to
 * what the job delegates or hands off. A list that cannot be read refuses every domain.
 */
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db";
import { JobRunner } from "../src/jobs/runner";
import { registerTurnJob } from "../src/jobs/turn";
import { HealthTracker } from "../src/models/health";
import type { ProviderConfig } from "../src/models/providers";
import { Router } from "../src/models/router";
import { packCarried, readCarried } from "../src/policy/carry";
import { createRunContext } from "../src/policy/context";
import { decide } from "../src/policy/engine";
import { resetPolicyHooks, setPolicyHooks } from "../src/policy/hooks";
import type { RunContext } from "../src/policy/types";
import { resetS2Startup } from "../src/startup/s2";
import { enqueueJob, listJobs, parseJobPayload } from "../src/stores/jobs";
import { createThread } from "../src/stores/threads";
import { registerDelegateTaskTool } from "../src/tools/delegate-task-tool";
import { createJobTools } from "../src/tools/jobs-tool";
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

const future = (): string => new Date(Date.now() + 3_600_000).toISOString();
/** A run of the routine kind, with the list of domains it was given (absent: a run that has none). */
function routineRun(database: Database, allowedDomains: string[] | undefined): RunContext {
  seedRootTurn(database, "trn_root");
  return createRunContext({
    db: database, bot: "ea", threadID: "thr", turnID: "trn", rootTurnID: "trn_root", principal: { kind: "routine" },
    capabilities: fullCapabilities(database), registry: buildTaskToolRegistry(database), ...(allowedDomains ? { allowedDomains } : {}),
  });
}
/** The owner approved this repeating job from the run's card. */
async function approvedJob(database: Database, run: RunContext): Promise<Record<string, unknown>> {
  const handler = createJobTools(database)[0]!.handler as unknown as (args: unknown, ctx: unknown) => Promise<{ id?: string; error?: string }>;
  const made = await handler({ text: "Check the offers", everyMinutes: 30 }, { threadID: "thr", turnID: "trn", signal: new AbortController().signal, run, ownerApproved: true, chain: { depth: 1, rootAgentID: "ea", currentAgentID: "ea", handoffSummary: null } });
  expect(made.error, "the job was not made").toBeUndefined();
  return parseJobPayload<Record<string, unknown>>(listJobs(database).find((job) => job.id === made.id)!);
}

/** Fire a payload once; the domain list the fired run holds, and the run. */
async function fired(payload: Record<string, unknown>): Promise<{ allowed: string[] | undefined; run: RunContext }> {
  const database = db!;
  let seen: RunContext | undefined;
  setPolicyHooks({ isRunPaused: (run) => { seen ??= run; return null; } });
  enqueueJob(database, { kind: "turn", payload: { agentID: "ea", text: "do it", notify: false, inputRole: "system", scheduledBy: "bot", taint: [], ...payload } });
  const runner = new JobRunner(database, () => undefined, { maxPerTick: 5 });
  registerTurnJob(runner, { db: database, settings, emit: () => undefined, router: routerOf([() => callResponse("load_tools", { names: ["job_list"] }), () => textResponse("Noted.")]) });
  await runner.tick();
  expect(seen, "the fire never made a call").toBeDefined();
  return { allowed: seen!.services.allowedDomains, run: seen! };
}

describe("a repeating job the owner approved from a run that had a domain list", () => {
  test("is made with that list", async () => {
    db = openDatabase(":memory:");
    expect((await approvedJob(db, routineRun(db, ["example.com", "docs.example.org"]))).allowedDomains).toEqual(["example.com", "docs.example.org"]);
  });

  test("is made with the empty list too: a routine with no web egress has none", async () => {
    db = openDatabase(":memory:");
    expect((await approvedJob(db, routineRun(db, []))).allowedDomains).toEqual([]);
  });

  test("is made with no list when the run had none", async () => {
    db = openDatabase(":memory:");
    expect(Object.hasOwn(await approvedJob(db, routineRun(db, undefined)), "allowedDomains")).toBe(false);
  });
});

describe("a job's fire", () => {
  test("holds the list the job was made with, and the web tools stay inside it", async () => {
    db = openDatabase(":memory:");
    const { allowed, run } = await fired({ allowedDomains: ["example.com"] });
    expect(allowed).toEqual(["example.com"]);
    expect(decide(run, { tool: "web_fetch", args: { url: "https://elsewhere.test/page" }, callID: "call_1" })).toMatchObject({ action: "refuse", code: "domain_not_allowed" });
  });

  test("with the empty list may not search the web at all", async () => {
    db = openDatabase(":memory:");
    const { allowed, run } = await fired({ allowedDomains: [] });
    expect(allowed).toEqual([]);
    expect(decide(run, { tool: "web_search", args: { query: "offers" }, callID: "call_1" })).toMatchObject({ action: "refuse", code: "domain_not_allowed" });
  });

  test("with a list that cannot be read refuses every domain", async () => {
    for (const bad of ["example.com", [1, 2], { 0: "example.com" }, null]) {
      db = openDatabase(":memory:");
      const { allowed } = await fired({ allowedDomains: bad });
      expect({ bad, allowed }).toEqual({ bad, allowed: [] });
      db.close();
      db = undefined;
    }
  });

  test("with no list has none, as before", async () => {
    db = openDatabase(":memory:");
    expect((await fired({})).allowed).toBeUndefined();
  });
});

describe("the list goes on to what the run delegates or hands off", () => {
  test("a delegated task's job carries it", async () => {
    db = openDatabase(":memory:");
    const registry = new ToolRegistry();
    const parent = createThread(db, "ea");
    registerDelegateTaskTool(registry, { db, emit: () => undefined, currentAgentID: "ea", channelID: "main", parentTurnID: "trn", parentThreadID: parent.id });
    const tool = registry.get("delegate_task") as unknown as { handler: (args: Record<string, unknown>, ctx: unknown) => Promise<{ jobID: string }> };
    const made = await tool.handler({ toAgentID: "researcher", goal: "Find the offers" }, { threadID: "thr", turnID: "trn", signal: new AbortController().signal, run: routineRun(db, ["example.com"]), chain: { depth: 1, rootAgentID: "ea", currentAgentID: "ea", handoffSummary: null } });
    expect(parseJobPayload<Record<string, unknown>>(listJobs(db).find((job) => job.id === made.jobID)!).allowedDomains).toEqual(["example.com"]);
  });

  test("a handoff's child holds it, and so does what a wake and a resumed task read back from the brief", () => {
    db = openDatabase(":memory:");
    const run = routineRun(db, ["example.com"]);
    for (const link of ["delegate", "handoff", "schedule-once", "schedule-recurring"] as const) expect({ link, domains: packCarried(run, link).allowedDomains }).toEqual({ link, domains: ["example.com"] });
    const brief = readCarried({ allowedDomains: ["example.com"] });
    for (const link of ["wake", "resume"] as const) expect({ link, domains: packCarried(brief, link).allowedDomains }).toEqual({ link, domains: ["example.com"] });
    expect(packCarried(routineRun(db, undefined), "delegate").allowedDomains).toBeUndefined();
  });
});
