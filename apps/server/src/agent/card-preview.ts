/**
 * What an approval card says about a call: the heading (`describeAction`) and the body (`previewAction`).
 *
 * The rule for every card: a card never shows less than what will run.
 *
 *  - The body shows every field that decides what runs, whole: a command, the content of a file, a mail's recipients, subject and
 *    body, every argument of a call the card has no view of its own for. Nothing is cut in the middle.
 *  - Standing work (a job, a routine) is drawn from the classification the engine decided (`card.standingKind`), not from a second
 *    look at the arguments, and shows the whole prompt, the bot and the schedule.
 *  - A call that cannot be shown whole (it is more than a card holds, or its classification and its arguments disagree, or it names
 *    a routine that is not there) is not shown at all: `previewAction` throws `CardNotShown`, and the engine (`policy/engine.ts`)
 *    refuses the call before any card is raised.
 *
 * The heading is a one-line summary that the client cuts again for display, so it may be shortened; the body never is. The one-shot
 * job heading carries its whole prompt anyway.
 */
import type { Database } from "bun:sqlite";
import { clip, entry, escapeUnsafe, quotedWhole, whole } from "./card-text";
import type { ApprovalCard, StandingKind } from "../policy/types";
import { describeRecurring, isRecurringSchedule, oneShotTime } from "../policy/standing-rules";
import { parseCheckPreflight } from "../routines/preflight-checks";
import { ROUTINE_DEFAULTS } from "../routines/types";
import type { Preflight } from "../routines/types";
import { getRoutine } from "../stores/routines";
import { checkSchedule } from "../jobs/schedule-check";
import { isOutsideScratch, resolveWritePath, scratchDir, writeTargetExists } from "../tools/write-file";
import { redact } from "../util/redact";

/** The most characters a card's body holds. A call whose body would be longer is not put to the owner: it is refused. */
export const CARD_BODY_MAX_CHARS = 20_000;

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

/** An argument for the one-line heading. A missing one reads as "(not given)", never "?" or "undefined". */
function shown(value: unknown, max = 400): string {
  if (value === undefined || value === null || value === "") return "(not given)";
  return escapeUnsafe(clip(typeof value === "string" ? value : JSON.stringify(value) ?? "(not given)", max));
}

/** What a file write does to the file, in words. */
function writeLabel(args: Record<string, unknown>, path: string): string {
  const exists = path !== "" && !isOutsideScratch(path, scratchDir()) && writeTargetExists(path);
  return !exists ? "write file" : args.append === true ? "append to existing file" : "overwrite existing file";
}

