/**
 * `create_agent` — an agent making its own agent.
 *
 * The owner asks in chat for a bot, and the agent builds it: a persona (name,
 * role, prompt, tools, color) registered into the live roster, plus a durable
 * row so the new agent can be renamed and its prompt survives restarts. The
 * roster frame goes out the same turn, so the bot appears in the app at once.
 */
import type { Database } from "bun:sqlite";
import type { ServerFrameBody } from "@agni/protocol";
import { personaInfo, mentionRoster, getPersona, DEFAULT_AGENT_TOOLS, IMPLICIT_AGENT_TOOLS, MEMORY_WRITING_TOOLS } from "../agent/personas";
import { createAgentPersona } from "../agent/creation";
import { nowISO } from "../util/ids";
import { MAX_AGENT_NAME_CHARS } from "../agent/identity";
import { CLOSURE_WORDING_REFUSAL, closureWording } from "../agent/closure";
import type { ToolRegistry } from "./registry";

export interface CreateAgentToolDeps {
  db: Database;
  emit: (frame: ServerFrameBody) => void;
}

export function registerCreateAgentTool(registry: ToolRegistry, deps: CreateAgentToolDeps): void {
  if (registry.get("create_agent")) return;
  registry.register({
    name: "create_agent",
    description:
      "Create a new agent with its own name, role, prompt, and tools, and add it to the app. " +
      "Use it when the user asks you to make a new agent or bot, or to spin up a helper for a job. " +
      "The new agent appears in the app right away and can be selected, renamed, and handed work " +
      "like any other. Give it a system prompt that is its personality and its job.",
    kind: "static",
    schema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: MAX_AGENT_NAME_CHARS, description: "The new agent's display name." },
        id: { type: "string", minLength: 1, maxLength: 64, description: `Optional id in lowercase (e.g. 'friday'). A slug of the name is used if omitted.` },
        role: { type: "string", maxLength: 120, description: "One line describing what this agent does." },
        prompt: { type: "string", minLength: 1, maxLength: 8_000, description: "The new agent's system prompt — its personality and job." },
        color: { type: "string", description: "Optional hex color (e.g. '#e05252'). A color is picked if omitted." },
        tools: { type: "array", items: { type: "string" }, description: "Tool names the new agent may use." },
        memoryScope: { type: "string", enum: ["read", "readwrite"], description: "Whether the agent may write user-scope memory. Default read-only." },
        visibility: { type: "string", enum: ["private", "summary", "shared"], description: "What other agents may see of this agent's work. private = a receipt only, summary = one line, shared = full text. Default summary." },
      },
      required: ["name", "prompt"],
      additionalProperties: false,
    },
    timeoutMs: 2_000,
    handler: async (args: Record<string, unknown>, ctx) => {
      if (ctx.peerInput) return { error: "not done: this turn started from another agent's message" };
      if ([args.name, args.role, args.prompt].some((text) => typeof text === "string" && closureWording(text))) return { error: CLOSURE_WORDING_REFUSAL };
      const db = deps.db;
      const known = registry.list().map((tool) => tool.name);
      // M19: a new bot never exceeds its creator's tools or memory scope.
      const creator = getPersona(ctx.chain?.currentAgentID ?? "");
      if (!creator) return { error: "not done: unknown calling agent" };
      // The creator's MCP wildcard stands for every MCP tool it can reach, so
      // it can pass the wildcard (or one named MCP tool) on; nothing else.
      const creatorHas = (tool: string): boolean =>
        creator.tools.includes(tool) || (tool.startsWith("mcp_") && creator.tools.includes("mcp_*"));
      const isKnown = (tool: string): boolean => known.includes(tool) || tool === "mcp_*";
      const asked = Array.isArray(args.tools) ? [...new Set(args.tools.map((tool) => String(tool)))] : undefined;
      // `say`, `ask` and the like come with every bot: naming one is no grant.
      const wanted = asked?.filter((tool) => !IMPLICIT_AGENT_TOOLS.has(tool));
      const grantable = creator.tools.filter(isKnown);
      // An unknown name is an error, never a silent drop: a bot that comes
      // back without the tool the creator thought it gave is a worse failure
      // than a refusal that says what to fix.
      const unknown = (wanted ?? []).filter((tool) => !isKnown(tool));
      if (unknown.length > 0) {
        return { error: `not done: unknown tool names: ${unknown.join(", ")}. Tools you may grant: ${grantable.join(", ") || "none"}` };
      }
      const over = (wanted ?? []).filter((tool) => !creatorHas(tool));
      if (over.length > 0) return { error: `not done: you cannot grant tools you lack: ${over.join(", ")}` };
      if (args.memoryScope === "readwrite" && creator.memoryScope !== "readwrite") {
        return { error: "not done: you cannot grant write memory you lack" };
      }
      const memoryScope = args.memoryScope === "readwrite" ? "readwrite" : "read";
      if (asked && asked.length > 0 && (wanted ?? []).length === 0) {
        return { error: "not done: name at least one tool beyond the ones every bot already has, or leave tools out for the defaults" };
      }
      if (memoryScope === "read" && wanted && wanted.length > 0 && wanted.every((tool) => MEMORY_WRITING_TOOLS.has(tool))) {
        return { error: `not done: ${wanted.join(", ")} write memory and this bot's memoryScope is read; set memoryScope to readwrite (you must hold it) or name other tools` };
      }
      // No tools named: the defaults, cut down to what the creator holds.
      const tools = wanted && wanted.length > 0 ? wanted : DEFAULT_AGENT_TOOLS.filter((tool) => creatorHas(tool));
      if (tools.length === 0) return { error: "not done: no tools to give the new agent" };
      const created = createAgentPersona(
        db,
        {
          name: String(args.name ?? ""),
          id: typeof args.id === "string" ? args.id : undefined,
          role: typeof args.role === "string" ? args.role : undefined,
          prompt: String(args.prompt ?? ""),
          color: typeof args.color === "string" ? args.color : undefined,
          tools,
          memoryScope,
          visibility:
            typeof args.visibility === "string"
              ? (args.visibility as "private" | "summary" | "shared")
              : undefined,
        },
        // The creator ceiling above already limited the names to what it holds.
        [...known, "mcp_*", ...DEFAULT_AGENT_TOOLS],
      );
      deps.emit({ type: "agents.update", agents: personaInfo(db), mentions: mentionRoster(db) });

      return {
        id: created.id,
        name: created.name,
        role: created.role,
        color: created.color,
        tools: created.tools,
        memoryScope: created.memoryScope,
        visibility: created.visibility,
        ...(created.droppedTools.length > 0
          ? {
            droppedTools: created.droppedTools,
            note: `${created.droppedTools.join(", ")} write memory, and this bot's memoryScope is read, so it was not given ` +
              "(set memoryScope to readwrite to grant it; you must hold readwrite yourself).",
          }
          : {}),
        promptChars: created.promptChars,
      };
    },
  });
}
