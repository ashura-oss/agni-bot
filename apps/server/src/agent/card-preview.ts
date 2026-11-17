/**
 * What an approval card says about a call: the heading (`describeAction`) and the body (`previewAction`).
 *
 * The rule for every card: a card never shows less than what will run. Standing work (a job, a routine) is drawn from the
 * classification the engine decided (`card.standingKind`), not from a second look at the arguments, and shows the whole prompt, the
 * bot and the schedule. A call that cannot be shown whole is not shown at all: `previewAction` throws `CardNotShown`, and the
 * engine (`policy/engine.ts`) refuses the call before any card is raised.
 */
import type { Database } from "bun:sqlite";
import { clip, entry, escapeUnsafe, quoted, quotedWhole, whole } from "./card-text";
import type { ApprovalCard, StandingKind } from "../policy/types";
import { describeRecurring, isRecurringSchedule, oneShotTime } from "../policy/standing-rules";
import { ROUTINE_DEFAULTS } from "../routines/types";
import type { Preflight } from "../routines/types";
import { getRoutine } from "../stores/routines";
import { isOutsideScratch, resolveWritePath, scratchDir, writeTargetExists } from "../tools/write-file";

/** The call cannot be put on a card whole, so no card is raised for it. The message is for the model and says what to do. */
export class CardNotShown extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CardNotShown";
  }
}

/** What the preview may know besides the call: the card the engine raised, the database (a resumed routine is read from it) and the bot whose turn it is. */
export interface PreviewOptions {
  card?: ApprovalCard | undefined;
  db?: Database | undefined;
  /** The bot whose turn this is (an `agents.id`): a routine is resumed only by the bot that owns it. */
  agentID?: string | null | undefined;
}

/** An argument for display. A missing one reads as "(not given)", never "?" or "undefined". */
function shown(value: unknown, max = 400): string {
  if (value === undefined || value === null || value === "") return "(not given)";
  return escapeUnsafe(clip(typeof value === "string" ? value : JSON.stringify(value) ?? "(not given)", max));
}

/** The arguments with every long string cut in the middle (start and end kept), for the JSON view. */
function boundedArgs(value: unknown, max: number): unknown {
  if (typeof value === "string") return clip(value, max);
  if (Array.isArray(value)) return value.map((item) => boundedArgs(item, max));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, boundedArgs(item, max)]));
  return value;
}

/** The one-line heading of a card. Never throws. */
export function describeAction(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "bash": return `run shell: ${shown(String(args.command ?? ""), 400)}`;
    case "write_file": {
      const path = typeof args.path === "string" ? args.path : "";
      const exists = path !== "" && !isOutsideScratch(path, scratchDir()) && writeTargetExists(path);
      const label = !exists ? "write file" : args.append === true ? "append to existing file" : "overwrite existing file";
      return `${label}: ${shown(path)}`;
    }
    case "read_file": return `read file: ${shown(args.path)}`;
    case "memory_write": return `save memory: ${entry(String(args.text ?? ""), 80)}`;
    case "link_save": return `save link: ${shown(args.url)}`;
    case "task_create": return `add task: ${shown(args.title)}`;
    case "task_update": return `update task ${shown(args.id)}`;
    case "mail_send": return `send email to ${Array.isArray(args.to) ? shown(args.to.map((to) => entry(to)).join(", ")) : shown(args.to)}: ${entry(String(args.subject ?? ""), 80)}`;
    // A repeating job's heading is its schedule (its prompt is the body). A one-shot job's heading carries the whole prompt too.
    case "job_schedule": return isRecurringSchedule(args)
      ? `start a repeating job: ${describeRecurring(args)}`
      : `schedule one job (${describeRecurring(args)}): ${whole(args.text ?? "")}`;
    case "routine_create": return `create a routine: ${whole(args.name ?? "")}`;
    case "routine_pause": return args.enabled === true ? `resume routine ${whole(args.id ?? "")}` : `pause routine ${whole(args.id ?? "")}`;
    case "rename_agent": return args.agentId ? `rename ${shown(args.agentId)} to ${shown(args.name)}` : `rename the assistant to ${shown(args.name)}`;
    default: return `${entry(toolName, 80)}(${escapeUnsafe(clip(JSON.stringify(args), 400))})`;
  }
}

/**
 * The body of a card. Throws `CardNotShown` when the call cannot be shown whole, or when the classification the engine put on the
 * card and the call disagree.
 */
