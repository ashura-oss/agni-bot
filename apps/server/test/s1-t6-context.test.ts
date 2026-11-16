/**
 * Sprint 1, T6: context assembly, summaries, and the prompt clock.
 *
 *   S1-17  summary / tagger / compactor calls work for reasoning models
 *   S1-22  the prompt carries the current local time (volatile tail only)
 *   S1-28  after a rollover the prompt keeps the newest carried turns
 *   S1-33  overlapping rotations, double summarize on /new, whole-block summary
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import type { Router } from "../src/models/router";
import { assembleContext, DEFAULT_SLOT_BUDGETS } from "../src/context/compiler";
import { buildDelegationPrefix, currentTimeLine } from "../src/agent/prompts";
import { defaultResolvedPersona } from "../src/agent/personas";
import {
  rotate,
  summarizeBlock,
  SUMMARY_INPUT_CHARS,
} from "../src/agent/rollover";
import { compactChannelHistory } from "../src/agent/compactor";
import {
  activeSession,
  ensureConversation,
  getConversation,
  openSession,
  updateSummary,
  type ConversationRow,
} from "../src/stores/conversations";
import { appendMessage, getThread } from "../src/stores/threads";
import { appendChannelMessage, createChannel, getChannelSummary } from "../src/stores/channels";
import { JobRunner } from "../src/jobs/runner";
import { registerRolloverJob } from "../src/jobs/rollover";
import { registerTaggerJob, scheduleTagger, TAGGER_MAX_ATTEMPTS } from "../src/jobs/tagger";
import { enqueueJob } from "../src/stores/jobs";

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

/** The warnings written while `run` executes (log.warn goes to console.error). */
async function captureWarnings(run: () => Promise<void>): Promise<string> {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try { await run(); } finally { console.error = original; }
  return lines.join("\n");
}

interface SeenRequest { maxTokens?: number; content: string }
/** A router that records what it was asked and answers with `text`. */
function recordingRouter(text: string | (() => string), seen: SeenRequest[] = []): { router: Router; seen: SeenRequest[] } {
  const router = {
    route: async (request: { maxTokens?: number; messages: Array<{ content: string }> }) => {
      seen.push({ maxTokens: request.maxTokens, content: request.messages.map((m) => m.content).join("\n") });
      return { text: typeof text === "function" ? text() : text };
    },
  } as unknown as Router;
  return { router, seen };
}

const GOOD_SUMMARY = '{"goal":"Ship it","decisions":["Use Postgres"],"open_loops":[],"entities":[],"tone":"","source_turn_range":null}';

describe("S1-28: the newest carried turns survive the previous_tail clamp", () => {
  test("a long answer followed by the latest question and answer keeps the latest", () => {
    const tail = [
      "user: first question",
      `assistant: ${"A".repeat(10_000)}`,
      "user: what is the latest question?",
      "assistant: the latest answer is 42",
    ];
    const prefix = assembleContext({ personaPrompt: "P", laneHeader: "L", previousTail: tail });
    expect(prefix).toContain("what is the latest question?");
    expect(prefix).toContain("the latest answer is 42");
    const body = prefix.split("(verbatim, untrusted):\n")[1] ?? "";
    expect(body.length).toBeLessThanOrEqual(DEFAULT_SLOT_BUDGETS.previous_tail * 4 + 1);
  });

  test("when the oldest turn does not fit it is the oldest that is cut, and the cut shows", () => {
    const tail = ["user: oldest turn", "assistant: middle turn", "user: newest turn"];
    const prefix = assembleContext({ personaPrompt: "P", laneHeader: "L", previousTail: tail, budgets: { previous_tail: 28 } });
    expect(prefix).toContain("newest turn");
    expect(prefix).not.toContain("oldest turn");
    expect(prefix).toContain("…");
  });

  test("a tail that fits is untouched", () => {
    const tail = ["user: a", "assistant: b"];
    const prefix = assembleContext({ personaPrompt: "P", laneHeader: "L", previousTail: tail });
    expect(prefix).toContain("user: a\nassistant: b");
    expect(prefix).not.toContain("…");
  });
});

