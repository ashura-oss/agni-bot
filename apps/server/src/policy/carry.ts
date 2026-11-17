/**
 * Carrying taint across the edges of a run (S2-06): from a bot to the bot it hands
 * work to, from that bot's result back to the one that reads it, through a task
 * row, an artifact, a wake, a group room.
 *
 * Taint is information flow: another bot's words are outside text exactly when
 * that bot had read outside text. A reply from a bot that read nothing outside
 * does not mark the run that reads it. A reply from one that did marks it, and
 * the card says "read a reply from Juno", not what Juno read.
 */
import type { Database } from "bun:sqlite";
import { entry } from "../agent/card-text";
import { log } from "../log";
import { nowISO } from "../util/ids";
import { audit } from "./audit-sink";
import { addTaint, packTaint, readTaint, unknownTaint } from "./context";
import { readCapabilities } from "./narrowing";
import type { RunContext, TaintSource } from "./types";

/**
 * The run that read a bot's result takes on what that bot's run had read. `from` is the bot's
 * name, for the card; `via` the tool that brought the result in. Returns true when the run was
 * marked by this.
 */
export function carryTaint(run: Pick<RunContext, "taint" | "bot" | "turnID" | "jobID"> | undefined, from: string, sources: readonly TaintSource[], via: string): boolean {
  if (!run || sources.length === 0) return false;
  const label = entry(from, 60).replace(/\s+/g, " ").trim() || "another bot";
  return markRun(run, { kind: "peer", label, tool: via, at: nowISO() }, { carried: sources.slice(0, 5).map((source) => ({ kind: source.kind, label: source.label })) });
}

/** A note the bot kept from outside text and has now read back: what is in it is outside text again. */
export function carryNoteTaint(run: Pick<RunContext, "taint" | "bot" | "turnID" | "jobID"> | undefined, items: ReadonlyArray<{ fromOutside?: boolean }>, via: string): boolean {
  if (!run || !items.some((item) => item.fromOutside)) return false;
  return markRun(run, { kind: "unknown", label: "a note kept from outside content", tool: via, at: nowISO() });
}

/** Mark the run and write the change down. A failed audit row never un-marks the run. */
export function markRun(run: Pick<RunContext, "taint" | "bot" | "turnID" | "jobID">, source: TaintSource, extra: Record<string, unknown> = {}): boolean {
  if (!addTaint(run, source)) return false;
  try {
    audit({
      kind: "policy.taint", actor: run.bot, turnID: run.turnID, ...(run.jobID ? { jobID: run.jobID } : {}),
      detail: { kind: source.kind, label: source.label, tool: source.tool, ...extra },
    });
  } catch (error) {
    log.warn(`turn ${run.turnID}: could not record that the run read outside content: ${error instanceof Error ? error.message : String(error)}`);
  }
  return true;
}

/**
 * What a delegated task's run has read so far. Fails closed: a task with no record, an unreadable record,
 * or no such task reads as having read outside text. Only a stored empty list means it read nothing.
 */
export function taskTaint(db: Database, taskID: string | null | undefined): TaintSource[] {
  if (!taskID) return readTaint(undefined, "a result with no task behind it");
  const row = db.query<{ taint: string | null }, [string]>("SELECT taint FROM tasks WHERE id = ?").get(taskID);
  if (!row?.taint) return readTaint(undefined, "a task with no record of what it read");
  try {
    return readTaint(JSON.parse(row.taint), "a task with no record of what it read");
  } catch {
    return readTaint(undefined, "a task with no record of what it read");
  }
}

/**
 * Write down what a task's run has read. Monotonic: what was already recorded stays, whatever is
 * passed, so a later or partial save can only add. A task with no record yet takes what is passed.
 */
export function saveTaskTaint(db: Database, taskID: string, sources: readonly TaintSource[]): void {
  const row = db.query<{ taint: string | null }, [string]>("SELECT taint FROM tasks WHERE id = ?").get(taskID);
  if (!row) return;
  let merged: TaintSource[] = [...sources];
  if (row.taint) {
    try {
      const before = readTaint(JSON.parse(row.taint));
      merged = [...before, ...sources.filter((source) => !before.some((known) => known.kind === source.kind && known.label === source.label))];
    } catch {
      merged = [...sources, ...readTaint(undefined, "a task with no record of what it read")];
    }
  }
  db.run("UPDATE tasks SET taint = ? WHERE id = ?", [JSON.stringify(merged), taskID]);
}

