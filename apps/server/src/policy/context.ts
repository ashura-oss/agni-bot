/**
 * The run context (S2-03): who is running, what it may call, and what outside
 * text it has read. It replaces the old `peerInput` boolean.
 *
 * Taint is the question "could someone other than the owner have written
 * words this run is acting on?". It starts at the front door (a peer's brief,
 * a routine's saved state, an attachment) and grows when the run reads outside
 * text (a web page, an email, a connector's answer). It never shrinks inside a
 * run. It flows down to the bots the run hands work to and back up to it with
 * their results, so a chain is as tainted as its most exposed link.
 */
import type { Database } from "bun:sqlite";
import { nowISO } from "../util/ids";
import type { PrincipalKind, RunContext, RunServices, TaintSource } from "./types";
import type { ToolMeta } from "./tool-meta";

export interface RunContextInput {
  db: Database;
  bot: string;
  botName?: string | null;
  threadID: string;
  turnID: string;
  jobID?: string | null;
  rootJob?: string | null;
  rootTurnID?: string;
  /** The refusal scope handed down from the run that scheduled this job (see `RunContext.denialRoot`). */
  denialRoot?: string;
  /** The time limit's clock. Default: the root's own (hand-built contexts), which a real run always names. */
  clockKey?: string;
  principal: { kind: PrincipalKind; from?: string };
  /** Every tool this run may call. */
  capabilities: Iterable<string>;
  /** The registry's view of the tools of this turn. */
  registry: { get(name: string): { meta?: ToolMeta } | undefined; validateArgs(name: string, args: Record<string, unknown>): string | null };
  isUnloaded?: (tool: string) => boolean;
  /** Text the owner wrote in this conversation, for the egress binding. */
  ownerText?: string[];
  unattended?: boolean;
  allowedDomains?: string[];
  /** Taint the run is born with: the principal's own, an attachment, what a parent carried down. */
  taint?: TaintSource[];
}

export function createRunContext(input: RunContextInput): RunContext {
  const { registry } = input;
  const services: RunServices = {
    db: input.db,
    validateArgs: (tool, args) => registry.validateArgs(tool, args),
    hasTool: (tool) => registry.get(tool) !== undefined,
    metaOf: (tool) => registry.get(tool)?.meta,
    isUnloaded: input.isUnloaded ?? (() => false),
    allowedDomains: input.allowedDomains,
    botName: input.botName ?? null,
  };
  const sources: TaintSource[] = [];
  const run: RunContext = {
    bot: input.bot,
    threadID: input.threadID,
    turnID: input.turnID,
    jobID: input.jobID ?? null,
    // A job that nobody delegated from is its own root; a delegated child shares its parent's (which may be no job at all).
    rootJob: input.rootJob !== undefined ? input.rootJob : input.jobID ?? null,
    rootTurnID: input.rootTurnID ?? input.turnID,
    ...(input.denialRoot ? { denialRoot: input.denialRoot } : {}),
    clockKey: input.clockKey ?? input.rootTurnID ?? input.turnID,
    principal: { ...input.principal },
    effectiveCapabilities: new Set(input.capabilities),
    taint: { sources },
    budget: { extraAllowanceUSD: 0 },
    ownerText: input.ownerText ?? [],
    unattended: input.unattended ?? false,
    services,
  };
  for (const source of input.taint ?? []) addTaint(run, source);
  return run;
}

export function isTainted(run: Pick<RunContext, "taint">): boolean {
  // A record that cannot be read is not "read nothing": it counts as tainted.
  const sources = run.taint?.sources;
  return !Array.isArray(sources) || sources.length > 0;
}

/** Add a source the run has now read. Returns true when it is new (same kind and label read twice counts once). */
export function addTaint(run: Pick<RunContext, "taint"> & { onTaint?: RunContext["onTaint"] }, source: TaintSource): boolean {
  if (run.taint.sources.some((known) => known.kind === source.kind && known.label === source.label)) return false;
  run.taint.sources.push(source);
  // Saved before anything else happens: the mark outlives a crash, a restart and an error.
  run.onTaint?.(run.taint.sources);
  return true;
}