export function previewAction(toolName: string, args: Record<string, unknown>, bot = "A bot", options: PreviewOptions = {}): string {
  const kind = options.card?.standingKind;
  if (kind !== undefined) return standingPreview(kind, toolName, args, bot, options);
  // A card with no classification is still the whole card for the tools that start work on their own: never the generic view.
  if (toolName === "job_schedule") return jobPreview(isRecurringSchedule(args) ? "repeating_job" : "next_job", args, bot);
  if (toolName === "routine_create") return routineCreatePreview(args, bot);
  if (toolName === "routine_pause" && args.enabled === true) return routineResumePreview(args, bot, options);
  if (toolName === "bash") return quoted(String(args.command ?? ""), 4_000);
  if (toolName === "mail_send") return [...audienceLines(args), describeAction(toolName, args), "", quoted(String(args.body ?? ""), 4_000)].join("\n");
  if (toolName === "write_file" && typeof args.path === "string") {
    // The path the write really lands on: a relative path means under scratch,
    // and a link is followed. This is also what "always allow" would remember.
    const real = resolveWritePath(args.path);
    return `${describeAction(toolName, args)}

Resolved path: ${real === null || real === undefined ? "(cannot be resolved)" : entry(real, 1_000)}`;
  }
  return fullCall(toolName, args);
}

/**
 * Why this call cannot be shown to the owner whole, in words for the model, or null when it can. The engine asks it before it raises a
 * card (it is the same code that draws the card, so the two cannot disagree). Any failure to draw the card counts: fail closed.
 */
export function cardProblem(toolName: string, args: Record<string, unknown>, context: { bot: string; card: ApprovalCard; db: Database; agentID: string }): string | null {
  try {
    previewAction(toolName, args, context.bot, { card: context.card, db: context.db, agentID: context.agentID });
    return null;
  } catch (error) {
    return error instanceof CardNotShown ? error.message : `the owner's card for this call could not be drawn (${error instanceof Error ? entry(error.message, 120) : "unknown error"}), so it was not run`;
  }
}

/** The tool each kind of standing rule is a call of, and how it is shown. A record over every kind: a new kind cannot be added without a preview. */
const STANDING_VIEWS: Record<StandingKind, { tool: string; show: (args: Record<string, unknown>, bot: string, options: PreviewOptions) => string }> = {
  repeating_job: { tool: "job_schedule", show: (args, bot) => jobPreview("repeating_job", args, bot) },
  next_job: { tool: "job_schedule", show: (args, bot) => jobPreview("next_job", args, bot) },
  routine_create: { tool: "routine_create", show: (args, bot) => routineCreatePreview(args, bot) },
  routine_resume: { tool: "routine_pause", show: (args, bot, options) => routineResumePreview(args, bot, options) },
};

function standingPreview(kind: StandingKind, toolName: string, args: Record<string, unknown>, bot: string, options: PreviewOptions): string {
  const view = STANDING_VIEWS[kind];
  if (view === undefined || view.tool !== toolName) {
    throw new CardNotShown(`this call was classified as "${entry(kind, 40)}", which is not a call of ${entry(toolName, 80)}, so it was not shown to the owner and was not run`);
  }
  return view.show(args, bot, options);
}

/** The other arguments a call was given, named, for the line the owner reads after the call. */
function alsoGiven(args: Record<string, unknown>, known: readonly string[]): string[] {
  const others = Object.keys(args).filter((name) => !known.includes(name));
  return others.length > 0 ? ["", `Also given: ${others.map((name) => `${whole(name)} = ${whole(args[name])}`).join(", ")}`] : [];
}

/**
 * A job: who it is for, when it runs in words, and the whole prompt it will run, quoted as data (the bot wrote it, and it will run
 * without anyone reading it again). Every other argument it was given is named too.
 */
function jobPreview(kind: "repeating_job" | "next_job", args: Record<string, unknown>, bot: string): string {
  const recurring = isRecurringSchedule(args);
  if (recurring !== (kind === "repeating_job")) {
    throw new CardNotShown(`this call was classified as ${kind === "repeating_job" ? "a repeating job" : "a one-shot job"} but its schedule is ${recurring ? "a repeating one" : "a one-shot one"}, so it was not shown to the owner and was not run`);
  }
  const lines = [
    `Bot: ${entry(bot, 80)}`,
    `Runs: ${describeRecurring(args)}`,
  ];
  // The server reads the time the way `scheduleJob` does; when the bot wrote it some other way, the owner sees that too.
  if (!recurring && typeof args.at === "string" && oneShotTime(args.at) !== whole(args.at)) lines.push(`Written as: ${whole(args.at)}`);
  lines.push(
    `${entry(bot, 80)} would run this ${recurring ? "each time" : "once"}, on its own:`,
    quotedWhole(String(args.text ?? "")),
    ...alsoGiven(args, ["text", "dailyAt", "days", "everyMinutes", ...(recurring ? [] : ["at"])]),
  );
  return lines.join("\n");
}

/** What a routine does before each run, in words. */
function preflightLine(preflight: Preflight | undefined): string {
  switch (preflight?.kind) {
    case "http": return `Before each run: it fetches ${whole(preflight.url)}`;
    case "sql": return `Before each run: it runs this read-only query: ${whole(preflight.query)}`;
    case "mail": return `Before each run: it checks the ${whole(preflight.account)} mailbox for new mail`;
    default: return "Before each run: nothing (it runs on every tick)";
  }
}