// ---------------------------------------------------------------------------
// What a run hands on across a link
// ---------------------------------------------------------------------------

/**
 * Everything a run carries to the work it starts, as one value. It is what a job's payload, a delegation's brief, a wake and a handoff's
 * child run all hold, under these same names, so there is one place that writes it (`packCarried`) and one that reads it back
 * (`readCarried`). A link can add to what is carried or leave it; none is read from a tool's arguments, and a record that is missing or
 * cannot be read says the worst.
 */
export interface Carried {
  /** What the sending run had read from outside. Never absent: a record that is missing or unreadable is one unknown source. */
  taint: TaintSource[];
  /** The sending run's tools were cut down by whoever started it (not just by the persona). Fail closed: when unsure, true. */
  narrowed: boolean;
  /** The tools the sending run could call. `null`: the set is missing or unreadable, which cuts a narrowed or delegated run to the inert tools. */
  capabilities: string[] | null;
  /** The request the work belongs to (the refusal scope's root). Absent: the work starts a request of its own. */
  rootTurnID?: string;
  rootJob?: string | null;
  /** The refusal scope of the run that made a job, which the job keeps for good. */
  denialRoot?: string;
  /** The time limit's clock the work runs on: its parent's for a delegated child. Absent: a clock of its own. */
  clockKey?: string;
  /** The peer chain a delegation belongs to (`stores/peer-chains.ts`). */
  chainID?: string;
  /**
   * The owner's own work: a chain that began with the owner (their chat turn, or a CLI job they made) and no link a bot made. One sticky
   * bit: only a front door that knows sets it, a bot's link clears it and nothing sets it again, and anything that cannot be read is false.
   * It is not a taint source: taint refuses a run its protected writes, while a bot-made chain is put to the owner with a card.
   */
  ownerOnly: boolean;
}

/**
 * The six links a run's state crosses, and what each does to each property: `set` the link decides it, `copy` it goes on as the
 * run had it, `new` the work starts its own, `-` it does not apply.
 *
 *   property      | delegate, handoff        | schedule-once         | schedule-recurring | wake (brief -> parent)  | resume (brief -> child)
 *   --------------+--------------------------+-----------------------+--------------------+-------------------------+------------------------
 *   taint         | copy (the run's sources) | copy (even if empty)  | copy (even empty)  | set: none; each result  | set: what the task's
 *                 |                          |                       |                    | carries its own         | record says it read
 *   narrowed      | copy                     | copy                  | copy               | copy                    | copy
 *   capabilities  | copy (always a set)      | copy when narrowed    | copy when narrowed | copy (merged wakes:     | copy
 *                 |                          |                       |                    | the intersection)       |
 *   rootTurnID,   | copy                     | copy, unless the run  | new: every fire is | copy                    | copy
 *   rootJob       |                          | is the owner's chat   | a request of its   |                         |
 *                 |                          | turn (its own root)   | own                |                         |
 *   denialRoot    | copy                     | set: the run's scope  | set: the run's     | copy                    | copy
 *                 |                          |                       | scope              |                         |
 *   clockKey      | copy (the parent's       | new                   | new                | new                     | new
 *                 | clock)                   |                       |                    |                         |
 *   chainID       | set by the caller        | -                     | -                  | copy                    | copy
 *   ownerOnly     | copy from the owner's    | cleared               | cleared            | copy (merged wakes: the | copy
 *                 | own turn, else cleared   | (a bot's link)        | (a bot's link)     | owner's only if every   |
 *                 |                          |                       |                    | part is)                |
 *
 * A delegated child is always cut to `capabilities` whatever `narrowed` says (its starter is another bot); `narrowed` is the sending run's
 * own state, which a wake, a job and a resumed task pick up. The fronts that start a chain with `ownerOnly: true` are the owner's chat
 * turn (`createRunContext`) and the owner's CLI job (`jobs/owner-job.ts`); nothing else sets it.
 */
export type Link = "delegate" | "handoff" | "schedule-once" | "schedule-recurring" | "wake" | "resume";

/** What `packCarried` can be told besides the run: things only the caller knows. */
export interface PackExtra {
  /** The peer chain a delegation belongs to. */
  chainID?: string;
  /** For a resume: what the task's own record says it read. */
  taint?: readonly TaintSource[];
}

