/**
 * Sprint 1, task T4: bots and delegation.
 *
 * One file for the T4 bugs (S1-10, 11, 18, 19, 20, 29, 37), written before
 * the fixes. Every test goes through the tool or the resolver a turn uses, not
 * through a helper in isolation.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db";
import { HealthTracker } from "../src/models/health";
import type { ProviderConfig } from "../src/models/providers";
import { Router } from "../src/models/router";
import { ToolRegistry } from "../src/tools/registry";
import { registerHandoffTool } from "../src/tools/handoff-tool";
import { registerDelegateTaskTool } from "../src/tools/delegate-task-tool";
import { registerCreateAgentTool } from "../src/tools/create-agent-tool";
import { createAgentPersona } from "../src/agent/creation";
import { renameAgent } from "../src/agent/identity";
import { CHILD_FORWARDED_FRAMES, handoff } from "../src/agent/handoff";
import { rootGuardrail } from "../src/agent/guardrails";
import { resolveApprovalWaiter } from "../src/agent/approval-broker";
import { fitToolResult } from "../src/agent/task-loop";
import { DEFAULT_AGENT_TOOLS, PERSONAS, getPersona, personaInfo, registerPersona, resolvePersona, updatePersona, type Persona } from "../src/agent/personas";
import { SUMMARY_MAX_CHARS, redactForCaller } from "../src/agent/visibility";
import { createThread, appendMessage } from "../src/stores/threads";
import { ensureConversation, openSession } from "../src/stores/conversations";
import { getJob } from "../src/stores/jobs";
import { getTask, setDelegationArtifact, setDelegationState } from "../src/stores/tasks";
import { saveArtifact } from "../src/stores/artifacts";
import { putAgentMemory } from "../src/stores/agent-memories";
import { rememberFact } from "../src/tools/facts";

const provider: ProviderConfig = {
  id: "test", label: "Test", baseUrl: "https://test.local/v1", apiKey: "test", model: "mock",
};

function sse(chunk: unknown): Response {
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { status: 200 });
}
function textReply(text: string): Response {
  return sse({ choices: [{ delta: { content: text } }] });
}
function routerOf(fetchStub: (url: string, init: RequestInit) => Promise<Response>): Router {
  return new Router([provider], new HealthTracker(), fetchStub as unknown as typeof fetch);
}
function fixedRouter(text: string): Router {
  return routerOf(async () => textReply(text));
}

type Handler = { handler: (args: Record<string, unknown>, ctx: unknown) => Promise<unknown> };
const call = (registry: ToolRegistry, name: string, args: Record<string, unknown>, ctx: unknown): Promise<unknown> =>
  (registry.get(name) as unknown as Handler).handler(args, ctx);

function ctxAs(agentID: string, threadID = "thr_ctx"): unknown {
  return {
    threadID, turnID: "trn_ctx", signal: new AbortController().signal,
    chain: { depth: 1, rootAgentID: agentID, currentAgentID: agentID, handoffSummary: null },
  };
}

let db: Database | undefined;
// registerPersona mutates the process-wide roster; restore it so the bots made
// here cannot leak into other test files.
const INITIAL_ROSTER = PERSONAS.length;
afterEach(() => {
  db?.close();
  db = undefined;
  PERSONAS.length = INITIAL_ROSTER;
});

describe("S1-10: a bot created this turn is a valid target this turn", () => {
  test("handoff and delegate_task accept a bot created after they were registered", async () => {
    db = openDatabase(":memory:");
    const parent = createThread(db, "ea");
    const registry = new ToolRegistry();
    registerHandoffTool(registry, {
      db, router: fixedRouter("Friday reporting in."), settings: { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 },
      emit: () => undefined, signal: new AbortController().signal, threadID: parent.id,
      channelID: "main", currentAgentID: "ea", guardrail: rootGuardrail("ea"),
    });
    registerDelegateTaskTool(registry, { db, emit: () => undefined, currentAgentID: "ea" });
    registerCreateAgentTool(registry, { db, emit: () => undefined });

    // The schema never freezes the roster: a string with a description.
    for (const [tool, field] of [["handoff", "toAgentID"], ["delegate_task", "toAgentID"]] as const) {
      const schema = registry.get(tool)!.schema as { properties: Record<string, { enum?: unknown; type?: string }> };
      expect(schema.properties[field]!.enum).toBeUndefined();
      expect(schema.properties[field]!.type).toBe("string");
    }

    const created = (await call(registry, "create_agent", { name: "Friday", prompt: "You help." }, ctxAs("ea"))) as { id?: string; error?: string };
    expect(created.id).toBe("friday");

    const handed = (await call(registry, "handoff", { toAgentID: "friday", task: "Say hello." }, ctxAs("ea", parent.id))) as { agentID: string; text: string };
    expect(handed.agentID).toBe("friday");
    expect(handed.text).toBe("Friday reporting in.");

    const delegated = (await call(registry, "delegate_task", { toAgentID: "friday", goal: "Write the weekly note" }, ctxAs("ea", parent.id))) as { taskID: string; state: string };
    expect(delegated.state).toBe("queued");
    expect(getTask(db, delegated.taskID)?.owner_agent_id).toBe("friday");
  });

  test("an unknown target is refused at call time with the current teammates listed", async () => {
    db = openDatabase(":memory:");
    const parent = createThread(db, "ea");
    const registry = new ToolRegistry();
    registerHandoffTool(registry, {
      db, router: fixedRouter("x"), settings: { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 },
      emit: () => undefined, signal: new AbortController().signal, threadID: parent.id,
      channelID: "main", currentAgentID: "ea", guardrail: rootGuardrail("ea"),
    });
    registerDelegateTaskTool(registry, { db, emit: () => undefined, currentAgentID: "ea" });
    registerCreateAgentTool(registry, { db, emit: () => undefined });
    await call(registry, "create_agent", { name: "Friday", prompt: "You help." }, ctxAs("ea"));

    await expect(call(registry, "handoff", { toAgentID: "nobody", task: "x" }, ctxAs("ea", parent.id)))
      .rejects.toThrow(/unknown agent nobody.*friday/s);
    await expect(call(registry, "delegate_task", { toAgentID: "nobody", goal: "x" }, ctxAs("ea", parent.id)))
      .rejects.toThrow(/unknown agent nobody.*friday/s);
    // An agent cannot hand work to itself.
    await expect(call(registry, "handoff", { toAgentID: "ea", task: "x" }, ctxAs("ea", parent.id)))
      .rejects.toThrow(/unknown agent ea/);
  });
});

describe("S1-11: create_agent never grants what the creator lacks", () => {
  const registryFor = (creator: Persona): ToolRegistry => {
    registerPersona(creator);
    const registry = new ToolRegistry();
    for (const name of ["bash", "web_search", "web_fetch", "remember_fact", "read_file", "say", "ask"]) {
      registry.register({ name, description: name, kind: "static", schema: {}, timeoutMs: 1, handler: async () => ({}) });
    }
    registerCreateAgentTool(registry, { db: db!, emit: () => undefined });
    return registry;
  };
  const make = (tools: string[], memoryScope: "read" | "readwrite" = "read"): Persona =>
    ({ id: "maker", name: "Maker", color: "#ffffff", role: "r", systemPromptTemplate: "p", tools, memoryScope });
  const agentRows = (): number => db!.query<{ n: number }, []>("SELECT count(*) AS n FROM agents WHERE id = 'kid'").get()!.n;

  test("an unknown tool name is an error that names it, and no bot is made", async () => {
    db = openDatabase(":memory:");
    const registry = registryFor(make(["web_search", "create_agent"]));
    const result = (await call(registry, "create_agent", { name: "Kid", prompt: "p", tools: ["web_search", "not_a_tool", "also_fake"] }, ctxAs("maker"))) as { error?: string };
    expect(result.error).toContain("not_a_tool");
    expect(result.error).toContain("also_fake");
    expect(agentRows()).toBe(0);
  });

  test("with no tools named, the defaults are cut down to the creator's own tools", async () => {
    db = openDatabase(":memory:");
    // The creator has only web_search from the default set.
    const registry = registryFor(make(["web_search", "create_agent"]));
    const result = (await call(registry, "create_agent", { name: "Kid", prompt: "p" }, ctxAs("maker"))) as { tools: string[] };
    expect(result.tools).toEqual(["web_search"]);
    expect(resolvePersona(db, "kid")?.tools).toEqual(["web_search"]);
  });

  test("a creator with none of the defaults cannot make a bot that has them", async () => {
    db = openDatabase(":memory:");
    const registry = registryFor(make(["create_agent"]));
    const result = (await call(registry, "create_agent", { name: "Kid", prompt: "p" }, ctxAs("maker"))) as { error?: string };
    expect(result.error).toBeDefined();
    expect(agentRows()).toBe(0);
  });

  test("tools every bot gets (say, ask) are not grants and are not stored", async () => {
    db = openDatabase(":memory:");
    const registry = registryFor(make(["web_search", "create_agent"]));
    const result = (await call(registry, "create_agent", { name: "Kid", prompt: "p", tools: ["web_search", "say", "ask"] }, ctxAs("maker"))) as { error?: string; tools?: string[] };
    expect(result.error).toBeUndefined();
    expect(result.tools).toEqual(["web_search"]);
  });

  test("a memory-writing tool is dropped, and the creator is told, when the scope is read-only", async () => {
    db = openDatabase(":memory:");
    const registry = registryFor(make(["web_search", "remember_fact", "create_agent"], "readwrite"));
    const result = (await call(registry, "create_agent", { name: "Kid", prompt: "p", tools: ["web_search", "remember_fact"] }, ctxAs("maker"))) as {
      tools: string[]; droppedTools?: string[]; note?: string; memoryScope: string;
    };
    expect(result.memoryScope).toBe("read");
    expect(result.tools).toEqual(["web_search"]);
    expect(result.droppedTools).toEqual(["remember_fact"]);
    expect(result.note).toContain("remember_fact");
    expect(result.note).toContain("readwrite");
  });

  test("the memory-writing tool is kept when the creator can grant readwrite and asks for it", async () => {
    db = openDatabase(":memory:");
    const registry = registryFor(make(["web_search", "remember_fact", "create_agent"], "readwrite"));
    const result = (await call(registry, "create_agent", { name: "Kid", prompt: "p", tools: ["web_search", "remember_fact"], memoryScope: "readwrite" }, ctxAs("maker"))) as { tools: string[]; droppedTools?: string[] };
    expect(result.tools).toEqual(["web_search", "remember_fact"]);
    expect(result.droppedTools).toBeUndefined();
  });

  test("a request for only memory-writing tools on a read-only bot is refused, not defaulted", async () => {
    db = openDatabase(":memory:");
    const registry = registryFor(make(["web_search", "remember_fact", "create_agent"], "readwrite"));
    const result = (await call(registry, "create_agent", { name: "Kid", prompt: "p", tools: ["remember_fact"] }, ctxAs("maker"))) as { error?: string };
    expect(result.error).toBeDefined();
    expect(agentRows()).toBe(0);
  });

  test("the creation helper itself refuses unknown tool names (the app path cannot fall back either)", () => {
    db = openDatabase(":memory:");
    expect(() => createAgentPersona(db!, { name: "Kid", prompt: "p", tools: ["not_a_tool"] }, ["web_search"])).toThrow(/not_a_tool/);
    expect(db.query("SELECT 1 FROM agents WHERE id = 'kid'").get()).toBeNull();
  });
});

describe("S1-18: new bots can read files; delegated results are not clipped to a line", () => {
  test("the default toolset has read_file, and a bot made without tools gets it", () => {
    db = openDatabase(":memory:");
    expect(DEFAULT_AGENT_TOOLS).toContain("read_file");
    const created = createAgentPersona(db, { name: "Kid", prompt: "p" }, []);
    expect(created.tools).toContain("read_file");
    expect(resolvePersona(db, "kid")?.tools).toContain("read_file");
  });

  test("a summary-visibility result keeps up to 4,000 characters", () => {
    expect(SUMMARY_MAX_CHARS).toBe(4_000);
    const text = `start ${"word ".repeat(700)}end`; // about 3,500 characters
    const seen = redactForCaller(text, "kid", "ea", "summary");
    expect(seen.text).toBe(text.replace(/\s+/g, " ").trim());
    const long = redactForCaller(`${"word ".repeat(2_000)}tail-marker`, "kid", "ea", "summary");
    expect(long.text!.length).toBeLessThanOrEqual(4_000);
    expect(long.text).not.toContain("tail-marker");
  });

  test("task_status shows the long result and points at the full one when it is longer still", async () => {
    db = openDatabase(":memory:");
    const registry = new ToolRegistry();
    registerDelegateTaskTool(registry, { db, emit: () => undefined, currentAgentID: "ea" });
    const queued = (await call(registry, "delegate_task", { toAgentID: "researcher", goal: "Big report" }, ctxAs("ea"))) as { taskID: string };

    // The job stores a short summary on the task row and the full text as an artifact.
    const full = Array.from({ length: 900 }, (_, i) => `finding-${i}`).join(" ");
    expect(full.length).toBeGreaterThan(8_000);
    const artifact = saveArtifact(db, { taskID: queued.taskID, agentID: "researcher", content: full });
    setDelegationArtifact(db, queued.taskID, artifact.id);
    setDelegationState(db, queued.taskID, "done", full.slice(0, 400));

    const view = (await call(registry, "task_status", { taskID: queued.taskID }, ctxAs("ea"))) as { result: string; artifactRef: string };
    // Well past the old 240- and 400-character clips.
    expect(view.result).toContain("finding-100");
    expect(view.result.length).toBeGreaterThan(2_000);
    // Cut, so it says where the whole thing is.
    expect(view.result).not.toContain("finding-899");
    expect(view.result).toContain(artifact.id);
    expect(view.artifactRef).toBe(artifact.id);
    // And the loop does not shrink it again on the way to the model.
    const sent = JSON.parse(fitToolResult(view)) as { result: string };
    expect(sent.result).toContain("finding-100");
  });

  test("a short result is returned whole, with no pointer noise", async () => {
    db = openDatabase(":memory:");
    const registry = new ToolRegistry();
    registerDelegateTaskTool(registry, { db, emit: () => undefined, currentAgentID: "ea" });
    const queued = (await call(registry, "delegate_task", { toAgentID: "researcher", goal: "Small job" }, ctxAs("ea"))) as { taskID: string };
    const artifact = saveArtifact(db, { taskID: queued.taskID, agentID: "researcher", content: "All done." });
    setDelegationArtifact(db, queued.taskID, artifact.id);
    setDelegationState(db, queued.taskID, "done", "All done.");
    const view = (await call(registry, "task_status", { taskID: queued.taskID }, ctxAs("ea"))) as { result: string };
    expect(view.result).toBe("All done.");
  });
});

describe("S1-19: handoff", () => {
  const bodyOf = (init: RequestInit): string => String(init.body);

  test("an approval raised in the child reaches the owner, and the answer resumes the child (B4)", async () => {
    db = openDatabase(":memory:");
    const parent = createThread(db, "ea");
    let calls = 0;
    const target = join(tmpdir(), "agni-t4-never-written.txt");
    const router = routerOf(async () => calls++ === 0
      ? sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c-write", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: target, content: "x" }) } }] } }] })
      : textReply("The owner said no; I stopped."));
    const seen: Array<{ type: string; requestID?: string }> = [];
    const result = await handoff({
      db: db!, router, settings: { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 },
      emit: (frame) => {
        seen.push(frame as { type: string; requestID?: string });
        if (frame.type === "approval.request") {
          // What the app does when the owner taps Reject: the row, then the waiter.
          db!.run("UPDATE approvals SET status = 'decided', decision = 'reject' WHERE id = ?", [frame.requestID]);
          resolveApprovalWaiter(frame.requestID, "reject");
        }
      },
      signal: new AbortController().signal, threadID: parent.id, guardrail: rootGuardrail("ea"),
    }, { toAgentID: "coder", task: "Save the note.", emit: () => undefined, signal: new AbortController().signal });
    expect(seen.some((frame) => frame.type === "approval.request")).toBe(true);
    expect(result.text).toBe("The owner said no; I stopped.");
    expect(result.stopReason).toBe("end");
  });

  test("approval.closed is forwarded to the owner with the other prompt frames", () => {
    for (const type of ["approval.request", "approval.closed", "form.request", "secret.request", "secret.cancel", "status.update"]) {
      expect(CHILD_FORWARDED_FRAMES.has(type)).toBe(true);
    }
    // Token and tool frames stay inside the child.
    expect(CHILD_FORWARDED_FRAMES.has("token")).toBe(false);
    expect(CHILD_FORWARDED_FRAMES.has("tool.start")).toBe(false);
  });

  const askAbout = async (setup: (target: string) => void): Promise<string> => {
    const parent = createThread(db!, "ea");
    setup("researcher");
    const bodies: string[] = [];
    const router = routerOf(async (_url, init) => { bodies.push(bodyOf(init)); return textReply("ok"); });
    await handoff({
      db: db!, router, settings: { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 },
      emit: () => undefined, signal: new AbortController().signal, threadID: parent.id, guardrail: rootGuardrail("ea"),
    }, { toAgentID: "researcher", task: "What is my favourite fruit?", emit: () => undefined, signal: new AbortController().signal });
    return bodies.join("\n");
  };

  test("the target bot sees its own recent direct chat, marked as its own", async () => {
    db = openDatabase(":memory:");
    const body = await askAbout((agent) => {
      const conversation = ensureConversation(db!, agent);
      const block = openSession(db!, conversation, "manual", null);
      appendMessage(db!, { threadID: block.id, role: "user", text: "My favourite fruit is PAPAYA." });
      appendMessage(db!, { threadID: block.id, role: "assistant", text: "Noted: PAPAYA." });
      // A peer's brief is not part of the bot's own conversation with the owner.
      appendMessage(db!, { threadID: block.id, role: "system", text: "New Bot messaged you: PEER-BRIEF-MARKER" });
    });
    expect(body).toContain("PAPAYA");
    expect(body).toMatch(/your own (recent )?(direct )?conversation/i);
    expect(body).not.toContain("PEER-BRIEF-MARKER");
  });

  test("the recent chat is limited to the last 12 messages", async () => {
    db = openDatabase(":memory:");
    const body = await askAbout((agent) => {
      const block = openSession(db!, ensureConversation(db!, agent), "manual", null);
      for (let i = 1; i <= 30; i++) appendMessage(db!, { threadID: block.id, role: i % 2 ? "user" : "assistant", text: `msg-${String(i).padStart(2, "0")}-end` });
    });
    expect(body).toContain("msg-30-end");
    expect(body).toContain("msg-19-end");
    expect(body).not.toContain("msg-18-end");
    expect(body).not.toContain("msg-01-end");
  });

  test("the recent chat is limited to 6,000 characters, newest kept", async () => {
    db = openDatabase(":memory:");
    const body = await askAbout((agent) => {
      const block = openSession(db!, ensureConversation(db!, agent), "manual", null);
      for (let i = 1; i <= 12; i++) appendMessage(db!, { threadID: block.id, role: i % 2 ? "user" : "assistant", text: `msg-${String(i).padStart(2, "0")}-start ${"x".repeat(900)}` });
    });
    // 12 messages of about 900 characters would be over 10,000; the cap is 6,000.
    const xs = (body.match(/x{50,}/g) ?? []).join("").length;
    expect(xs).toBeLessThanOrEqual(6_000);
    expect(xs).toBeGreaterThan(2_000);
    expect(body).toContain("msg-12-start");
    expect(body).not.toContain("msg-01-start");
  });

  test("with no live block of its own, the handoff still runs", async () => {
    db = openDatabase(":memory:");
    const body = await askAbout(() => undefined);
    expect(body).toContain("What is my favourite fruit?");
    expect(body).not.toMatch(/your own (recent )?(direct )?conversation/i);
  });
});

describe("S1-20: delegate_task sends the facts it names", () => {
  test("factIDs travel with the brief to the specialist", async () => {
    db = openDatabase(":memory:");
    const fact = rememberFact(db, { fact: "The launch code word is PAPAYA-42.", source: "user" });
    const other = rememberFact(db, { fact: "Budget ceiling is 9,000 EUR.", source: "user" });
    const registry = new ToolRegistry();
    registerDelegateTaskTool(registry, { db, emit: () => undefined, currentAgentID: "ea" });
    const queued = (await call(registry, "delegate_task", {
      toAgentID: "researcher", goal: "Draft the launch note", factIDs: [fact.id],
    }, ctxAs("ea"))) as { jobID: string };
    const payload = JSON.parse(getJob(db, queued.jobID)!.payload!) as { text: string };
    expect(payload.text).toContain("PAPAYA-42");
    expect(payload.text).toContain(fact.id);
    // Only the facts named.
    expect(payload.text).not.toContain("9,000");
    expect(other.id).not.toBe(fact.id);
  });

  test("a private fact of another bot is not sent", async () => {
    db = openDatabase(":memory:");
    const secret = putAgentMemory(db, {
      scope: "agent", agentID: "analyst", keySlug: "vault", type: "fact", content: "VAULT-SECRET-7", tags: [],
      importance: 0.5, visibility: "private", source: "user",
    });
    const registry = new ToolRegistry();
    registerDelegateTaskTool(registry, { db, emit: () => undefined, currentAgentID: "ea" });
    const queued = (await call(registry, "delegate_task", { toAgentID: "researcher", goal: "Look into it", factIDs: [secret.id] }, ctxAs("ea"))) as { jobID: string };
    const payload = JSON.parse(getJob(db, queued.jobID)!.payload!) as { text: string };
    expect(payload.text).not.toContain("VAULT-SECRET-7");
  });
});

describe("S1-29: the name and role the owner sets reach the bot's prompt", () => {
  // The text the app's "+" button stores (apps/web/src/state/app-model.ts).
  const APP_PLACEHOLDER = `You are {name}, an agent {user} just created in the app. You have no job description yet.

Open with one short line, then ask two things: what they want to call you, and what you should do for them.
When they give you a name, call rename_agent so the app shows it — do not simply agree in prose.
When they describe your job, call update_agent with a short role and a prompt written as instructions to yourself.
Until then, answer what is asked, briefly.`;

  const plusBot = (): void => {
    createAgentPersona(db!, { name: "New bot", id: "new_bot", role: "unnamed", prompt: APP_PLACEHOLDER }, []);
  };

  test("after the owner names the bot and sets its role, the prompt says both and not the stale setup text", () => {
    db = openDatabase(":memory:");
    plusBot();
    expect(renameAgent(db, "new_bot", "Researcher").ok).toBe(true);
    updatePersona(db, "new_bot", { role: "web research" });
    const prompt = resolvePersona(db, "new_bot")!.systemPrompt;
    expect(prompt).toContain("Researcher");
    expect(prompt).toContain("web research");
    expect(prompt).not.toContain("no job description yet");
    expect(prompt).not.toContain("rename_agent");
  });

  test("while the job is still unset, the prompt never tells the bot to call a tool it lacks", () => {
    db = openDatabase(":memory:");
    plusBot();
    const resolved = resolvePersona(db, "new_bot")!;
    expect(resolved.tools).not.toContain("rename_agent");
    expect(resolved.systemPrompt).not.toContain("rename_agent");
    // update_agent is on the default toolset, so it may still be named.
    expect(resolved.tools).toContain("update_agent");
    expect(resolved.systemPrompt).toContain("update_agent");
  });

  test("a bot with its own prompt still learns a role the owner sets in the profile", () => {
    db = openDatabase(":memory:");
    createAgentPersona(db, { name: "Scout", prompt: "You watch things closely.", role: "lookout" }, []);
    updatePersona(db, "scout", { role: "competitor tracker" });
    const prompt = resolvePersona(db, "scout")!.systemPrompt;
    expect(prompt).toContain("You watch things closely.");
    expect(prompt).toContain("competitor tracker");
  });

  test("the shipped assistant prompt is unchanged by the role line", () => {
    db = openDatabase(":memory:");
    const prompt = resolvePersona(db, "ea")!.systemPrompt;
    expect(prompt).not.toContain("Your role:");
    expect(getPersona("ea")).toBeDefined();
    expect(personaInfo(db).length).toBeGreaterThan(0);
  });
});

describe("S1-37: tools that were registered but on no allowlist", () => {
  test("the assistant can follow a pointer, read a delegated result, and answer a parked question", () => {
    const ea = getPersona("ea")!;
    for (const tool of ["expand", "read_artifact", "request_owner_input"]) expect(ea.tools).toContain(tool);
    // get_fact duplicates expand(kind=memory); it stays off the list.
    expect(ea.tools).not.toContain("get_fact");
  });

  test("a delegated specialist can park a question for the owner", () => {
    for (const id of ["researcher", "coder", "analyst"]) expect(getPersona(id)!.tools).toContain("request_owner_input");
    expect(DEFAULT_AGENT_TOOLS).toContain("request_owner_input");
  });

  test("the defaults hold no gated or memory-writing tool", () => {
    for (const tool of DEFAULT_AGENT_TOOLS) {
      expect(["bash", "write_file", "mail_send", "remember_fact", "memory_write", "forget_fact", "calendar_create", "calendar_update"]).not.toContain(tool);
    }
  });
});
