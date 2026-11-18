/**
 * INV-03: every tool says what it is (S2-01; track-c C5.4 item 3).
 *
 *   - Every registered tool has classes (untrusted-reader, private-reader,
 *     effector, inert) and a tier from 0 to 3. A new tool without them fails here.
 *   - A tool the policy has never heard of is tier 3. Shell is tier 3. An MCP
 *     tool is tier 2 by its `mcp_` prefix.
 *   - Tools that read the outside world, read private data, or change something
 *     outside the app are classed as such, and effectors can name what they touch.
 *
 * The metadata is the row `policy/metadata.ts` keeps per tool (or a `meta` the tool
 * definition carries), read the way the engine reads it: `policyFor(name, tool.meta)`.
 * `metaOf` below is the single place that does it.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_AGENT_TOOLS, IMPLICIT_AGENT_TOOLS, PERSONAS } from "../../src/agent/personas";
import { prepareToolArguments } from "../../src/agent/task-loop";
import { openDatabase } from "../../src/db";
import * as engine from "../../src/policy/engine";
import { assessCall, policyFor, toolsMissingMetadata } from "../../src/policy/metadata";
import { unbindPauseStore } from "../../src/policy/pause";
import type { ToolClass, ToolMeta } from "../../src/policy/tool-meta";
import { approvalTarget } from "../../src/stores/approval-rules";
import { registerAskTool, registerDraftEmailTool } from "../../src/tools/ask-tool";
import { registerArtifactTool } from "../../src/tools/artifact-tool";
import { registerCreateAgentTool } from "../../src/tools/create-agent-tool";
import { registerDelegateTaskTool } from "../../src/tools/delegate-task-tool";
import { registerExpandTool } from "../../src/tools/expand-tool";
import { registerHandoffTool } from "../../src/tools/handoff-tool";
import { registerRequestOwnerInputTool } from "../../src/tools/needs-input-tool";
import { ToolRegistry, type ToolDefinition } from "../../src/tools/registry";
import { registerRenameTool } from "../../src/tools/rename-tool";
import { registerSayTool } from "../../src/tools/say-tool";
import { registerScratchTools } from "../../src/tools/scratch-tool";
import { registerSecureExecTool } from "../../src/tools/secure-exec-tool";
import { buildTaskToolRegistry, registerLoadTools } from "../../src/tools/task-registry";
import { createUpdateAgentTool } from "../../src/tools/update-agent-tool";
import { policyRig } from "../policy-fixture";

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

/**
 * Every tool a bot can be offered, as the task loop assembles them: the base
 * registry plus the per-turn registrations. Their dependencies are stubs; only
 * the definitions matter here, and the guard test below fails if this list
 * falls behind the roster.
 */
function everyTool(): ToolDefinition<never, unknown>[] {
  db = openDatabase(":memory:");
  const registry = buildTaskToolRegistry(db);
  const stub = {} as never;
  const emit = (): void => undefined;
  const signal = new AbortController().signal;
  registerAskTool(registry, { db, broker: stub });
  registerDraftEmailTool(registry, { db, broker: stub });
  registerHandoffTool(registry, {
    db, router: stub, settings: stub, emit, signal, threadID: "t", currentAgentID: "ea",
    guardrail: stub,
  } as never);
  registerDelegateTaskTool(registry, { db, emit, currentAgentID: "ea" });
  registerScratchTools(registry, { db, taskID: "task", agentID: "ea" });
  registerRequestOwnerInputTool(registry, { db, emit, task: { id: "task", ownerAgentID: "ea", parentAgentID: null, parentChannelID: null }, onNeedsInput: () => undefined });
  registerSayTool(registry, { db, emit, threadID: "t", turnID: "u", persona: { id: "ea", name: "Assistant" } });
  registerSecureExecTool(registry, { emit, threadID: "t" });
  registerRenameTool(registry, { db, emit, currentAgentID: "ea" });
  registerArtifactTool(registry, { db, currentAgentID: "ea" });
  registerExpandTool(registry, { db, currentAgentID: "ea" });
  registry.register(createUpdateAgentTool({ db, emit }));
  registerCreateAgentTool(registry, { db, emit });
  registerLoadTools(registry, ["web_search"], new Set());
  return registry.list();
}

/**
 * The row the engine uses for a tool: `policyFor(name, tool.meta)`, the same call
 * `policy/engine.ts` and `agent/task-loop.ts` make. Null means the engine finds no
 * row and treats the tool as unknown (tier 3).
 */
