/**
 * What every tool is, in one table (S2-01). The engine reads nothing else to
 * decide how a tool is treated: a tool with no row here is unknown and is
 * handled as the most dangerous kind (tier 3). A test fails when a registered
 * tool has no row, so a new tool cannot slip in unclassified.
 *
 * Each row uses `ToolMeta` from `tool-meta.ts` (the frozen shape) and adds the
 * parts the policy needs that depend on the call itself: how risky *this* call
 * is (`assess`), what a result taints the run with (`taint`), and whether the
 * tool changes the bots, schedules or rules (`protectedWrite`).
 *
 * MCP tools (`mcp_` prefix) get one default: an untrusted reader and an
 * effector at tier 2, asked every time unless the owner trusted that tool
 * (`MCP_FREE_TOOLS`, read only, until Sprint 3 gives connector tools their own
 * `meta`). A tool definition may carry its own `meta`, which wins.
 */
import { MCP_FREE_TOOLS } from "../plugins/mcp";
import { entry } from "../agent/card-text";
import { isReadOnlyCommand } from "../tools/bash";
import { isOutsideScratch, scratchDir, writeTargetExists } from "../tools/write-file";
import type { CallAssessment, RiskKind, TaintKind, TaintSource } from "./types";
import type { ToolClass, ToolMeta, ToolResource, ToolTier } from "./tool-meta";
import { commandOperation, commandResources, hostResource, pathResource, recipientResources } from "./resources";

type Args = Record<string, unknown>;

export interface TaintedBy {
  kind: TaintKind;
  /** Only some calls bring outside text in (a shell command that can reach the network); absent means every call. */
  when?: (args: Args) => boolean;
  /** One short line naming what was read. Cleaned for display by the caller. */
  label: (args: Args, result: unknown) => string;
}

export interface ToolPolicy extends ToolMeta {
  /**
   * The tool changes the bots, schedules, rules or connector setup. A run that
   * has read outsider text may not use it at all (S2-05).
   */
  protectedWrite?: boolean;
  /** This tool's result is outsider text: it taints the run that reads it. */
  taintedBy?: TaintedBy;
  /** What this particular call is, when that differs from the tool's defaults. */
  assess?: (args: Args) => Partial<CallAssessment>;
}

const clean = (value: unknown, max = 100): string => entry(typeof value === "string" ? value : String(value ?? ""), max).replace(/\s+/g, " ").trim();

const readOnly = (classes: ToolClass[], extra: Partial<ToolPolicy> = {}): ToolPolicy => ({ classes, tier: 0, ...extra });
const local = (extra: Partial<ToolPolicy> = {}): ToolPolicy => ({ classes: ["effector"], tier: 0, ...extra });

/** Where a fetched page came from: host and path, never the query string (it can carry data and is noise). */
export function pageLabel(url: unknown): string {
  if (typeof url !== "string") return "a web page";
  try {
    const parsed = new URL(url);
    return clean(`${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`);
  } catch {
    return "a web page";
  }
}

const fromWeb = (label: TaintedBy["label"]): TaintedBy => ({ kind: "web", label });
const isOwnAccount = (args: Args): boolean => args.account === undefined || args.account === null || args.account === "agent";

/** A write to a file: a new file in scratch is free; changing one that exists asks; outside scratch is out of the sandbox. */
function assessWrite(args: Args): Partial<CallAssessment> {
  const path = typeof args.path === "string" ? args.path : "";
  const resources = path ? [pathResource(path)] : [];
  if (isOutsideScratch(path, scratchDir())) return { tier: 2, risk: "irreversible", asks: true, operation: "change", resources };
  if (writeTargetExists(path)) return { tier: 1, risk: "undoable", asks: true, operation: "change", resources };
  return { tier: 0, risk: "undoable", asks: false, operation: "change", resources };
}

/** A shell call: one read-only command inside scratch is free, anything else asks at tier 3. */
function assessShell(args: Args): Partial<CallAssessment> {
  const command = String(args.command ?? "");
  const cwd = typeof args.cwd === "string" && args.cwd ? args.cwd : undefined;
  const base = cwd ?? scratchDir();
  const resources = commandResources(command, base);
  if (isReadOnlyCommand(command, cwd)) return { tier: 0, risk: "command", asks: false, operation: "read", resources };
  return { tier: 3, risk: "command", asks: true, operation: commandOperation(command), resources };
}

/** A send from the agent's own mailbox or calendar is free in an untainted run (D1); from the owner's it asks. */
function assessSend(args: Args): Partial<CallAssessment> {
  const destinations: ToolResource[] = recipientResources(args);
  const own = isOwnAccount(args);
  return { tier: own ? 0 : 2, risk: "egress", asks: !own, egress: "send", destinations, resources: destinations, operation: "send" };
}

