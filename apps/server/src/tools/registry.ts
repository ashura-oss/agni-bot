/**
 * Tool registry. Every tool declares a schema and a timeout before it can be
 * registered; the task lane executes them through this registry only.
 *
 * The current task and retrieval captures use validated deterministic paths;
 * model-invoked tools are not enabled until the separate task runner lands.
 * Shell/files/Gmail arrive later with their approval flows.
 */
import { normalizeArgs, validateArgs } from "./validate-args";
import type { ToolMeta } from "../policy/tool-meta";
import type { RunContext } from "../policy/types";

export interface ToolContext {
  threadID: string;
  turnID: string;
  signal: AbortSignal;
  /**
   * True when this turn was started from another agent's message (a delegation
   * brief, a handoff, or a completion wake). Tools that write durable memory
   * refuse to run in that case.
   */
  peerInput?: boolean;
  /**
   * The run this call belongs to: who started it and what outside text it has read.
   * The policy engine has already judged the call; tools use it for the refusals
   * that are part of their own contract (a tainted run may not change a schedule).
   */
  run?: RunContext;
  /**
   * Agent-to-agent chain metadata. Absent for a root turn; populated for
   * delegated work so tools (notably `handoff`) can refuse or behave
   * differently inside a chain.
   */
  chain?: {
    /** 1 = root turn, 2 = first delegation, … */
    depth: number;
    /** The agent id that started the chain. */
    rootAgentID: string;
    /** The agent id currently running. */
    currentAgentID: string;
    /** Short summary passed in by the delegating agent. */
    handoffSummary: string | null;
  };
  /** Routine egress: true when a URL's host is on the run's allowlist. Absent outside routines. */
  hostAllowed?: (url: URL) => boolean;
}

export type ToolKind = "static" | "dynamic";

export interface ToolDefinition<Args = unknown, Result = unknown> {
  name: string;
  description: string;
  /** JSON-schema-shaped argument description, surfaced to the model. */
  schema: unknown;
  timeoutMs: number;
  kind?: ToolKind;
  /** What the policy engine should know about this tool when it is not in the central table (a connector tool). */
  meta?: ToolMeta;
  handler: (args: Args, ctx: ToolContext) => Promise<Result>;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition<never, unknown>>();

  /**
   * The handler registered here is the tool's own, behind a check of the
   * arguments against `schema` (after repairing what the models routinely
   * send: see `normalizeArgs`): a call that breaks the schema fails with an
   * error naming the field, and the tool's code never runs.
   */
  register<Args, Result>(definition: ToolDefinition<Args, Result>): void {
    if (this.tools.has(definition.name)) throw new Error(`tool already registered: ${definition.name}`);
    if (!(definition.timeoutMs > 0)) throw new Error(`tool must declare a positive timeout: ${definition.name}`);
    const handle = definition.handler;
    const guarded: ToolDefinition<Args, Result> = {
      ...definition,
      handler: async (args, ctx) => {
        const checked = normalizeArgs(definition.schema, args);
        if (!checked.ok) throw new Error(checked.error);
        const result = await handle(checked.args as Args, ctx);
        // A value that was clamped is said so, so the model is not misled about what ran.
        if (checked.notes.length && typeof result === "object" && result !== null && !Array.isArray(result)) {
          return { ...result, argumentNotes: checked.notes } as Result;
        }
        return result;
      },
    };
    this.tools.set(definition.name, guarded as ToolDefinition<never, unknown>);
  }

  /**
   * Why `args` would be refused for the named tool, or null when they are
   * acceptable (or the tool is unknown: that is the caller's own check).
   */
  validateArgs(name: string, args: unknown): string | null {
    const tool = this.tools.get(name);
    return tool ? validateArgs(tool.schema, args) : null;
  }

  get(name: string): ToolDefinition<never, unknown> | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition<never, unknown>[] {
    return [...this.tools.values()];
  }

  /** Get tools filtered by kind. */
  listByKind(kind: ToolKind): ToolDefinition<never, unknown>[] {
    return [...this.tools.values()].filter((tool) => (tool.kind ?? "static") === kind);
  }

  /** Intersect a persona's allowlist with what is actually registered. */
  allowlist(names: string[]): ToolDefinition<never, unknown>[] {
    return names.map((name) => this.tools.get(name)).filter((tool): tool is ToolDefinition<never, unknown> => Boolean(tool));
  }

  allowlistByKind(names: string[], kind: ToolKind): ToolDefinition<never, unknown>[] {
    return names
      .map((name) => this.tools.get(name))
      .filter((tool): tool is ToolDefinition<never, unknown> => tool !== undefined && (tool.kind ?? "static") === kind);
  }
}

export const toolRegistry = new ToolRegistry();