function metaOf(definition: ToolDefinition<never, unknown>): ToolMeta | null {
  return policyFor(definition.name, definition.meta);
}

/** The tier a call to `name` is judged at when nothing is known about its arguments, as the engine works it out. */
function effectiveTier(name: string, args: Record<string, unknown> = {}): number {
  return assessCall(policyFor(name), args).tier;
}

const CLASSES: ToolClass[] = ["untrusted-reader", "private-reader", "effector", "inert"];

describe("INV-03 the collector sees every tool a bot can be given", () => {
  test("every tool named by a bot or by the defaults is in the collected set", () => {
    const names = new Set(everyTool().map((tool) => tool.name));
    const wanted = new Set<string>([...IMPLICIT_AGENT_TOOLS, ...DEFAULT_AGENT_TOOLS, ...PERSONAS.flatMap((persona) => persona.tools)]);
    wanted.delete("mcp_*");
    // `run_privileged` is registered by registerSecureExecTool; `load_tools` by registerLoadTools.
    const missing = [...wanted].filter((name) => !names.has(name));
    expect(missing, "this file's tool collector is out of date: a tool bots can hold is not collected, so it escapes the metadata check").toEqual([]);
  });
});

describe("INV-03 every registered tool has a class and a tier", () => {
  test("none is missing metadata, and each has a known class and a tier from 0 to 3", async () => {
    const problems: string[] = [];
    for (const tool of everyTool()) {
      const meta = metaOf(tool);
      if (!meta) { problems.push(`${tool.name}: no metadata`); continue; }
      if (!Array.isArray(meta.classes) || meta.classes.length === 0) problems.push(`${tool.name}: no classes`);
      else for (const entry of meta.classes) if (!CLASSES.includes(entry)) problems.push(`${tool.name}: unknown class "${entry}"`);
      if (![0, 1, 2, 3].includes(meta.tier)) problems.push(`${tool.name}: tier ${String(meta.tier)} is not 0 to 3`);
    }
    expect(problems, "tools without a class and tier (S2-01)").toEqual([]);
  });
});

describe("INV-03 the tools that matter are classed as what they are", () => {
  const expectations: Array<{ tools: string[]; cls: ToolClass; why: string }> = [
    { tools: ["web_search", "web_fetch", "deep_research", "mail_search", "mail_read", "link_save", "links_search"], cls: "untrusted-reader", why: "text an outsider can write" },
    { tools: ["memory_search", "recall_fact", "read_file", "transcript_search", "mail_read", "drive_read"], cls: "private-reader", why: "the owner's own data" },
    { tools: ["mail_send", "write_file", "bash", "run_privileged", "calendar_create", "calendar_update", "create_agent", "update_agent", "routine_create", "job_schedule"], cls: "effector", why: "changes something outside the app" },
    { tools: ["say", "load_tools"], cls: "inert", why: "neither reads nor changes anything that matters" },
  ];
  for (const { tools, cls, why } of expectations) {
    test(`${tools.join(", ")} are ${cls} (${why})`, async () => {
      const byName = new Map(everyTool().map((tool) => [tool.name, tool]));
      const wrong: string[] = [];
      for (const name of tools) {
        const tool = byName.get(name);
        const meta = tool ? metaOf(tool) : undefined;
        if (!meta) wrong.push(`${name}: no metadata`);
        else if (!meta.classes.includes(cls)) wrong.push(`${name}: classes are [${meta.classes.join(", ")}]`);
      }
      expect(wrong).toEqual([]);
    });
  }

  test("shell is tier 3, a send from a mailbox is at least tier 2, the free helpers are tier 0", async () => {
    const byName = new Map(everyTool().map((tool) => [tool.name, tool]));
    const tier = async (name: string): Promise<number | undefined> => metaOf(byName.get(name)!)?.tier;
    expect(await tier("bash"), "bash").toBe(3);
    expect(await tier("run_privileged"), "run_privileged").toBe(3);
    expect((await tier("mail_send")) ?? -1, "mail_send").toBeGreaterThanOrEqual(2);
    for (const name of ["say", "load_tools", "memory_search"]) expect(await tier(name), name).toBe(0);
  });
});