/** The sending side as `packCarried` reads it: a run, or a value already read back (a brief). */
interface Source {
  taint: TaintSource[];
  narrowed: boolean;
  capabilities: string[] | null;
  rootTurnID?: string;
  rootJob?: string | null;
  denialRoot?: string;
  clockKey?: string;
  chainID?: string;
  ownerOnly: boolean;
  /** The run was acting for the owner. A stored value has no principal: it is false. */
  principalOwner: boolean;
  /** The run was the owner's chat turn: the owner as principal with no job behind it. */
  ownersChatTurn: boolean;
  /** The refusal scope the work keeps (`policy/denials.ts`). */
  scope?: string;
}

/** A link made by something with no record of itself: everything it says is the worst. */
const noSource = (): Source => ({ taint: [unknownTaint("a link made with no record of what it had read")], narrowed: true, capabilities: null, ownerOnly: false, principalOwner: false, ownersChatTurn: false });

function isRun(from: RunContext | Carried): from is RunContext {
  return "effectiveCapabilities" in from;
}

function sourceOfRun(run: RunContext): Source {
  const sources = run.taint?.sources;
  let capabilities: string[] | null = null;
  try { capabilities = [...run.effectiveCapabilities]; } catch { capabilities = null; }
  const { rootTurnID, rootJob, denialRoot, clockKey } = run;
  const rooted = typeof rootTurnID === "string" && rootTurnID !== "";
  return {
    // A record that cannot be read is one unknown source, and a run that read nothing is an empty list.
    taint: Array.isArray(sources) ? (sources.length > 0 ? packTaint(run) : []) : [unknownTaint("a run with no record of what it had read")],
    narrowed: run.narrowed === true,
    capabilities,
    ...(rooted ? { rootTurnID, rootJob: typeof rootJob === "string" && rootJob !== "" ? rootJob : null } : {}),
    ...(typeof denialRoot === "string" && denialRoot !== "" ? { denialRoot } : {}),
    ...(typeof clockKey === "string" && clockKey !== "" ? { clockKey } : {}),
    ownerOnly: run.ownerOnly === true,
    principalOwner: run.principal?.kind === "owner",
    ownersChatTurn: run.principal?.kind === "owner" && run.jobID == null,
    ...(rooted ? { scope: typeof denialRoot === "string" && denialRoot !== "" ? denialRoot : typeof rootJob === "string" && rootJob !== "" ? rootJob : rootTurnID } : {}),
  };
}

function sourceOfCarried(carried: Carried): Source {
  return { ...carried, principalOwner: false, ownersChatTurn: false, ...(carried.denialRoot ? { scope: carried.denialRoot } : {}) };
}

/**
 * What the work a link starts must carry, given the run (or the stored value, for a wake and a resume) that starts it. The table above
 * says what each link does; `undefined` is a link made by something with no record of itself.
 */
export function packCarried(from: RunContext | Carried | undefined, link: Link, extra: PackExtra = {}): Carried {
  const src = from === undefined ? noSource() : isRun(from) ? sourceOfRun(from) : sourceOfCarried(from);
  const out: Carried = { taint: [], narrowed: src.narrowed, capabilities: src.capabilities, ownerOnly: false };
  const root = (): void => {
    if (src.rootTurnID !== undefined) { out.rootTurnID = src.rootTurnID; out.rootJob = src.rootJob ?? null; }
  };
  switch (link) {
    case "delegate":
    case "handoff":
      out.taint = src.taint.map((source) => ({ ...source }));
      root();
      if (src.denialRoot) out.denialRoot = src.denialRoot;
      if (src.clockKey) out.clockKey = src.clockKey;
      if (extra.chainID) out.chainID = extra.chainID;
      // The owner's own turn hands the chain on as it is; a run a bot started (a wake, a bot's brief, a fire of a bot's job) makes the link itself.
      out.ownerOnly = src.ownerOnly && src.principalOwner;
      break;
    case "schedule-once":
    case "schedule-recurring":
      out.taint = src.taint.map((source) => ({ ...source }));
      // A job is cut to the run's tools only when the run's were cut: an owner's job fires with everything its bot may call.
      if (!src.narrowed) out.capabilities = null;
      // A one-shot job stays in the request it was made in (its wakes are counted with it), unless the owner's chat turn made it, which is a
      // root of its own. A repeating job's every fire is a request of its own.
      if (link === "schedule-once" && !src.ownersChatTurn) root();
      if (src.scope) out.denialRoot = src.scope;
      break;
    case "wake":
      // The results carry their own taint (what the task's run read), so the wake itself starts with none.
      root();
      if (src.denialRoot) out.denialRoot = src.denialRoot;
      if (src.chainID) out.chainID = src.chainID;
      out.ownerOnly = src.ownerOnly;
      break;
    case "resume":
      out.taint = extra.taint ? extra.taint.map((source) => ({ ...source })) : [unknownTaint("a task with no record of what it read")];
      root();
      if (src.denialRoot) out.denialRoot = src.denialRoot;
      if (src.chainID) out.chainID = src.chainID;
      out.ownerOnly = src.ownerOnly;
      break;
  }
  return out;
}

