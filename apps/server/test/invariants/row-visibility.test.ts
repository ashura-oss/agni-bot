/**
 * INV-12: what a bot wrote is read through that bot's visibility, row by row.
 *
 * A channel belongs to one primary bot, but a group has several authors and the owner writes in all of
 * them. Reading a channel through the primary bot's visibility alone returned a private bot's lines in
 * full to a bot that was not in the room. Every reader of channel or thread history decides per row:
 * the author's visibility, the strictest member's for the owner's own lines, and "private" (a receipt)
 * for an author that cannot be resolved. A bot that belongs to the channel reads it in full.
 *
 * One test per reader: expand, transcript search, facts, handoff's own chat, task status and wait,
 * and the group context.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../../src/db";
import { createAgentPersona } from "../../src/agent/creation";
import { PERSONAS } from "../../src/agent/personas";
import { groupHistory } from "../../src/agent/group";
import { handoff } from "../../src/agent/handoff";
import { rootGuardrail } from "../../src/agent/guardrails";
import { HealthTracker } from "../../src/models/health";
import type { ProviderConfig } from "../../src/models/providers";
import { Router } from "../../src/models/router";
import { ToolRegistry } from "../../src/tools/registry";
import { registerExpandTool } from "../../src/tools/expand-tool";
import { registerDelegateTaskTool } from "../../src/tools/delegate-task-tool";
import { buildTaskToolRegistry } from "../../src/tools/task-registry";
import { searchTranscripts } from "../../src/stores/transcripts";
import { appendChannelMessage, createGroupChannel, ensureDMChannel, getChannel } from "../../src/stores/channels";
import { rememberFact } from "../../src/tools/facts";
import { createDelegationTask, setDelegationState } from "../../src/stores/tasks";
import { appendMessage, createThread } from "../../src/stores/threads";
import { ensureConversation, openSession } from "../../src/stores/conversations";

type Handler = { handler: (args: Record<string, unknown>, ctx: unknown) => Promise<unknown> };

let db: Database | undefined;
const INITIAL_ROSTER = PERSONAS.length;
afterEach(() => {
  db?.close();
  db = undefined;
  PERSONAS.length = INITIAL_ROSTER;
});

const ctx = { threadID: "thr_x", turnID: "trn_x", signal: new AbortController().signal };
const SECRET = "PRIVATE-WORKING-4471";
const LONG = `${"working detail ".repeat(40)}${SECRET}`;

function say(database: Database, channelID: string, fromID: string, text: string): string {
  return appendChannelMessage(database, { channelID, fromType: fromID === "user" ? "user" : "agent", fromID, text }).id;
}

/** A room with a shared lead (the primary), a private bot, and a bot that is not in it. */
function room(): { database: Database; channelID: string } {
  const database = openDatabase(":memory:");
  db = database;
  createAgentPersona(database, { name: "Lead", prompt: "p", visibility: "shared" }, []);
  createAgentPersona(database, { name: "Kid", prompt: "p", visibility: "private" }, []);
  createAgentPersona(database, { name: "Outsider", prompt: "p", visibility: "shared" }, []);
  const group = createGroupChannel(database, "team", ["lead", "kid"]);
  return { database, channelID: group.id };
}

describe("expand reads a shared channel row by row", () => {
  async function expandAs(database: Database, caller: string, id: string): Promise<{ redacted: boolean; messages: Array<{ id: string; text: string }> }> {
    const registry = new ToolRegistry();
    registerExpandTool(registry, { db: database, currentAgentID: caller });
    return (registry.get("expand") as unknown as Handler).handler({ kind: "messages", id }, ctx) as Promise<{ redacted: boolean; messages: Array<{ id: string; text: string }> }>;
  }

  test("a private bot's line in a group whose primary is shared is not returned in full to a bot outside the room", async () => {
    const { database, channelID } = room();
    const lead = say(database, channelID, "lead", "lead says: the budget is fine");
    const kid = say(database, channelID, "kid", `kid says: ${LONG}`);
    const view = await expandAs(database, "outsider", lead);
    expect(JSON.stringify(view)).not.toContain(SECRET);
    expect(view.messages.map((m) => m.id)).toContain(lead);
    expect(view.messages.map((m) => m.id)).not.toContain(kid);
    expect(view.redacted).toBe(true);
  });

  test("the owner's lines in that room take the strictest member's visibility", async () => {
    const { database, channelID } = room();
    const mine = say(database, channelID, "user", `owner says: ${LONG}`);
    const view = await expandAs(database, "outsider", mine);
    expect(JSON.stringify(view)).not.toContain(SECRET);
    expect(view.messages).toEqual([]);
  });

  test("a line by a bot that no longer exists is a receipt", async () => {
    const { database, channelID } = room();
    const ghost = say(database, channelID, "ghost", `ghost says: ${LONG}`);
    const view = await expandAs(database, "outsider", ghost);
    expect(JSON.stringify(view)).not.toContain(SECRET);
  });

  test("a bot that belongs to the room still reads every line", async () => {
    const { database, channelID } = room();
    const kid = say(database, channelID, "kid", `kid says: ${LONG}`);
    const view = await expandAs(database, "lead", kid);
    expect(view.messages[0]!.text).toContain(SECRET);
  });

  test("a bot reads its own line wherever it was written", async () => {
    const { database, channelID } = room();
    const own = say(database, channelID, "outsider", `outsider says: ${LONG}`);
    const view = await expandAs(database, "outsider", own);
    expect(view.messages[0]!.text).toContain(SECRET);
  });
});