describe("S1-33a: overlapping rotations close every block they open over", () => {
  test("two rotations from the same stale snapshot leave exactly one open block", () => {
    db = openDatabase(":memory:");
    const conversation = ensureConversation(db, "ea");
    const first = openSession(db, conversation, "manual", null);
    // Two callers read the conversation before either rotates.
    const snapshotA: ConversationRow = { ...getConversation(db, conversation.id)! };
    const snapshotB: ConversationRow = { ...getConversation(db, conversation.id)! };
    expect(snapshotA.active_thread_id).toBe(first.id);
    const blockA = openSession(db, snapshotA, "context", null);
    const blockB = openSession(db, snapshotB, "context", null);
    const open = db
      .query<{ id: string }, [string]>("SELECT id FROM threads WHERE conversation_id = ? AND closed_at IS NULL")
      .all(conversation.id)
      .map((row) => row.id);
    expect(open).toEqual([blockB.id]);
    expect(getThread(db, blockA.id)?.closed_at).not.toBeNull();
    expect(getConversation(db, conversation.id)?.active_thread_id).toBe(blockB.id);
  });

  test("an already closed block keeps its original close time", () => {
    db = openDatabase(":memory:");
    const conversation = ensureConversation(db, "ea");
    const first = openSession(db, conversation, "manual", null);
    const stale: ConversationRow = { ...getConversation(db, conversation.id)! };
    openSession(db, conversation, "context", null);
    const closedAt = getThread(db, first.id)!.closed_at;
    openSession(db, stale, "context", null);
    expect(getThread(db, first.id)?.closed_at).toBe(closedAt);
    expect(getThread(db, first.id)?.closed_by).toBe("context");
  });
});

describe("S1-33b: /new summarizes a block once", () => {
  test("rotate then the queued job make one model call, and the summary is stored", async () => {
    db = openDatabase(":memory:");
    const conversation = ensureConversation(db, "ea");
    const block = openSession(db, conversation, "manual", null);
    appendMessage(db, { threadID: block.id, role: "user", text: "we decided to use Postgres" });
    const { router, seen } = recordingRouter(GOOD_SUMMARY);

    await rotate({ db, router, firstTokenTimeoutMs: 1000 }, "ea", "manual");
    expect(seen).toHaveLength(1);
    expect(getConversation(db, conversation.id)?.summary).toContain("Use Postgres");

    const runner = new JobRunner(db, () => undefined, { maxPerTick: 5 });
    registerRolloverJob(runner, { db, router, firstTokenTimeoutMs: 1000, emit: () => undefined });
    await runner.tick();
    expect(seen).toHaveLength(1);
  });

  test("a /new whose summary failed leaves the job to try again", async () => {
    db = openDatabase(":memory:");
    const conversation = ensureConversation(db, "ea");
    updateSummary(db, conversation.id, "prior carry survives");
    const block = openSession(db, conversation, "manual", null);
    appendMessage(db, { threadID: block.id, role: "user", text: "we decided to use Postgres" });
    const failing = { route: async () => { throw new Error("provider down"); } } as unknown as Router;
    await captureWarnings(async () => { await rotate({ db: db!, router: failing, firstTokenTimeoutMs: 1000 }, "ea", "manual"); });
    expect(getConversation(db, conversation.id)?.summary).toBe("prior carry survives");

    const { router, seen } = recordingRouter(GOOD_SUMMARY);
    const runner = new JobRunner(db, () => undefined, { maxPerTick: 5 });
    registerRolloverJob(runner, { db, router, firstTokenTimeoutMs: 1000, emit: () => undefined });
    await runner.tick();
    expect(seen).toHaveLength(1);
    expect(getConversation(db, conversation.id)?.summary).toContain("Use Postgres");
  });
});

describe("S1-33c: the summary reads the whole block", () => {
  function fillBlock(database: Database, threadID: string, count: number, size: number): void {
    appendMessage(database, { threadID, role: "user", text: "EARLY-DECISION we chose Postgres for storage" });
    for (let index = 0; index < count; index += 1) {
      appendMessage(database, { threadID, role: index % 2 === 0 ? "assistant" : "user", text: `filler ${index} ${"x".repeat(size)}` });
    }
    appendMessage(database, { threadID, role: "user", text: "LATE-DECISION ship on Friday" });
  }

  test("a block of 90 messages reaches the model from its first message to its last", async () => {
    db = openDatabase(":memory:");
    const conversation = ensureConversation(db, "ea");
    const block = openSession(db, conversation, "manual", null);
    fillBlock(db, block.id, 88, 150);
    const { router, seen } = recordingRouter(GOOD_SUMMARY);
    await summarizeBlock({ db, router, firstTokenTimeoutMs: 1000 }, conversation, block);
    expect(seen[0]!.content).toContain("EARLY-DECISION");
    expect(seen[0]!.content).toContain("LATE-DECISION");
  });

  test("one huge answer does not push the rest of the block out", async () => {
    db = openDatabase(":memory:");
    const conversation = ensureConversation(db, "ea");
    const block = openSession(db, conversation, "manual", null);
    appendMessage(db, { threadID: block.id, role: "user", text: "EARLY-DECISION we chose Postgres" });
    appendMessage(db, { threadID: block.id, role: "assistant", text: "y".repeat(60_000) });
    appendMessage(db, { threadID: block.id, role: "user", text: "LATE-DECISION ship on Friday" });
    const { router, seen } = recordingRouter(GOOD_SUMMARY);
    await summarizeBlock({ db, router, firstTokenTimeoutMs: 1000 }, conversation, block);
    expect(seen[0]!.content).toContain("EARLY-DECISION");
    expect(seen[0]!.content).toContain("LATE-DECISION");
    expect(seen[0]!.content.length).toBeLessThan(SUMMARY_INPUT_CHARS + 2_000);
  });

  test("a very long block stays bounded and keeps its start and its end", async () => {
    db = openDatabase(":memory:");
    const conversation = ensureConversation(db, "ea");
    const block = openSession(db, conversation, "manual", null);
    fillBlock(db, block.id, 400, 900);
    const { router, seen } = recordingRouter(GOOD_SUMMARY);
    await summarizeBlock({ db, router, firstTokenTimeoutMs: 1000 }, conversation, block);
    const sent = seen[0]!.content;
    expect(sent.length).toBeLessThan(SUMMARY_INPUT_CHARS + 2_000);
    expect(sent).toContain("EARLY-DECISION");
    expect(sent).toContain("LATE-DECISION");
    expect(sent).toMatch(/messages? omitted/);
  });
});

