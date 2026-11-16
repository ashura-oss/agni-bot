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
 * Waits for S2-01: tool metadata is expected as `meta` on the tool definition
 * (the frozen `ToolMeta` type in `policy/tool-meta.ts`) or from
 * `policy/metadata.ts`. `metaOf` below is the single place that reads it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { DEFAULT_AGENT_TOOLS, IMPLICIT_AGENT_TOOLS, PERSONAS } from "../../src/agent/personas";
import { openDatabase } from "../../src/db";
import type { ToolClass, ToolMeta } from "../../src/policy/tool-meta";
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
import { loadPolicyModule } from "./support";

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

/** The metadata of a tool, wherever Sprint 2 puts it: on the definition, or from `policy/metadata.ts`. */
async function metaOf(definition: ToolDefinition<never, unknown>): Promise<ToolMeta | undefined> {
  const own = (definition as { meta?: ToolMeta }).meta;
  if (own) return own;
  const resolve = await metadataResolver();
  return resolve?.(definition.name);
}

type Resolver = (name: string) => ToolMeta | undefined;

async function metadataResolver(): Promise<Resolver | undefined> {
  let module: Record<string, unknown>;
  try {
    module = await loadPolicyModule("metadata");
  } catch {
    return undefined;
  }
  for (const key of ["metaFor", "toolMeta", "getToolMeta", "metadataFor", "resolveToolMeta", "metaOf", "toolMetaFor"]) {
    const candidate = module[key];
    if (typeof candidate === "function") return candidate as Resolver;
  }
  const table = module.TOOL_META ?? module.toolMeta ?? module.META;
  if (table instanceof Map) return (name) => table.get(name) as ToolMeta | undefined;
  if (table && typeof table === "object") return (name) => (table as Record<string, ToolMeta>)[name];
  return undefined;
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

// waits for S2-1a (S2-01: `meta` on every tool, `policy/metadata.ts`)
describe("INV-03 every registered tool has a class and a tier", () => {
  test("none is missing metadata, and each has a known class and a tier from 0 to 3", async () => {
    const problems: string[] = [];
    for (const tool of everyTool()) {
      const meta = await metaOf(tool);
      if (!meta) { problems.push(`${tool.name}: no metadata`); continue; }
      if (!Array.isArray(meta.classes) || meta.classes.length === 0) problems.push(`${tool.name}: no classes`);
      else for (const entry of meta.classes) if (!CLASSES.includes(entry)) problems.push(`${tool.name}: unknown class "${entry}"`);
      if (![0, 1, 2, 3].includes(meta.tier)) problems.push(`${tool.name}: tier ${String(meta.tier)} is not 0 to 3`);
    }
    expect(problems, "tools without a class and tier (S2-01)").toEqual([]);
  });
});

// waits for S2-1a (S2-01)
describe("INV-03 the tools that matter are classed as what they are", () => {
  const expectations: Array<{ tools: string[]; cls: ToolClass; why: string }> = [
    { tools: ["web_search", "web_fetch", "deep_research", "mail_search", "mail_read"], cls: "untrusted-reader", why: "text an outsider can write" },
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
        const meta = tool ? await metaOf(tool) : undefined;
        if (!meta) wrong.push(`${name}: no metadata`);
        else if (!meta.classes.includes(cls)) wrong.push(`${name}: classes are [${meta.classes.join(", ")}]`);
      }
      expect(wrong).toEqual([]);
    });
  }

  test("shell is tier 3, a send from a mailbox is at least tier 2, the free helpers are tier 0", async () => {
    const byName = new Map(everyTool().map((tool) => [tool.name, tool]));
    const tier = async (name: string): Promise<number | undefined> => (await metaOf(byName.get(name)!))?.tier;
    expect(await tier("bash"), "bash").toBe(3);
    expect(await tier("run_privileged"), "run_privileged").toBe(3);
    expect((await tier("mail_send")) ?? -1, "mail_send").toBeGreaterThanOrEqual(2);
    for (const name of ["say", "load_tools", "memory_search"]) expect(await tier(name), name).toBe(0);
  });
});

// waits for S2-1a (S2-01: resource extractors)
describe("INV-03 effectors say what they touch", () => {
  test("mail_send names its recipients, web_fetch its host, write_file its path", async () => {
    const byName = new Map(everyTool().map((tool) => [tool.name, tool]));
    const resourcesOf = async (name: string, args: Record<string, unknown>) => (await metaOf(byName.get(name)!))?.resources?.(args) ?? [];
    const mail = await resourcesOf("mail_send", { to: ["a@example.org", "b@example.org"], subject: "s", body: "b" });
    expect(mail.map((entry) => entry.value).join(" "), "mail_send did not name its recipients").toContain("a@example.org");
    expect(mail.every((entry) => entry.kind === "recipient"), "mail_send resources are not recipients").toBe(true);
    const fetchRes = await resourcesOf("web_fetch", { url: "http://203.0.113.9/path?q=1" });
    expect(fetchRes.map((entry) => entry.value).join(" "), "web_fetch did not name its host").toContain("203.0.113.9");
    const write = await resourcesOf("write_file", { path: "/tmp/agni-x/notes.txt", content: "x" });
    expect(write.map((entry) => entry.value).join(" "), "write_file did not name its path").toContain("notes.txt");
  });
});

// waits for S2-1a (S2-01: unknown tool tier 3, `mcp_` prefix tier 2)
describe("INV-03 a tool the policy does not know is tier 3; an MCP tool is tier 2", () => {
  test("an unknown name resolves to tier 3 (fail closed)", async () => {
    const resolve = await metadataResolver();
    if (!resolve) throw new Error("no metadata resolver in policy/metadata.ts yet (waits for S2-01)");
    expect(resolve("a_tool_nobody_registered")?.tier, "an unknown tool did not gate at tier 3").toBe(3);
    expect(resolve("")?.tier).toBe(3);
    expect(resolve("MCP_lookalike")?.tier, "a name that only looks like an MCP tool got an MCP tier").toBe(3);
  });

  test("an mcp_ tool gets tier 2 by its prefix, whatever it calls itself", async () => {
    const resolve = await metadataResolver();
    if (!resolve) throw new Error("no metadata resolver in policy/metadata.ts yet (waits for S2-01)");
    for (const name of ["mcp_github_create_issue", "mcp_files_read", "mcp_x"]) expect(resolve(name)?.tier, name).toBe(2);
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
    const meta = await metaOf(tool as ToolDefinition<never, unknown>);
    expect(meta?.tier, "an MCP tool's own claim lowered its tier").toBeGreaterThanOrEqual(2);
  });
});