describe("transcript search reads a shared channel row by row", () => {
  test("a private bot's line in a group whose primary is shared is not a hit for a bot outside the room", () => {
    const { database, channelID } = room();
    say(database, channelID, "lead", "the lead notes the zebra budget");
    say(database, channelID, "kid", `the kid notes the zebra budget ${SECRET}`);
    const hits = searchTranscripts(database, { query: "zebra budget", callerAgentID: "outsider" });
    expect(JSON.stringify(hits)).not.toContain(SECRET);
    expect(hits.some((hit) => hit.fromID === "lead")).toBe(true);
    expect(hits.some((hit) => hit.fromID === "kid")).toBe(false);
  });

  test("the owner's line in that room is not a hit either", () => {
    const { database, channelID } = room();
    say(database, channelID, "user", `my zebra budget is ${SECRET}`);
    expect(searchTranscripts(database, { query: "zebra budget", callerAgentID: "outsider" })).toEqual([]);
  });

  test("a summary bot's chat gives a bot outside it one line, not the whole text", () => {
    const database = openDatabase(":memory:");
    db = database;
    createAgentPersona(database, { name: "Sumo", prompt: "p", visibility: "summary" }, []);
    createAgentPersona(database, { name: "Outsider", prompt: "p", visibility: "shared" }, []);
    const channel = ensureDMChannel(database, "sumo");
    say(database, channel.id, "sumo", `zebra budget ${LONG}`);
    const hits = searchTranscripts(database, { query: "zebra budget", callerAgentID: "outsider" });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.text).not.toContain(SECRET);
  });

  test("a line by a bot that no longer exists is not a hit", () => {
    const { database, channelID } = room();
    say(database, channelID, "ghost", `ghost zebra budget ${SECRET}`);
    expect(JSON.stringify(searchTranscripts(database, { query: "zebra budget", callerAgentID: "outsider" }))).not.toContain(SECRET);
  });

  test("a bot in the room searches it in full; a search with no caller reads no private line", () => {
    const { database, channelID } = room();
    say(database, channelID, "kid", `the kid notes the zebra budget ${SECRET}`);
    expect(JSON.stringify(searchTranscripts(database, { query: "zebra budget", callerAgentID: "lead" }))).toContain(SECRET);
    expect(JSON.stringify(searchTranscripts(database, { query: "zebra budget" }))).not.toContain(SECRET);
  });

  test("the transcript_search tool shows the same", async () => {
    const { database, channelID } = room();
    say(database, channelID, "kid", `the kid notes the zebra budget ${SECRET}`);
    const registry = buildTaskToolRegistry(database);
    const result = await (registry.get("transcript_search") as unknown as Handler).handler({ query: "zebra budget" }, { ...ctx, chain: { currentAgentID: "outsider", depth: 1, rootAgentID: "outsider", handoffSummary: null } });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});

describe("facts are read through their author", () => {
  test("another bot's agent-scoped fact is not recalled and get_fact returns a receipt", async () => {
    const { database } = room();
    const saved = rememberFact(database, { fact: `kid's note ${SECRET} about the zebra budget`, scope: "agent", agentID: "kid" });
    const registry = buildTaskToolRegistry(database);
    const chain = { currentAgentID: "outsider", depth: 1, rootAgentID: "outsider", handoffSummary: null };
    const recalled = await (registry.get("recall_fact") as unknown as Handler).handler({ query: "zebra budget" }, { ...ctx, chain });
    expect(JSON.stringify(recalled)).not.toContain(SECRET);
    const expand = new ToolRegistry();
    registerExpandTool(expand, { db: database, currentAgentID: "outsider" });
    const got = await (expand.get("get_fact") as unknown as Handler).handler({ id: saved.id }, ctx);
    expect(JSON.stringify(got)).not.toContain(SECRET);
  });

  test("a fact whose author no longer exists is a receipt for every other bot", async () => {
    const { database } = room();
    const saved = rememberFact(database, { fact: `ghost note ${SECRET}`, scope: "agent", agentID: "ghost" });
    const expand = new ToolRegistry();
    registerExpandTool(expand, { db: database, currentAgentID: "lead" });
    const got = await (expand.get("get_fact") as unknown as Handler).handler({ id: saved.id }, ctx);
    expect(JSON.stringify(got)).not.toContain(SECRET);
  });
});

describe("handoff's own chat", () => {
  const provider: ProviderConfig = { id: "test", label: "Test", baseUrl: "https://test.local/v1", apiKey: "test", model: "mock" };
  function sse(text: string): Response {
    const encoder = new TextEncoder();
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }), { status: 200 });
  }

  test("a target that cannot be resolved carries nobody's chat", async () => {
    const database = openDatabase(":memory:");
    db = database;
    const bodies: string[] = [];
    const stub = async (_url: string, init: RequestInit): Promise<Response> => {
      bodies.push(String(init?.body ?? ""));
      return sse("ok");
    };
    const router = new Router([provider], new HealthTracker(), stub as unknown as typeof fetch);
    const parent = createThread(database, "lead");
    // The assistant's own chat with the owner: a bot that is not there falls back to the default persona, and must not read this.
    const block = openSession(database, ensureConversation(database, "ea"), "manual", null);
    appendMessage(database, { threadID: block.id, role: "user", text: `My PIN is ${SECRET}.` });
    await handoff({
      db: database, router, settings: { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 },
      emit: () => undefined, signal: new AbortController().signal, threadID: parent.id, guardrail: rootGuardrail("lead"),
    }, { toAgentID: "ghost", task: "What is my PIN?", includeOwnChat: true, emit: () => undefined, signal: new AbortController().signal });
    expect(bodies.join("\n")).not.toContain(SECRET);
  });
});