function assessFetch(args: Args): Partial<CallAssessment> {
  const destinations = hostResource(args.url);
  return { tier: 0, risk: "egress", asks: false, egress: "fetch", destinations, resources: destinations, operation: "send" };
}

const MCP_POLICY_BASE: ToolPolicy = { classes: ["untrusted-reader", "effector"], tier: 2 };

/**
 * The table. Keyed by tool name. Comments say why a row is what it is only
 * where that is not obvious from the tool's name.
 */
export const TOOL_POLICY: Readonly<Record<string, ToolPolicy>> = {
  // Talking to the owner. Nothing leaves the app.
  ask: readOnly(["inert"]),
  say: readOnly(["inert"]),
  request_owner_input: readOnly(["inert"]),
  draft_email: readOnly(["inert"]),
  // Only unlocks tools already on the bot's allowlist; each of those still goes through the engine.
  load_tools: readOnly(["inert"]),
  rename_agent: local({ protectedWrite: true }),

  // The bot's own memory, notes and links. Reads are private; writes are local.
  memory_search: readOnly(["private-reader"]),
  transcript_search: readOnly(["private-reader"]),
  recall_fact: readOnly(["private-reader"]),
  get_fact: readOnly(["private-reader"]),
  links_search: readOnly(["private-reader"]),
  expand: readOnly(["private-reader"]),
  skills_list: readOnly(["private-reader"]),
  skills_load: readOnly(["private-reader"]),
  skills_resource: readOnly(["private-reader"]),
  tasks_list: readOnly(["private-reader"]),
  job_list: readOnly(["private-reader"]),
  routine_list: readOnly(["private-reader"]),
  scratch_read: readOnly(["private-reader"]),
  memory_write: local(),
  remember_fact: local(),
  // Forgetting what the owner told the bot is a change a page must not be able to cause.
  forget_fact: local({ protectedWrite: true }),
  task_create: local(),
  task_update: local(),
  task_cancel: local(),
  scratch_append: local(),
  // Opens the link to read its title: a request that leaves the app.
  link_save: local({ assess: assessFetch }),
  // Renders the whole conversation, tool results included, into a page anyone with the link can open.
  share_thread: { classes: ["private-reader", "effector"], tier: 0, assess: () => ({ egress: "send", risk: "egress", operation: "send" }) },

  // The owner's files. Confined to scratch by the tools themselves.
  read_file: readOnly(["private-reader"], { resources: (args) => (typeof args.path === "string" ? [pathResource(args.path)] : []) }),
  grep: readOnly(["private-reader"]),
  glob: readOnly(["private-reader"]),
  write_file: { classes: ["effector"], tier: 1, assess: assessWrite, resources: (args) => (typeof args.path === "string" ? [pathResource(args.path)] : []) },
  // What an approved command prints can be a web page (curl) or a file someone else wrote: outside text. A read-only command in scratch is not.
  bash: {
    classes: ["effector", "private-reader"], tier: 3, assess: assessShell,
    taintedBy: { kind: "unknown", when: (args) => !isReadOnlyCommand(String(args.command ?? ""), typeof args.cwd === "string" && args.cwd ? args.cwd : undefined), label: (args) => `output of: ${clean(args.command, 60)}` },
  },
  run_privileged: {
    classes: ["effector", "private-reader"], tier: 3,
    taintedBy: { kind: "unknown", label: (args) => `output of: ${clean(args.command, 60)}` },
  },

  // Outside text comes in through these.
  web_search: readOnly(["untrusted-reader"], { taintedBy: fromWeb((args) => `search: ${clean(args.query, 60)}`) }),
  deep_research: readOnly(["untrusted-reader"], { taintedBy: fromWeb((args) => `research: ${clean(args.query, 60)}`) }),
  web_fetch: {
    classes: ["untrusted-reader"], tier: 0, assess: assessFetch,
    resources: (args) => hostResource(args.url),
    taintedBy: fromWeb((args) => pageLabel(args.url)),
  },
  mail_search: readOnly(["untrusted-reader", "private-reader"], { taintedBy: { kind: "email", label: (args) => `mail search: ${clean(args.query, 60)}` } }),
  mail_read: readOnly(["untrusted-reader", "private-reader"], {
    taintedBy: {
      kind: "email",
      label: (_args, result) => {
        const record = typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {};
        const from = typeof record.from === "string" ? `from ${clean(record.from, 60)}` : "an email";
        return typeof record.subject === "string" && record.subject ? `${from}, "${clean(record.subject, 60)}"` : from;
      },
    },
  }),
  calendar_list: readOnly(["untrusted-reader", "private-reader"], { taintedBy: { kind: "unknown", label: () => "calendar events" } }),
  drive_search: readOnly(["untrusted-reader", "private-reader"], { taintedBy: { kind: "attachment", label: (args) => `Drive search: ${clean(args.query, 60)}` } }),
  drive_read: readOnly(["untrusted-reader", "private-reader"], {
    taintedBy: { kind: "attachment", label: (_args, result) => (typeof result === "object" && result !== null && typeof (result as { name?: unknown }).name === "string" ? clean((result as { name: string }).name, 80) : "a Drive file") },
  }),

  // Mail and calendar writes: free on the agent's own account when nothing outside has been read.
  mail_send: { classes: ["effector"], tier: 2, assess: assessSend, resources: recipientResources },
  calendar_create: { classes: ["effector"], tier: 2, assess: assessSend, resources: recipientResources },
  calendar_update: { classes: ["effector"], tier: 2, assess: assessSend, resources: recipientResources },

  // Other bots. What they hand back is another bot's text: it marks the run that reads it only when that bot's own run had read
  // outside text, so these tools carry the taint themselves (policy/carry.ts) instead of marking by name.
  handoff: local({ classes: ["effector", "untrusted-reader"] }),
  delegate_task: local({ classes: ["effector", "untrusted-reader"] }),
  delegate_wait: readOnly(["untrusted-reader"]),
  task_status: readOnly(["untrusted-reader"]),
  read_artifact: readOnly(["untrusted-reader", "private-reader"]),

  // Changing the bots, schedules and routines: never from a run that has read outside text.
  create_agent: local({ protectedWrite: true }),
  update_agent: local({ protectedWrite: true }),
  job_schedule: local({ protectedWrite: true }),
  job_cancel: local({ protectedWrite: true }),
  routine_create: local({ protectedWrite: true }),
  routine_pause: local({ protectedWrite: true }),
  routine_delete: local({ protectedWrite: true }),
};

