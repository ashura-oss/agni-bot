import type { Database } from "bun:sqlite";
import { loadConfig } from "../config";
import { openDatabaseForCLI } from "../db";
import { setAllPaused } from "../policy/pause";
import { SqliteAuditSink, installAuditSink, verifyAuditChain } from "../stores/audit";
import { MAX_ROOT_JOB_WALL_MS, getRunCaps, setRunCaps, type RunCaps } from "../stores/policy-settings";
import type { CommandTable } from "./command-table";

/** What `agni audit verify` prints, and the exit code it ends with (0 intact, 1 altered). */
export function auditVerifyReport(db: Database): { code: 0 | 1; lines: string[] } {
  const verdict = verifyAuditChain(db);
  if (verdict.ok) {
    return { code: 0, lines: [`Audit log OK: ${verdict.events} event${verdict.events === 1 ? "" : "s"}, chain intact.`] };
  }
  return {
    code: 1,
    lines: [
      `Audit log FAILED: ${verdict.reason}`,
      ...(verdict.brokenAt === null ? [] : [`First row that does not fit: ${verdict.brokenAt}`]),
      `Checked ${verdict.events} event${verdict.events === 1 ? "" : "s"} before stopping.`,
    ],
  };
}

/** Pause or resume every bot from the command line; the words match the app's. */
export function pauseReport(db: Database, paused: boolean): string {
  installAuditSink(db);
  setAllPaused(db, paused, { actor: "cli" });
  return paused ? "All bots paused. Nothing new will start." : "Bots resumed.";
}

/** What `agni policy caps` prints: the three run limits, in the owner's words. */
export function capsReport(db: Database): string[] {
  const caps = getRunCaps(db);
  const plural = (count: number, one: string, many: string): string => (count === 1 ? one : many);
  const minutes = caps.rootJobWallMs / 60_000;
  const time = Number.isInteger(minutes) ? `${minutes} ${plural(minutes, "minute", "minutes")}` : `${Math.round(caps.rootJobWallMs / 1000)} seconds`;
  return [
    "Run limits:",
    `  Time limit           ${time} per request (the owner's waiting time is not counted)`,
    `  Delegations          ${caps.maxConcurrentDelegations} ${plural(caps.maxConcurrentDelegations, "delegation", "delegations")} at once under one request`,
    `  Self-scheduled jobs  ${caps.maxSelfScheduledJobsPerBot} ${plural(caps.maxSelfScheduledJobsPerBot, "self-scheduled job", "self-scheduled jobs")} per bot`,
  ];
}

const CAPS_USAGE = "usage: agni policy caps [set --wall-minutes N --delegations N --self-scheduled N]";

const CAPS_FLAGS: Record<string, { name: keyof RunCaps; scale: number }> = {
  "--wall-minutes": { name: "rootJobWallMs", scale: 60_000 },
  "--delegations": { name: "maxConcurrentDelegations", scale: 1 },
  "--self-scheduled": { name: "maxSelfScheduledJobsPerBot", scale: 1 },
};

/**
 * Read the words after `policy caps set`: each flag once, each with a positive whole number (digits only, so no sign,
 * fraction, exponent or hex). Minutes become the milliseconds the limit is kept in. Anything else is an error that changes nothing.
 */
export function parseCapsSet(args: string[]): { caps: Partial<RunCaps> } | { error: string } {
  const caps: Partial<RunCaps> = {};
  for (let at = 0; at < args.length; at += 1) {
    const word = args[at] as string;
    const equals = word.startsWith("--") ? word.indexOf("=") : -1;
    const flag = equals > 0 ? word.slice(0, equals) : word;
    const spec = Object.hasOwn(CAPS_FLAGS, flag) ? CAPS_FLAGS[flag] : undefined;
    if (!spec) return { error: word.startsWith("--") ? `unknown option ${flag}` : `unexpected "${word}"` };
    if (Object.hasOwn(caps, spec.name)) return { error: `${flag} was given twice` };
    const value = equals > 0 ? word.slice(equals + 1) : args[(at += 1)];
    const count = value !== undefined && /^[1-9]\d*$/.test(value) ? Number(value) : Number.NaN;
    if (!Number.isSafeInteger(count * spec.scale)) return { error: `${flag} must be a positive whole number (got ${value === undefined ? "nothing" : JSON.stringify(value)})` };
    if (spec.name === "rootJobWallMs" && count * spec.scale > MAX_ROOT_JOB_WALL_MS) return { error: `${flag} must be at most ${MAX_ROOT_JOB_WALL_MS / 60_000} (7 days)` };
    caps[spec.name] = count * spec.scale;
  }
  return Object.keys(caps).length > 0 ? { caps } : { error: "give at least one of --wall-minutes, --delegations, --self-scheduled" };
}

/** `agni policy caps set ...`: the change goes on the audit record first (a log that is down stops it), then is made. */
export function setCapsReport(db: Database, args: string[]): { code: 0 | 1; lines: string[] } {
  const parsed = parseCapsSet(args);
  if ("error" in parsed) return { code: 1, lines: [`Not changed: ${parsed.error}.`, CAPS_USAGE] };
  const before = getRunCaps(db);
  try {
    // One step: a change that cannot be written leaves no record that says it was made.
    db.transaction(() => {
      new SqliteAuditSink(db).record({ kind: "run.caps.set", actor: "cli", detail: { before, after: { ...before, ...parsed.caps } } });
      setRunCaps(db, parsed.caps);
    }).immediate();
  } catch (error) {
    return { code: 1, lines: [`Not changed: ${error instanceof Error ? error.message : String(error)}`] };
  }
  return { code: 0, lines: ["Run limits changed.", ...capsReport(db)] };
}

function openCli(): Database {
  try {
    return openDatabaseForCLI(loadConfig().dbPath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

function auditCommand(args: string[]): void {
  if (args[0] !== "verify") {
    console.error("usage: agni audit verify");
    process.exit(1);
  }
  const db = openCli();
  try {
    const report = auditVerifyReport(db);
    for (const line of report.lines) (report.code === 0 ? console.log : console.error)(line);
    db.close();
    if (report.code !== 0) process.exit(report.code);
  } catch (error) {
    db.close();
    throw error;
  }
}

function policyCommand(args: string[]): void {
  if (args[0] !== "caps" || (args[1] !== undefined && args[1] !== "set")) {
    console.error(CAPS_USAGE);
    process.exit(1);
  }
  const db = openCli();
  try {
    const report = args[1] === "set" ? setCapsReport(db, args.slice(2)) : { code: 0 as const, lines: capsReport(db) };
    for (const line of report.lines) (report.code === 0 ? console.log : console.error)(line);
    db.close();
    if (report.code !== 0) process.exit(report.code);
  } catch (error) {
    db.close();
    throw error;
  }
}

function setPaused(paused: boolean): void {
  const db = openCli();
  try {
    console.log(pauseReport(db, paused));
  } finally {
    db.close();
  }
}

/** CLI commands for s2-ops. Add entries to `commands` and one line each to `help`. */
export const s2OpsCommands: CommandTable = {
  commands: {
    audit: auditCommand,
    policy: policyCommand,
    pause: (args) => setPaused(!args.includes("--off")),
    resume: () => setPaused(false),
  },
  help: [
    "  audit verify       check the audit log's hash chain (exit 1 when it was altered)",
    "  pause [--off]      pause every bot: nothing new starts, running work stops (--off resumes)",
    "  resume             resume all bots (bots turned off stay off)",
    "  policy caps        show the run limits; policy caps set --wall-minutes N --delegations N --self-scheduled N changes them",
  ],
};
