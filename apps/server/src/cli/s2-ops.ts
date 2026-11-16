import type { Database } from "bun:sqlite";
import { loadConfig } from "../config";
import { openDatabaseForCLI } from "../db";
import { setAllPaused } from "../policy/pause";
import { installAuditSink, verifyAuditChain } from "../stores/audit";
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
    pause: (args) => setPaused(!args.includes("--off")),
    resume: () => setPaused(false),
  },
  help: [
    "  audit verify       check the audit log's hash chain (exit 1 when it was altered)",
    "  pause [--off]      pause every bot: nothing new starts, running work stops (--off resumes)",
    "  resume             resume all bots (bots turned off stay off)",
  ],
};