describe("S1-17: auxiliary calls work for reasoning models", () => {
  test("the summary asks for room beyond its reasoning", async () => {
    db = openDatabase(":memory:");
    const conversation = ensureConversation(db, "ea");
    const block = openSession(db, conversation, "manual", null);
    appendMessage(db, { threadID: block.id, role: "user", text: "we decided to use Postgres" });
    const { router, seen } = recordingRouter(GOOD_SUMMARY);
    await summarizeBlock({ db, router, firstTokenTimeoutMs: 1000 }, conversation, block);
    expect(seen[0]!.maxTokens).toBeGreaterThanOrEqual(4096);
  });

  test("an empty answer never replaces a good summary, and the log says why", async () => {
    db = openDatabase(":memory:");
    const conversation = ensureConversation(db, "ea");
    updateSummary(db, conversation.id, "prior carry survives");
    const block = openSession(db, conversation, "manual", null);
    appendMessage(db, { threadID: block.id, role: "user", text: "we decided to use Postgres" });
    enqueueJob(db, {
      kind: "rollover.summarize",
      payload: { threadID: block.id, conversationID: conversation.id, version: Date.parse(block.created_at) },
    });
    // A reasoning model that spent the whole budget thinking: no content.
    const router = { route: async () => ({ text: "", reasoning: "thinking...", outputTokens: 1500 }) } as unknown as Router;
    const runner = new JobRunner(db, () => undefined, { maxPerTick: 5 });
    registerRolloverJob(runner, { db, router, firstTokenTimeoutMs: 1000, emit: () => undefined });
    const warnings = await captureWarnings(async () => { await runner.tick(); });
    expect(getConversation(db, conversation.id)?.summary).toBe("prior carry survives");
    expect(warnings).toMatch(/empty/i);
  });

  test("an empty JSON object is not a summary either", async () => {
    db = openDatabase(":memory:");
    const conversation = ensureConversation(db, "ea");
    const block = openSession(db, conversation, "manual", null);
    appendMessage(db, { threadID: block.id, role: "user", text: "we decided to use Postgres" });
    const { router } = recordingRouter("{}");
    await captureWarnings(async () => {
      await expect(summarizeBlock({ db: db!, router, firstTokenTimeoutMs: 1000 }, conversation, block)).rejects.toThrow();
    });
  });

  test("the tagger asks for room beyond its reasoning", async () => {
    db = openDatabase(":memory:");
    const channel = createChannel(db, { type: "main", visibility: "public", name: "A", agentID: "ea" });
    appendChannelMessage(db, { channelID: channel.id, fromType: "user", fromID: "device-1", text: "I live in NYC." });
    const { router, seen } = recordingRouter(JSON.stringify({ items: [], ephemeral: true }));
    scheduleTagger(db, { channelID: channel.id, turns: 5 });
    const runner = new JobRunner(db, () => undefined, { maxPerTick: 5 });
    registerTaggerJob(runner, { db, router, emit: () => undefined });
    await runner.tick();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.maxTokens).toBeGreaterThanOrEqual(4096);
  });

  test("an empty tagger answer is a failed call: the batch is never given up on", async () => {
    db = openDatabase(":memory:");
    const channel = createChannel(db, { type: "main", visibility: "public", name: "A", agentID: "ea" });
    appendChannelMessage(db, { channelID: channel.id, fromType: "user", fromID: "device-1", text: "I live in NYC." });
    const router = { route: async () => ({ text: "", reasoning: "thinking...", outputTokens: 1500 }) } as unknown as Router;
    const runner = new JobRunner(db, () => undefined, { maxPerTick: 5 });
    registerTaggerJob(runner, { db, router, emit: () => undefined });
    const untagged = (): number =>
      db!.query<{ c: number }, []>("SELECT count(*) AS c FROM channel_messages WHERE tagged_at IS NULL").get()!.c;
    const warnings = await captureWarnings(async () => {
      for (let attempt = 0; attempt <= TAGGER_MAX_ATTEMPTS; attempt += 1) {
        scheduleTagger(db!, { channelID: channel.id, turns: 5 });
        await runner.tick();
      }
    });
    // Still waiting for a model that can answer: nothing was written off.
    expect(untagged()).toBe(1);
    expect(warnings).toMatch(/empty/i);
  });

  test("the compactor asks for room beyond its reasoning, and logs an empty answer", async () => {
    db = openDatabase(":memory:");
    for (let index = 0; index < 37; index += 1) {
      appendChannelMessage(db, { channelID: "main", fromType: index % 2 ? "agent" : "user", fromID: index % 2 ? "ea" : "device-1", text: `message ${index}` });
    }
    const seen: SeenRequest[] = [];
    const { router: ok } = recordingRouter(JSON.stringify({ updated_summary: "S" }), seen);
    await compactChannelHistory(db, ok, "main", "ea");
    expect(seen[0]!.maxTokens).toBeGreaterThanOrEqual(4096);
    expect(getChannelSummary(db, "main")?.summary).toBe("S");

    const other = openDatabase(":memory:");
    for (let index = 0; index < 37; index += 1) {
      appendChannelMessage(other, { channelID: "main", fromType: index % 2 ? "agent" : "user", fromID: index % 2 ? "ea" : "device-1", text: `message ${index}` });
    }
    const empty = { route: async () => ({ text: "", reasoning: "thinking..." }) } as unknown as Router;
    const warnings = await captureWarnings(async () => { await compactChannelHistory(other, empty, "main", "ea"); });
    expect(getChannelSummary(other, "main")).toBeNull();
    expect(warnings).toMatch(/empty/i);
    other.close();
  });
});