/** The policy row for a tool, or null when it is not in the table and not an MCP tool. */
export function policyFor(tool: string, own?: ToolMeta): ToolPolicy | null {
  if (own) return { ...own };
  const row = TOOL_POLICY[tool];
  if (row) return row;
  if (tool.startsWith("mcp_")) return mcpPolicy(tool);
  return null;
}

/** An MCP tool: asks every time unless the owner trusted it. A trusted one still taints the run, because its result is outside text. */
function mcpPolicy(tool: string): ToolPolicy {
  const free = MCP_FREE_TOOLS.has(tool);
  return {
    ...MCP_POLICY_BASE,
    taintedBy: { kind: "mcp", label: () => `results from ${clean(tool.replace(/^mcp_/, ""), 60)}` },
    assess: () => ({ tier: free ? 0 : 2, asks: !free, risk: "either", egress: free ? "none" : "send" }),
  };
}

/** Anything not in the table: the most dangerous kind. */
const UNKNOWN_POLICY: ToolPolicy = { classes: ["untrusted-reader", "private-reader", "effector"], tier: 3 };

const DEFAULT_RISK: Record<ToolTier, RiskKind> = { 0: "undoable", 1: "undoable", 2: "either", 3: "command" };

/** What this call is, with defaults filled in from the tool's row. */
export function assessCall(policy: ToolPolicy | null, args: Args): CallAssessment {
  const row = policy ?? UNKNOWN_POLICY;
  const tier = row.tier;
  const base: CallAssessment = {
    tier,
    risk: DEFAULT_RISK[tier],
    asks: tier >= 1,
    egress: "none",
    destinations: [],
    resources: row.resources?.(args) ?? [],
    operation: row.classes.includes("effector") ? "change" : "read",
  };
  return { ...base, ...(row.assess?.(args) ?? {}) };
}

/** Would a run that has read nothing outside be asked about this call? The engine's answer without a run, for the checks that have none (a job retry deciding whether it already acted). */
export function asksWhenClean(tool: string, args: Args, own?: ToolMeta): boolean {
  return assessCall(policyFor(tool, own), args).asks;
}

/** The taint a result brings, or null when the tool's result is not outside text. */
export function taintFrom(policy: ToolPolicy | null, tool: string, args: Args, result: unknown, at: string): TaintSource | null {
  const by = policy?.taintedBy;
  if (!by || by.when?.(args) === false) return null;
  return { kind: by.kind, label: by.label(args, result) || tool, tool, at };
}

/** Tool names with no row in the table (MCP tools excepted). The metadata test fails when this is not empty. */
export function toolsMissingMetadata(names: Iterable<string>): string[] {
  return [...names].filter((name) => !policyFor(name));
}
