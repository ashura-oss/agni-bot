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
    rootJob: input.rootJob ?? input.jobID ?? null,
    rootTurnID: input.rootTurnID ?? input.turnID,
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
  return run.taint.sources.length > 0;
}

/** Add a source the run has now read. Returns true when it is new (same kind and label read twice counts once). */
export function addTaint(run: Pick<RunContext, "taint">, source: TaintSource): boolean {
  if (run.taint.sources.some((known) => known.kind === source.kind && known.label === source.label)) return false;
  run.taint.sources.push(source);
  return true;
}

/** Take on the sources a child run (or a delegated result) carries. Returns the ones that were new. */
export function mergeTaint(run: Pick<RunContext, "taint">, sources: readonly TaintSource[] | undefined): TaintSource[] {
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

/** Newest source first, for the card. */
export function newestFirst(run: Pick<RunContext, "taint">): TaintSource[] {
  return [...run.taint.sources].reverse();
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