describe("S1-22: the prompt knows the time", () => {
  const NOW = new Date("2026-11-16T19:32:45.000Z");

  test("the line names the local date, time and zone, to the minute", () => {
    const line = currentTimeLine(NOW, "America/New_York");
    expect(line).toContain("Monday");
    expect(line).toContain("16 November 2026");
    expect(line).toContain("14:32");
    expect(line).toContain("America/New_York");
    expect(line).toContain("UTC-05:00");
    expect(line).not.toContain("14:32:45");
  });

  test("the zone moves the clock", () => {
    const line = currentTimeLine(NOW, "Asia/Shanghai");
    expect(line).toContain("17 November 2026");
    expect(line).toContain("03:32");
    expect(line).toContain("UTC+08:00");
  });

  function prefixAt(now: Date): string {
    return buildDelegationPrefix({
      persona: defaultResolvedPersona(db!),
      facts: ["likes tea"],
      carrySummary: "We were planning the launch.",
      depth: 1,
      maxDepth: 3,
      anchor: { topic: "launch", entities: ["Raft"], lastQuestion: "when?" },
      recall: ["a recalled fact"],
      previousTail: ["user: hello"],
      now,
      timeZone: "America/New_York",
    });
  }

  test("it sits at the end of the prompt, after the stable slots and the anchor", () => {
    db = openDatabase(":memory:");
    const prefix = prefixAt(NOW);
    const at = prefix.indexOf("Current date and time");
    expect(at).toBeGreaterThan(0);
    for (const marker of ["Owner profile", "Summary of earlier context", "Recalled from memory", "Topic: launch"]) {
      expect(prefix.indexOf(marker)).toBeGreaterThanOrEqual(0);
      expect(prefix.indexOf(marker)).toBeLessThan(at);
    }
    // Nothing follows the clock but the clock.
    expect(prefix.slice(at).split("\n\n")).toHaveLength(1);
  });

  test("the cacheable prefix is identical across minutes; seconds change nothing", () => {
    db = openDatabase(":memory:");
    const a = prefixAt(NOW);
    const sameMinute = prefixAt(new Date(NOW.getTime() + 10_000));
    const nextMinute = prefixAt(new Date(NOW.getTime() + 60_000));
    expect(sameMinute).toBe(a);
    expect(nextMinute).not.toBe(a);
    const stable = (text: string): string => text.slice(0, text.indexOf("Current date and time"));
    expect(stable(nextMinute)).toBe(stable(a));
  });

  test("without a given clock the line is still there", () => {
    db = openDatabase(":memory:");
    const prefix = buildDelegationPrefix({ persona: defaultResolvedPersona(db), facts: [], carrySummary: null, depth: 1, maxDepth: 3 });
    expect(prefix).toContain("Current date and time");
  });
});