/** The one-line heading of a card. Never throws. */
export function describeAction(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "bash": return `run shell: ${shown(String(args.command ?? ""), 400)}`;
    case "write_file": {
      const path = typeof args.path === "string" ? args.path : "";
      return `${writeLabel(args, path)}: ${shown(path)}`;
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
 * The body of a card. Throws `CardNotShown` when the call cannot be shown whole (it is more than a card holds), or when the
 * classification the engine put on the card and the call disagree.
 */
export function previewAction(toolName: string, args: Record<string, unknown>, bot = "A bot", options: PreviewOptions = {}): string {
  const body = bodyOf(toolName, args, bot, options);
  if (body.length > CARD_BODY_MAX_CHARS) {
    throw new CardNotShown(`this call is too long for the owner to read on one card (${body.length.toLocaleString("en-US")} characters; the most a card shows is ${CARD_BODY_MAX_CHARS.toLocaleString("en-US")}), so it was not shown and was not run. Split the work into smaller calls, each short enough to read.`);
  }
  return body;
}

function bodyOf(toolName: string, args: Record<string, unknown>, bot: string, options: PreviewOptions): string {
  const kind = options.card?.standingKind;
  if (kind !== undefined) return standingPreview(kind, toolName, args, bot, options);
  // A card with no classification is still the whole card for the tools that start work on their own: never the generic view.
  if (toolName === "job_schedule") return jobPreview(isRecurringSchedule(args) ? "repeating_job" : "next_job", args, bot);
  if (toolName === "routine_create") return routineCreatePreview(args, bot);
  if (toolName === "routine_pause" && args.enabled === true) return routineResumePreview(args, bot, options);
  if (toolName === "bash") return bashPreview(args);
  if (toolName === "web_fetch" && typeof args.url === "string") return webFetchPreview(args);
  if (toolName === "run_privileged") return privilegedPreview(args);
  if (toolName === "mail_send") return mailPreview(args);
  if (toolName === "write_file" && typeof args.path === "string") return writePreview(args, args.path);
  return fullCall(toolName, args);
}

/**
 * An address as the server will use it (`new URL(...)`: the host in its punycode form, the path and query escaped), and the way it was
 * written when that is not the same. A look-alike host or an unescaped character reads as what it really is.
 */
function addressLines(lead: string, written: string): string[] {
  let resolved: string;
  try {
    resolved = new URL(written).toString();
  } catch {
    return [`${lead}${whole(written)} (this is not an address the server can read, so it would not be fetched)`];
  }
  return resolved === written ? [`${lead}${whole(resolved)}`] : [`${lead}${whole(resolved)}`, `Written as: ${whole(written)}`];
}

/** A page fetch: the address as it will be resolved, and every other argument the call was given. */
function webFetchPreview(args: Record<string, unknown>): string {
  return [...addressLines("Fetches: ", String(args.url)), ...alsoGiven(args, ["url"])].join("\n");
}

/** The command, quoted line by line, and where it runs. */
function bashPreview(args: Record<string, unknown>): string {
  const cwd = typeof args.cwd === "string" && args.cwd ? `\nWorking directory: ${whole(args.cwd)}` : "";
  return `${quotedWhole(String(args.command ?? ""))}${cwd}`;
}

/** A command run as administrator: the whole command, and the reason given for it. */
function privilegedPreview(args: Record<string, unknown>): string {
  return [quotedWhole(String(args.command ?? "")), `Purpose: ${whole(args.purpose ?? "")}`, ...alsoGiven(args, ["command", "purpose"])].join("\n");
}

/** A mail: everyone it reaches first, the mailbox it leaves from, the subject, and the whole body. */
function mailPreview(args: Record<string, unknown>): string {
  return [
    ...audienceLines(args),
    `Account: ${whole(args.account ?? "agent")}`,
    `Subject: ${whole(args.subject ?? "")}`,
    "",
    quotedWhole(String(args.body ?? "")),
    ...alsoGiven(args, ["to", "cc", "bcc", "account", "subject", "body"]),
  ].join("\n");
}

/**
 * A file write: the path as given, where it really lands (a relative path means under scratch, and a link is followed: this is also
 * what "always allow" would remember), and all of the content.
 */
function writePreview(args: Record<string, unknown>, path: string): string {
  let real: string | null | undefined;
  try { real = resolveWritePath(path); } catch { real = null; }
  const content = typeof args.content === "string" ? args.content : "";
  return [
    `${writeLabel(args, path)}: ${whole(path)}`,
    "",
    `Resolved path: ${real === null || real === undefined ? "(cannot be resolved)" : whole(real)}`,
    "",
    `Content to ${args.append === true ? "add to the end of the file" : "write"} (${content.length} characters):`,
    quotedWhole(content),
    ...alsoGiven(args, ["path", "content", "append"]),
  ].join("\n");
}

/**
 * Why this call cannot be shown to the owner whole, in words for the model, or null when it can. The engine asks it before it raises a
 * card (it is the same code that draws the card, so the two cannot disagree). Any failure to draw the card counts: fail closed.
 */
export function cardProblem(toolName: string, args: Record<string, unknown>, context: { bot: string; card: ApprovalCard; db: Database; agentID: string }): string | null {
  let body: string;
  try {
    body = previewAction(toolName, args, context.bot, { card: context.card, db: context.db, agentID: context.agentID });
  } catch (error) {
    return error instanceof CardNotShown ? error.message : `the owner's card for this call could not be drawn (${error instanceof Error ? entry(error.message, 120) : "unknown error"}), so it was not run`;
  }
  return carriesSavedSecret(describeAction(toolName, args), body) ? SAVED_SECRET_PROBLEM : null;
}

/** Why a call that carries a saved secret is not run, in words for the model. It does not repeat the secret. */
export const SAVED_SECRET_PROBLEM =
  "this call carries a saved secret; the owner cannot see it on a card, so it cannot run. Take the key, token or password out of the call and try again.";

/**
 * True when the text of a card (its heading and its body) changes under `redact()`: it holds a secret the server has saved. A card
 * shows that secret as `[redacted]`, so the owner would be approving something the card does not show: a card never shows less than
 * what will run. The call is refused instead, and a call a stored rule would let through unasked is refused the same way.
 */
export function carriesSavedSecret(heading: string, body: string): boolean {
  return redact(heading) !== heading || redact(body) !== body;
}

/**
 * The same question for a call that no card will be raised for because a stored "always allow" rule answers it. The text a card would
 * hold is drawn the same way; a call that cannot be drawn whole (too long, a routine that is not there) is judged on its arguments.
 */
export function savedSecretProblem(toolName: string, args: Record<string, unknown>, context: { bot: string; db: Database; agentID: string }): string | null {
  let body: string;
  try {
    body = previewAction(toolName, args, context.bot, { db: context.db, agentID: context.agentID });
  } catch {
    body = JSON.stringify(args) ?? "";
  }
  return carriesSavedSecret(describeAction(toolName, args), body) ? SAVED_SECRET_PROBLEM : null;
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
  // The owner is not asked about a schedule that could never be made, or to approve a time that has already gone by: the bot got it wrong,
  // and is told so, in the words the tool uses (jobs/schedule-check.ts).
  const problem = checkSchedule(args, undefined, Date.now());
  if (problem !== null) throw new CardNotShown(`${problem} (the job was not put to the owner and was not made)`);
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

/** A named check as it will run: its name and its values, with the defaults filled in. What the model gave, if it is not a check the server knows. */
function checkWords(preflight: Preflight): string {
  try {
    const check = parseCheckPreflight(preflight);
    return Object.keys(check.params).length === 0 ? whole(check.name) : `${whole(check.name)} ${whole(check.params)}`;
  } catch {
    return whole(preflight);
  }
}

/** What a routine does before each run, in words. */
function preflightLine(preflight: Preflight | undefined): string {
  switch (preflight?.kind) {
    case "http": return addressLines("Before each run: it fetches ", String(preflight.url ?? "")).join("\n");
    case "check": return `Before each run: it runs the check ${checkWords(preflight)}`;
    // Retired: a model-written query is never run (an old stored row only), so the card says what really happens.
    case "sql": return "Before each run: a model-written query, which no longer runs (the routine fails until it is given a named check)";
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

/**
 * A card for a tool that has no preview of its own (a connector's tool, a calendar call, anything else): every argument, whole, as
 * JSON. Who the call reaches (recipients and attendees) comes first, in plain lines. What a tool does with each argument is not
 * known here, so none is cut.
 */
function fullCall(toolName: string, args: Record<string, unknown>): string {
  const json = escapeUnsafe(JSON.stringify(args, null, 2) ?? "{}", true);
  return [...audienceLines(args), `${entry(toolName, 80)} with these arguments:`, "", json].join("\n");
}

/** Argument names that hold the people a call reaches. */
const AUDIENCE_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["to", "To"], ["cc", "Cc"], ["bcc", "Bcc"], ["attendees", "Attendees"],
  ["recipients", "Recipients"], ["emails", "Emails"], ["invitees", "Invitees"], ["guests", "Guests"], ["participants", "Participants"],
];

/** The people a call reaches, one line per kind with how many there are, ahead of everything else. Every one of them, whole. */
function audienceLines(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, label] of AUDIENCE_KEYS) {
    const value = args[key];
    const names = Array.isArray(value) ? value : typeof value === "string" && value ? [value] : [];
    if (names.length === 0) continue;
    out.push(`${label} (${names.length}): ${names.map((name) => whole(name)).join(", ")}`);
  }
  return out;
}