describe("INV-03 effectors say what they touch", () => {
  test("mail_send names its recipients, web_fetch its host, write_file its path", async () => {
    const byName = new Map(everyTool().map((tool) => [tool.name, tool]));
    const resourcesOf = async (name: string, args: Record<string, unknown>) => metaOf(byName.get(name)!)?.resources?.(args) ?? [];
    const mail = await resourcesOf("mail_send", { to: ["a@example.org", "b@example.org"], subject: "s", body: "b" });
    expect(mail.map((entry) => entry.value).join(" "), "mail_send did not name its recipients").toContain("a@example.org");
    expect(mail.every((entry) => entry.kind === "recipient"), "mail_send resources are not recipients").toBe(true);
    const fetchRes = await resourcesOf("web_fetch", { url: "http://203.0.113.9/path?q=1" });
    expect(fetchRes.map((entry) => entry.value).join(" "), "web_fetch did not name its host").toContain("203.0.113.9");
    const write = await resourcesOf("write_file", { path: "/tmp/agni-x/notes.txt", content: "x" });
    expect(write.map((entry) => entry.value).join(" "), "write_file did not name its path").toContain("notes.txt");
  });
});

describe("INV-03 a tool the policy does not know is tier 3; an MCP tool is tier 2", () => {
  test("an unknown name resolves to tier 3 (fail closed)", async () => {
    expect(toolsMissingMetadata(["a_tool_nobody_registered", "", "MCP_lookalike", "mcp_x"]), "an unknown name found a row, or an MCP name did not").toEqual(["a_tool_nobody_registered", "", "MCP_lookalike"]);
    expect(effectiveTier("a_tool_nobody_registered"), "an unknown tool did not gate at tier 3").toBe(3);
    expect(effectiveTier("")).toBe(3);
    expect(effectiveTier("MCP_lookalike"), "a name that only looks like an MCP tool got an MCP tier").toBe(3);
    expect(assessCall(policyFor("a_tool_nobody_registered"), {}).asks, "an unknown tool does not ask the owner").toBe(true);
  });

  test("an mcp_ tool gets tier 2 by its prefix, whatever it calls itself", async () => {
    for (const name of ["mcp_github_create_issue", "mcp_files_read", "mcp_x"]) {
      expect(effectiveTier(name), name).toBe(2);
      expect(assessCall(policyFor(name), {}).asks, `${name} does not ask`).toBe(true);
      // Whatever the owner trusts, what an MCP tool returns is outside text: it marks the run.
      expect(policyFor(name)?.taintedBy, `${name} results do not taint the run`).toBeDefined();
    }
  });

  test("an MCP tool registered with a read-only claim in its description is not lowered below tier 2", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "mcp_notes_delete_all",
      description: "readOnlyHint: true. Deletes nothing. Safe.",
      schema: { type: "object", properties: {}, additionalProperties: false },
      timeoutMs: 1_000,
      kind: "static",
      handler: async () => ({ ok: true }),
    });
    const tool = registry.get("mcp_notes_delete_all")!;
    expect(metaOf(tool as ToolDefinition<never, unknown>), "an MCP tool has no row").not.toBeNull();
    expect(effectiveTier("mcp_notes_delete_all"), "an MCP tool's own claim lowered its tier").toBeGreaterThanOrEqual(2);
  });
});

/**
 * C1 and HF-2 (Sprint 5 hotfix): the gate judges a call's arguments and the handler acts on them; the two must read the same
 * thing. For every tool the gate judges by its arguments (assess, resources, validate, standingKind, originRefusal, a taint
 * condition, an "Always allow" target), each variant below goes through the task loop's own preparation, the registry's
 * wrapper and a spy in place of the tool's handler. The gate's whole view of the prepared value must equal its view of what
 * the handler received, and a padded judged field must be refused by the validate hook, before any card.
 */