/** The one source a record that is missing or unreadable stands for: the run cannot say what it read, so it is treated as having read outside text. */
export function unknownTaint(label = "something with no record of what it read"): TaintSource {
  return { kind: "unknown", label, at: nowISO() };
}

/**
 * Read a stored taint record, failing closed. A missing, malformed or entirely unreadable record is one
 * unknown source (tainted); only an explicit empty list means "read nothing outside". Every reader of
 * a stored record (a task row, a job payload, a wake's results, a saved session) goes through here.
 */
export function readTaint(value: unknown, label?: string): TaintSource[] {
  if (!Array.isArray(value)) return [unknownTaint(label)];
  if (value.length === 0) return [];
  const sources = unpackTaint(value);
  return sources.length > 0 ? sources : [unknownTaint(label)];
}

/** Take on the sources a child run (or a delegated result) carries. Returns the ones that were new. */
export function mergeTaint(run: Pick<RunContext, "taint"> & { onTaint?: RunContext["onTaint"] }, sources: readonly TaintSource[] | undefined): TaintSource[] {
  const added: TaintSource[] = [];
  for (const source of sources ?? []) if (addTaint(run, source)) added.push(source);
  return added;
}

/**
 * The old `peerInput`: true when the run was started by something other than
 * the owner's own turn and the tools should refuse the writes a peer's text
 * must never cause. Jobs and wakes are not peers: the taint rule governs them.
 */
export function isPeerPrincipal(run: Pick<RunContext, "principal">): boolean {
  return run.principal.kind === "peer" || run.principal.kind === "routine";
}

/** Is the run a tool call belongs to marked? False when the call has no run (a direct call in a test). */
export function ctxTainted(ctx: { run?: Pick<RunContext, "taint"> }): boolean {
  return ctx.run !== undefined && isTainted(ctx.run);
}

/** Newest source first, for the card. */
export function newestFirst(run: Pick<RunContext, "taint">): TaintSource[] {
  const sources = run.taint?.sources;
  return Array.isArray(sources) ? [...sources].reverse() : [];
}

// ---------------------------------------------------------------------------
// Carrying taint across a boundary that stores text (a job payload, a task row)
// ---------------------------------------------------------------------------

const MAX_STORED_SOURCES = 8;

/** The taint as a plain value for a payload, bounded so a stored row cannot grow without limit. */
export function packTaint(run: Pick<RunContext, "taint">): TaintSource[] {
  return run.taint.sources.slice(-MAX_STORED_SOURCES).map((source) => ({ ...source }));
}

const KINDS = new Set(["web", "email", "peer", "attachment", "mcp", "routine", "scheduled", "unknown"]);

/** Read a stored taint back, tolerating anything: a bad entry is dropped, never trusted. */
export function unpackTaint(value: unknown): TaintSource[] {
  if (!Array.isArray(value)) return [];
  const out: TaintSource[] = [];
  for (const item of value.slice(0, MAX_STORED_SOURCES)) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.kind !== "string" || !KINDS.has(record.kind) || typeof record.label !== "string") continue;
    out.push({
      kind: record.kind as TaintSource["kind"],
      label: record.label.slice(0, 160),
      ...(typeof record.tool === "string" ? { tool: record.tool.slice(0, 64) } : {}),
      at: typeof record.at === "string" ? record.at : nowISO(),
    });
  }
  return out;
}

/** Taint that a plain-text boundary (no payload field) can carry: the principal kind alone. */
export function principalTaint(kind: PrincipalKind, label: string): TaintSource | null {
  switch (kind) {
    case "peer": return { kind: "peer", label, at: nowISO() };
    case "routine": return { kind: "routine", label, at: nowISO() };
    default: return null;
  }
}
