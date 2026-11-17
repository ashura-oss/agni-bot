/**
 * Sprint 2, fix round L (F): a bot's job made before taint was recorded does not run clean.
 *
 * A job a bot scheduled before Sprint 2 has no `taint` field. It used to read that as "read nothing" and ran as a clean job with all of the
 * bot's tools, though the text was written by a bot that may have read anything. A payload with no record of what its sender read now reads
 * as one unknown source, unless it is provably the owner's (`ownerOnly`). A job with no `capabilities` field is not narrowed (its bot's own
 * tools), but it is tainted.
 */
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db";
import { JobRunner } from "../src/jobs/runner";
import { registerTurnJob } from "../src/jobs/turn";
import { HealthTracker } from "../src/models/health";
import type { ProviderConfig } from "../src/models/providers";
import { Router } from "../src/models/router";
import { readCarried } from "../src/policy/carry";
import { resetPolicyHooks, setPolicyHooks } from "../src/policy/hooks";
import { resetS2Startup } from "../src/startup/s2";
import { enqueueJob } from "../src/stores/jobs";

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

interface Seen { principal: string; kinds: string[]; tools: Set<string> }
/** The first run that makes a call, as the engine sees it. */
async function fireOf(payload: Record<string, unknown>): Promise<Seen> {
  db = openDatabase(":memory:");
  const seen: Seen[] = [];
  setPolicyHooks({ isRunPaused: (run) => { seen.push({ principal: run.principal.kind, kinds: run.taint.sources.map((source) => source.kind), tools: new Set(run.effectiveCapabilities) }); return null; } });
  enqueueJob(db, { kind: "turn", payload: { agentID: "ea", text: "do it", notify: false, ...payload } });
  const runner = new JobRunner(db, () => undefined, { maxPerTick: 5 });
  registerTurnJob(runner, { db, settings, emit: () => undefined, router: routerOf([() => callResponse("load_tools", { names: ["job_list"] }), () => textResponse("Noted.")]) });
  await runner.tick();
  expect(seen.length, "the fire never made a call").toBeGreaterThan(0);
  return seen[0]!;
}

describe("a bot's job from before taint was recorded", () => {
  test("is tainted as one unknown source, and keeps its bot's own tools", async () => {
    const run = await fireOf({ inputRole: "system", scheduledBy: "bot" });
    expect(run.kinds).toEqual(["unknown"]);
    expect(run.tools.has("bash"), "a job with no tool list was cut down; it is not narrowed, only tainted").toBe(true);
  });

  test("is tainted too when it says nothing about who made it", async () => {
    expect((await fireOf({ inputRole: "system" })).kinds).toEqual(["unknown"]);
    db?.close();
    db = undefined;
    expect((await fireOf({})).kinds, "a job nothing proves to be the owner's was read as clean").toEqual(["unknown"]);
  });

  test("whose record says it read nothing is clean, as a job a clean run scheduled is", async () => {
    const run = await fireOf({ inputRole: "system", scheduledBy: "bot", taint: [] });
    expect(run.kinds).toEqual([]);
  });

  test("whose record says what it read starts with that", async () => {
    const run = await fireOf({ inputRole: "system", scheduledBy: "bot", taint: [{ kind: "web", label: "evil.example/page", at: "2026-11-16T10:00:00Z" }] });
    expect(run.kinds).toEqual(["web"]);
  });
});

describe("a job the owner made", () => {
  test("starts clean with no record of what it read: the owner wrote it", async () => {
    const run = await fireOf({ ownerOnly: true });
    expect(run.principal).toBe("owner");
    expect(run.kinds).toEqual([]);
  });
});

describe("readCarried, with nothing said about taint", () => {
  test("is one unknown source unless the payload is the owner's, or a wake (its results say)", () => {
    expect(readCarried({}).taint.map((source) => source.kind)).toEqual(["unknown"]);
    expect(readCarried({ scheduledBy: "bot" }).taint.map((source) => source.kind)).toEqual(["unknown"]);
    expect(readCarried({ ownerOnly: true }).taint).toEqual([]);
    expect(readCarried({ wakeKey: "wake:t", results: [{ taskID: "tsk_1" }] }).taint).toEqual([]);
    expect(readCarried(undefined).taint.map((source) => source.kind)).toEqual(["unknown"]);
  });

  test("a payload with no tool list is not narrowed", () => {
    expect(readCarried({ scheduledBy: "bot" })).toMatchObject({ narrowed: false, capabilities: null });
  });
});