/** The value as a plain object for a payload or a brief. A set of tools that cannot be read is not written (it reads back as unreadable). */
export function storedCarried(carried: Carried): Record<string, unknown> {
  const { capabilities, ...rest } = carried;
  return { ...rest, ...(capabilities !== null ? { capabilities } : {}) };
}

const isNonEmpty = (value: unknown): value is string => typeof value === "string" && value !== "";

/**
 * Read back what a payload or a brief carries, tolerating anything. Every field that is missing or cannot be read says the worst:
 * taint unknown, the tools the inert ones only, the chain a bot's. A wake's own fields are folded with each result it is told about:
 * the owner's only if every part is, cut if any part was, and then to the tools every cut part could call.
 */
export function readCarried(payload: unknown): Carried {
  const p: Record<string, unknown> = typeof payload === "object" && payload !== null && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  const results = Array.isArray(p.results) ? p.results : [];
  const isWake = isNonEmpty(p.wakeKey) && results.length > 0;
  let ownerOnly = p.ownerOnly === true;
  // `narrowed` is written by the server; a payload from before it existed said it by having a list of tools.
  let narrowed = typeof p.narrowed === "boolean" ? p.narrowed : p.capabilities !== undefined;
  let capabilities = readCapabilities(p.capabilities) ?? null;
  for (const item of isWake ? results : []) {
    const part: Record<string, unknown> = typeof item === "object" && item !== null ? item as Record<string, unknown> : {};
    ownerOnly = ownerOnly && part.ownerOnly === true;
    // Cut by any task that was, to the tools every cut task allowed; one whose set cannot be read leaves the inert tools only.
    if (typeof part.narrowed === "boolean" ? part.narrowed : part.capabilities !== undefined) {
      const allowed = readCapabilities(part.capabilities) ?? null;
      capabilities = !narrowed ? allowed : capabilities === null || allowed === null ? null : capabilities.filter((name) => allowed.includes(name));
      narrowed = true;
    }
  }
  let taint: TaintSource[];
  if (Array.isArray(p.taint)) taint = readTaint(p.taint);
  else if (p.taint !== undefined) taint = readTaint(undefined, "a job whose record of what it had read could not be read");
  // No record at all. A wake is told what its tasks read by its results, and a job starts clean; a run another bot started (a delegated child,
  // a brief), whose sender did not say what it had read, is as tainted as an unknown source.
  else if (isWake || !(isNonEmpty(p.delegationTaskID) || (typeof p.peer === "object" && p.peer !== null))) taint = [];
  else taint = [unknownTaint("a task whose sender did not say what it had read")];
  return {
    taint,
    narrowed,
    capabilities,
    ...(isNonEmpty(p.rootTurnID) ? { rootTurnID: p.rootTurnID, rootJob: isNonEmpty(p.rootJob) ? p.rootJob : null } : {}),
    ...(isNonEmpty(p.denialRoot) ? { denialRoot: p.denialRoot } : {}),
    ...(isNonEmpty(p.clockKey) ? { clockKey: p.clockKey } : {}),
    ...(isNonEmpty(p.chainID) ? { chainID: p.chainID } : {}),
    ownerOnly,
  };
}

/** The request a stored value belongs to, as a wake and a denial name it, or undefined when it starts one of its own. */
export function carriedRoot(carried: Pick<Carried, "rootTurnID" | "rootJob" | "denialRoot">): { rootTurnID: string; rootJob: string | null; denialRoot?: string } | undefined {
  if (!carried.rootTurnID) return undefined;
  return { rootTurnID: carried.rootTurnID, rootJob: carried.rootJob ?? null, ...(carried.denialRoot ? { denialRoot: carried.denialRoot } : {}) };
}
