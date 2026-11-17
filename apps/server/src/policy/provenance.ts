/**
 * Where a chain of work came from (Sprint 2, fix round K).
 *
 * Two facts about a chain, carried like taint is: on the run, and across every boundary that stores text (a job's payload, a
 * delegation's brief, a wake's results). Like taint they only grow: a link can mark the chain, nothing clears it, and a record that is
 * missing or cannot be read says the worst.
 *
 *  - `ownerStarted`: the chain began with the owner (their own chat turn, or a job they made themselves). A positive marker, set by
 *    the front door that knows; nothing infers it later.
 *  - `botChained`: some link of the chain was made by a bot: a job a run scheduled, or a delegation a run that was not the owner's own
 *    turn made.
 *
 * A run is the owner's own work only when both read cleanly that way. It is not modelled as a taint source: taint refuses a run its
 * protected writes, while a bot-made chain is put to the owner with a card, and must still be able to be approved.
 */
import type { RunContext } from "./types";

/** What a run's chain carries across a boundary. */
export interface Provenance {
  ownerStarted: boolean;
  botChained: boolean;
}

/** The owner's own chat turn, or a job the owner made: the start of a chain with no bot link yet. */
export const OWNER_STARTED: Provenance = { ownerStarted: true, botChained: false };

/** A chain that cannot say where it came from: no marker, and a bot's. */
export const UNKNOWN_PROVENANCE: Provenance = { ownerStarted: false, botChained: true };

/**
 * Read a stored provenance back, tolerating anything. Only an explicit `ownerStarted: true` is a marker, and only an explicit
 * `botChained: false` says no bot link was made: a missing, half-written or non-object value is the unknown chain, and a chain with no
 * marker is the unknown chain whatever else it says.
 */
export function readProvenance(value: unknown): Provenance {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ...UNKNOWN_PROVENANCE };
  const record = value as Record<string, unknown>;
  if (record.ownerStarted !== true) return { ...UNKNOWN_PROVENANCE };
  return { ownerStarted: true, botChained: record.botChained !== false };
}

/** The provenance of a run, as a plain value for a payload, a brief or a result. Flags that cannot be read pack as the unknown chain. */
export function packProvenance(run: Pick<RunContext, "ownerStarted" | "botChained"> | undefined): Provenance {
  return readProvenance(run ? { ownerStarted: run.ownerStarted, botChained: run.botChained } : undefined);
}

/** Is this run the owner's own work: a chain the owner started, with no link made by a bot? A run that cannot be read is not. */
export function isOwnerMade(run: Pick<RunContext, "ownerStarted" | "botChained"> | undefined): boolean {
  const read = packProvenance(run);
  return read.ownerStarted && !read.botChained;
}

/** What a chain is when several parts of it come together (a wake told of several tasks): the owner's only if every part is. */
export function mergeProvenance(...parts: Provenance[]): Provenance {
  if (parts.length === 0) return { ...UNKNOWN_PROVENANCE };
  return { ownerStarted: parts.every((part) => part.ownerStarted), botChained: parts.some((part) => part.botChained) };
}

/**
 * What a job this run schedules carries: a job a run schedules is made by a bot, whoever started the run, so the chain is marked.
 * The owner marker is kept as the run had it (a job's fires still belong to the request the owner began).
 */
export function scheduledProvenance(run: Pick<RunContext, "ownerStarted" | "botChained"> | undefined): Provenance {
  return { ownerStarted: packProvenance(run).ownerStarted, botChained: true };
}

/**
 * What a delegation or a handoff made by this run carries to the child, and so to the wake that reports back. The owner's own turn
 * (and a job the owner made, which runs as the owner) hands on its chain as it is. A run a bot started (a wake, a bot's brief, a fire of
 * a bot's job) makes the link itself, so the chain is marked from there on.
 */
export function handedProvenance(run: Pick<RunContext, "ownerStarted" | "botChained" | "principal"> | undefined): Provenance {
  const own = packProvenance(run);
  if (run?.principal?.kind === "owner") return own;
  return { ownerStarted: own.ownerStarted, botChained: true };
}