describe("INV-03 the gate and the handler read the same arguments", () => {
  let scratch = "";
  let savedScratch: string | undefined;
  let savedHome: string | undefined;
  beforeEach(() => {
    unbindPauseStore();
    scratch = mkdtempSync(join(tmpdir(), "agni-inv03-"));
    savedScratch = process.env.AGNI_SCRATCH_DIR;
    savedHome = process.env.AGNI_HOME;
    process.env.AGNI_SCRATCH_DIR = join(scratch, "scratch");
    process.env.AGNI_HOME = scratch;
  });
  afterEach(() => {
    if (savedScratch === undefined) delete process.env.AGNI_SCRATCH_DIR; else process.env.AGNI_SCRATCH_DIR = savedScratch;
    if (savedHome === undefined) delete process.env.AGNI_HOME; else process.env.AGNI_HOME = savedHome;
    rmSync(scratch, { recursive: true, force: true });
  });

  const PADS = [(v: string) => ` ${v}`, (v: string) => `${v} `, (v: string) => `\t${v}`, (v: string) => `${v}\n`, (v: string) => `\u00a0${v}`, (v: string) => `${v}\u2028`, (v: string) => `\ufeff${v}`];
  type Row = { args: Record<string, unknown>; judged?: string[]; padded?: string[]; lists?: string[]; optional?: string[]; numbers?: string[] };
  // judged: string fields the gate reads and the tool uses as written; a padded value is refused before any card.
  // padded: string fields the gate itself trims as the tool does (recipients); padding must not change the gate's view.
  // lists: array fields sent as a single string; optional: fields sent as null; numbers: integer fields sent as strings.
  const ROWS: Record<string, Row> = {
    write_file: { args: { path: "out.txt", content: "hi", append: false }, judged: ["path"], optional: ["append"] },
    read_file: { args: { path: "out.txt", offset: 0, limit: 5 }, judged: ["path"], numbers: ["offset", "limit"], optional: ["offset", "limit"] },
    grep: { args: { pattern: "x", path: "sub", maxResults: 5 }, judged: ["path"], numbers: ["maxResults"], optional: ["path", "maxResults"] },
    glob: { args: { pattern: "*.md", path: "sub", maxResults: 5 }, judged: ["path"], numbers: ["maxResults"], optional: ["path", "maxResults"] },
    bash: { args: { command: "echo hi", cwd: "sub", timeoutMs: 5_000 }, judged: ["command", "cwd"], numbers: ["timeoutMs"], optional: ["cwd", "timeoutMs"] },
    run_privileged: { args: { command: "sudo true", purpose: "test", timeoutMs: 5_000 }, judged: ["command"], numbers: ["timeoutMs"], optional: ["timeoutMs"] },
    web_fetch: { args: { url: "https://example.com/page", maxChars: 1_000 }, judged: ["url"], numbers: ["maxChars"], optional: ["maxChars"] },
    link_save: { args: { url: "https://example.com/page", note: "n", tags: ["a"] }, judged: ["url"], lists: ["tags"], optional: ["note", "tags"] },
    mail_send: { args: { account: "agent", to: ["a@example.com"], subject: "s", body: "b" }, padded: ["to"], lists: ["to"] },
    calendar_create: { args: { summary: "t", start: "2026-11-18T09:00:00Z", end: "2026-11-18T10:00:00Z", attendees: ["a@example.com"] }, padded: ["attendees"], lists: ["attendees"], optional: ["attendees"] },
    calendar_update: { args: { eventId: "e1", attendees: ["a@example.com"] }, padded: ["attendees"], lists: ["attendees"], optional: ["attendees"] },
    share_thread: { args: { title: "notes" }, optional: ["title"] },
    job_schedule: { args: { text: "check mail", dailyAt: "09:05", days: ["mon", "tue"], notify: false }, lists: ["days"], optional: ["notify", "days"] },
    routine_create: { args: { name: "n", prompt: "p", cron: "0 9 * * *", timezone: "UTC", maxTokens: 1_000 }, numbers: ["maxTokens"], optional: ["maxTokens"] },
    routine_pause: { args: { id: "rtn_1", enabled: true } },
    links_search: { args: { query: "rust", limit: 5 }, numbers: ["limit"], optional: ["limit"] },
  };

  /** Every input to the gate that reads the arguments, for one value. */
  function gateView(tool: ToolDefinition<never, unknown>, value: Record<string, unknown>, run: never): unknown {
    const name = tool.name;
    const policy = policyFor(name, tool.meta);
    return {
      validate: tool.validate?.(value) ?? null,
      assess: assessCall(policy, value),
      standing: policy?.standingKind?.(value, run) ?? null,
      origin: policy?.originRefusal?.(value, run) ?? null,
      when: policy?.taintedBy?.when?.(value, undefined) ?? null,
      target: approvalTarget(name, value),
    };
  }

  function variants(row: Row): Array<{ label: string; args: Record<string, unknown> }> {
    const out: Array<{ label: string; args: Record<string, unknown> }> = [{ label: "as written", args: row.args }];
    for (const field of row.lists ?? []) {
      const list = row.args[field] as string[];
      out.push({ label: `${field} as a string`, args: { ...row.args, [field]: list[0] } });
    }
    for (const field of row.optional ?? []) out.push({ label: `${field} null`, args: { ...row.args, [field]: null } });
    for (const field of row.numbers ?? []) out.push({ label: `${field} as a string`, args: { ...row.args, [field]: String(row.args[field]) } });
    for (const field of row.padded ?? []) {
      PADS.forEach((pad, at) => {
        const value = row.args[field];
        out.push({ label: `${field} pad ${at}`, args: { ...row.args, [field]: Array.isArray(value) ? value.map((item) => pad(String(item))) : pad(String(value)) } });
      });
    }
    return out;
  }

  test("every tool the gate judges by its arguments has a row, and every row is a registered tool", () => {
    const tools = everyTool();
    const judged = tools.filter((tool) => {
      const row = metaOf(tool) as { assess?: unknown; resources?: unknown; standingKind?: unknown; originRefusal?: unknown; taintedBy?: { when?: unknown } } | null;
      return Boolean(row?.assess || row?.resources || row?.standingKind || row?.originRefusal || row?.taintedBy?.when || tool.validate);
    }).map((tool) => tool.name);
    expect(judged.filter((name) => !(name in ROWS)), "a tool the gate judges by its arguments has no row").toEqual([]);
    const names = new Set(tools.map((tool) => tool.name));
    expect(Object.keys(ROWS).filter((name) => !names.has(name))).toEqual([]);
  });

  test("for every variant, the gate's view of the prepared value equals its view of what the handler received", async () => {
    const received = new Map<string, unknown[]>();
    const register = ToolRegistry.prototype.register;
    const spy = spyOn(ToolRegistry.prototype, "register").mockImplementation(function (this: ToolRegistry, definition: ToolDefinition<unknown, unknown>) {
      // The tool's own handler is replaced by a recorder: nothing is fetched, sent, written or run.
      return register.call(this, { ...definition, handler: async (args: unknown) => { (received.get(definition.name) ?? received.set(definition.name, []).get(definition.name)!).push(args); return {}; } } as never);
    } as never);
    let tools: ToolDefinition<never, unknown>[];
    try {
      tools = everyTool();
    } finally {
      spy.mockRestore();
    }
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const rig = policyRig();
    try {
      const ctx = { threadID: "t", turnID: "u", signal: new AbortController().signal };
      for (const [name, row] of Object.entries(ROWS)) {
        const tool = byName.get(name)!;
        for (const { label, args } of variants(row)) {
          const prepared = prepareToolArguments(JSON.stringify(args), tool.schema);
          expect(prepared.error, `${name}: ${label}`).toBeNull();
          const value = prepared.value as Record<string, unknown>;
          received.set(name, []);
          await tool.handler(value as never, ctx as never);
          const got = received.get(name)![0] as Record<string, unknown>;
          expect(got, `${name}: ${label} reached the handler as another object`).toBe(value);
          expect(gateView(tool, got, rig.run as never), `${name}: ${label}`).toEqual(gateView(tool, value, rig.run as never));
          // For a field the gate itself trims, padding must not change what the gate decides.
          if (label.includes(" pad ")) expect(assessCall(policyFor(name, tool.meta), value), `${name}: ${label}`).toEqual(assessCall(policyFor(name, tool.meta), prepareToolArguments(JSON.stringify(row.args), tool.schema).value as Record<string, unknown>));
        }
      }
    } finally {
      rig.close();
    }
  });

  test("a padded judged field is refused by the validate hook, before any card", () => {
    const byName = new Map(everyTool().map((tool) => [tool.name, tool]));
    for (const [name, row] of Object.entries(ROWS)) {
      for (const field of row.judged ?? []) {
        const tool = byName.get(name)!;
        expect(tool.validate, `${name} has no validate hook`).toBeDefined();
        for (const pad of PADS) {
          expect(tool.validate!({ ...row.args, [field]: pad(String(row.args[field])) }) ?? "", `${name}.${field}`).toMatch(/must not start or end with spaces or line breaks/);
        }
      }
    }
  });

  test("a routine's domain list is checked on the value the handler gets", () => {
    const rig = policyRig({ allowedDomains: ["example.com"] } as never);
    try {
      const plain = prepareToolArguments(JSON.stringify({ url: "https://example.com/page" }), everyTool().find((tool) => tool.name === "web_fetch")!.schema).value as Record<string, unknown>;
      expect(engine.decide(rig.run, { tool: "web_fetch", args: plain, callID: "c1" }, { record: false }).action).not.toBe("refuse");
      const other = prepareToolArguments(JSON.stringify({ url: "https://evil.example/page" }), everyTool().find((tool) => tool.name === "web_fetch")!.schema).value as Record<string, unknown>;
      const refused = engine.decide(rig.run, { tool: "web_fetch", args: other, callID: "c2" }, { record: false });
      expect(refused.action).toBe("refuse");
    } finally {
      rig.close();
    }
  });
});