/** The lines every routine view shares: when it runs, what it does first, its limits, and the whole prompt it runs. */
function routineLines(bot: string, input: { cron: unknown; timezone: unknown; preflight: Preflight | undefined; misfire: unknown; maxTokens: unknown; maxExecutionMs: unknown; prompt: unknown }): string[] {
  return [
    `Runs: ${whole(input.cron)} (${whole(input.timezone)})`,
    preflightLine(input.preflight),
    `If a run was missed: ${whole(input.misfire)}. Limits per run: ${whole(input.maxTokens)} tokens, ${whole(input.maxExecutionMs)} ms`,
    `${entry(bot, 80)} would run this each time, on its own:`,
    quotedWhole(String(input.prompt ?? "")),
  ];
}

/** A new routine: its name, when it runs, what it checks first, its limits and the whole prompt. */
function routineCreatePreview(args: Record<string, unknown>, bot: string): string {
  const preflight = (args.preflight ?? { kind: "none" }) as Preflight;
  return [
    `Bot: ${entry(bot, 80)}`,
    `Name: ${whole(args.name ?? "")}`,
    ...routineLines(bot, {
      cron: args.cron, timezone: args.timezone, preflight,
      misfire: args.misfire ?? ROUTINE_DEFAULTS.misfire, maxTokens: args.maxTokens ?? ROUTINE_DEFAULTS.maxTokens, maxExecutionMs: args.maxExecutionMs ?? ROUTINE_DEFAULTS.maxExecutionMs,
      prompt: args.prompt,
    }),
    ...alsoGiven(args, ["name", "prompt", "cron", "timezone", "preflight", "misfire", "maxTokens", "maxExecutionMs"]),
  ].join("\n");
}

/**
 * Resuming a routine: what will run is the routine as stored, not the two arguments of the call, so it is read from the database and
 * shown whole. A routine that is not there, or is another bot's, cannot be shown, and the call would fail anyway.
 */
function routineResumePreview(args: Record<string, unknown>, bot: string, options: PreviewOptions): string {
  const id = String(args.id ?? "");
  const routine = options.db ? getRoutine(options.db, id) : null;
  if (!routine || (options.agentID !== undefined && options.agentID !== null && routine.agentID !== options.agentID)) {
    throw new CardNotShown(`there is no routine with id "${entry(id, 80)}" that you can resume, so there is nothing to show the owner and nothing was run`);
  }
  return [
    `Bot: ${entry(bot, 80)}`,
    `Resumes: "${whole(routine.name)}" (${whole(routine.id)})`,
    ...routineLines(bot, { cron: routine.cron, timezone: routine.timezone, preflight: routine.preflight, misfire: routine.misfire, maxTokens: routine.maxTokens, maxExecutionMs: routine.maxExecutionMs, prompt: routine.prompt }),
  ].join("\n");
}

/** How much of a call's arguments the card shows: enough that padding cannot push anything out of sight. */
const PREVIEW_ARGS_CHARS = 4_000;
/** One string in the arguments view. */
const PREVIEW_ARG_STRING_CHARS = 1_000;

/**
 * A card for a tool that has no preview of its own: the whole call, not a cut
 * of its first and last 200 characters. Who the call reaches (recipients and
 * attendees) comes first, in plain lines, because an argument list long enough
 * to be cut would otherwise be able to hide them. A cut list also names every
 * argument and its size.
 */
function fullCall(toolName: string, args: Record<string, unknown>): string {
  const json = escapeUnsafe(JSON.stringify(boundedArgs(args, PREVIEW_ARG_STRING_CHARS), null, 2) ?? "{}", true);
  const sizes = Object.entries(args).map(([name, value]) => `${entry(name, 80)} (${(typeof value === "string" ? value : JSON.stringify(value) ?? "").length} chars)`);
  const body = json.length > PREVIEW_ARGS_CHARS ? `${clip(json, PREVIEW_ARGS_CHARS)}\n\nArguments given: ${sizes.join(", ")}` : json;
  return [...audienceLines(args), `${entry(toolName, 80)} with these arguments:`, "", body].join("\n");
}

/** Argument names that hold the people a call reaches. */
const AUDIENCE_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["to", "To"], ["cc", "Cc"], ["bcc", "Bcc"], ["attendees", "Attendees"],
  ["recipients", "Recipients"], ["emails", "Emails"], ["invitees", "Invitees"], ["guests", "Guests"], ["participants", "Participants"],
];
const AUDIENCE_SHOWN = 50;

/** The people a call reaches, one line per kind with how many there are, ahead of everything else. */
function audienceLines(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, label] of AUDIENCE_KEYS) {
    const value = args[key];
    const names = Array.isArray(value) ? value : typeof value === "string" && value ? [value] : [];
    if (names.length === 0) continue;
    const more = names.length > AUDIENCE_SHOWN ? `, … (+${names.length - AUDIENCE_SHOWN} more)` : "";
    out.push(`${label} (${names.length}): ${names.slice(0, AUDIENCE_SHOWN).map((name) => entry(name)).join(", ")}${more}`);
  }
  return out;
}