describe("task_status and delegate_wait", () => {
  async function statusAs(database: Database, caller: string, tool: "task_status" | "delegate_wait", taskID: string): Promise<unknown> {
    const registry = new ToolRegistry();
    registerDelegateTaskTool(registry, { db: database, emit: () => undefined, currentAgentID: caller });
    return (registry.get(tool) as unknown as Handler).handler({ taskID, timeoutMs: 1000 }, ctx);
  }

  test.each(["task_status", "delegate_wait"] as const)("%s: a bot that neither delegated a task nor did it gets a line, never the whole result", async (tool) => {
    const database = openDatabase(":memory:");
    db = database;
    createAgentPersona(database, { name: "Sumo", prompt: "p", visibility: "summary" }, []);
    createAgentPersona(database, { name: "Outsider", prompt: "p", visibility: "shared" }, []);
    const task = createDelegationTask(database, { ownerAgentID: "sumo", brief: { goal: "Write the report" }, parentAgentID: "lead" });
    setDelegationState(database, task.id, "done", LONG);
    const view = await statusAs(database, "outsider", tool, task.id);
    expect(JSON.stringify(view)).not.toContain(SECRET);
  });

  test.each(["task_status", "delegate_wait"] as const)("%s: a task with no recorded delegator is not open to everyone", async (tool) => {
    const database = openDatabase(":memory:");
    db = database;
    createAgentPersona(database, { name: "Sumo", prompt: "p", visibility: "summary" }, []);
    createAgentPersona(database, { name: "Outsider", prompt: "p", visibility: "shared" }, []);
    const task = createDelegationTask(database, { ownerAgentID: "sumo", brief: { goal: "Write the report" } });
    setDelegationState(database, task.id, "done", LONG);
    const view = await statusAs(database, "outsider", tool, task.id);
    expect(JSON.stringify(view)).not.toContain(SECRET);
  });

  test("a private bot's result is a receipt to a bot that did not ask for it", async () => {
    const database = openDatabase(":memory:");
    db = database;
    createAgentPersona(database, { name: "Kid", prompt: "p", visibility: "private" }, []);
    createAgentPersona(database, { name: "Outsider", prompt: "p", visibility: "shared" }, []);
    const task = createDelegationTask(database, { ownerAgentID: "kid", brief: { goal: "Write the report" }, parentAgentID: "lead" });
    setDelegationState(database, task.id, "done", LONG);
    expect(JSON.stringify(await statusAs(database, "outsider", "task_status", task.id))).not.toContain(SECRET);
  });

  test("the bot that delegated the task reads the result", async () => {
    const database = openDatabase(":memory:");
    db = database;
    createAgentPersona(database, { name: "Sumo", prompt: "p", visibility: "summary" }, []);
    const task = createDelegationTask(database, { ownerAgentID: "sumo", brief: { goal: "Write the report" }, parentAgentID: "ea" });
    setDelegationState(database, task.id, "done", LONG);
    expect(JSON.stringify(await statusAs(database, "ea", "task_status", task.id))).toContain(SECRET);
  });
});

describe("group context", () => {
  test("a bot that is not in the room is shown no private line and no owner line", () => {
    const { database, channelID } = room();
    say(database, channelID, "kid", `kid says: ${SECRET}`);
    say(database, channelID, "user", `owner says: ${SECRET}`);
    const lines = groupHistory(database, channelID, "outsider");
    expect(lines.join("\n")).not.toContain(SECRET);
  });

  test("a bot in the room sees the owner and a receipt for the private bot", () => {
    const { database, channelID } = room();
    say(database, channelID, "kid", `kid says: ${LONG}`);
    say(database, channelID, "user", `owner says: ${LONG}`);
    const lines = groupHistory(database, channelID, "lead").join("\n");
    expect(lines).toContain("owner:");
    expect(lines).toContain("(replied; private)");
    expect(getChannel(database, channelID)).not.toBeNull();
  });
});
