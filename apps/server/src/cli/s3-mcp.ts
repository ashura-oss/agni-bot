/**
 * `agni mcp`: the owner's side of MCP tool pinning (S3-06).
 *
 *   agni mcp list [plugin]                     pinned and waiting tools
 *   agni mcp approve <plugin> <tool> [--yes]   show what changed, then pin the new definition
 *   agni mcp approve <plugin> --all [--yes]    the same for every waiting tool of the plugin
 *
 * Approving writes to the database the daemon reads, so the tool is offered to
 * bots on the daemon's next tool-list build; no restart. The text shown comes
 * from the MCP server, so it is printed as JSON-quoted data, never raw.
 */
import type { Database } from "bun:sqlite";
import { createInterface } from "node:readline/promises";
import { loadConfig } from "../config";
import { openDatabaseForCLI } from "../db";
import { approvePending, listPins, pinsFor, type PinRow } from "../plugins/mcp-pins";
import type { CommandTable } from "./command-table";

export interface McpCommandIO {
  log: (line: string) => void;
  /** Ask the owner a yes/no question. */
  confirm: (question: string) => Promise<boolean>;
}

const USAGE = "usage: agni mcp list [plugin] | agni mcp approve <plugin> <tool|--all> [--yes]";

type Definition = Record<string, unknown>;

function parseDefinition(text: string | undefined): Definition {
  if (!text) return {};
  try {
    return JSON.parse(text) as Definition;
  } catch {
    return {};
  }
}

/**
 * Text that came from the server, made safe to print: anything outside printable
 * ASCII (escape sequences, DEL, C1 controls, bidi overrides) shows as a visible
 * `\u{hex}` escape, so server text cannot move the cursor, erase lines or reorder
 * what the owner is reading.
 */
export function printable(text: string): string {
  return text.replace(/[^\x20-\x7e]/gu, (char) => `\\u{${char.codePointAt(0)!.toString(16)}}`);
}

/** One value as indented JSON lines, each made printable. */
function show(value: unknown): string[] {
  return (JSON.stringify(value, null, 2) ?? "undefined").split("\n").map(printable);
}

/** The lines that show how a tool's pending definition differs from its approved one. */
export function describeChange(approved: PinRow | undefined, pending: PinRow): string[] {
  const before = parseDefinition(approved?.definition);
  const after = parseDefinition(pending.definition);
  const lines = [approved ? `${printable(pending.plugin)} / ${printable(pending.tool)}: changed since you trusted it` : `${printable(pending.plugin)} / ${printable(pending.tool)}: new tool`];
  for (const field of ["name", "description", "inputSchema", "annotations"]) {
    const was = JSON.stringify(before[field]);
    const now = JSON.stringify(after[field]);
    if (approved && was === now) continue;
    lines.push(`  ${field}:`);
    if (approved) for (const line of show(before[field])) lines.push(`    - ${line}`);
    for (const line of show(after[field])) lines.push(`    + ${line}`);
  }
  return lines;
}

function list(db: Database, plugin: string | undefined, io: McpCommandIO): void {
  const rows = listPins(db, plugin);
  if (rows.length === 0) {
    io.log(plugin ? `No pinned tools for ${plugin}.` : "No pinned tools.");
    return;
  }
  const tools = new Map<string, PinRow[]>();
  for (const row of rows) tools.set(`${row.plugin}\0${row.tool}`, [...(tools.get(`${row.plugin}\0${row.tool}`) ?? []), row]);
  for (const group of tools.values()) {
    const approved = group.find((row) => row.status === "approved");
    const pending = group.find((row) => row.status === "pending");
    const state = pending ? (approved ? "pending (changed since approved; disabled)" : "pending (new; disabled)") : "approved";
    io.log(`${printable(group[0]!.plugin)}  ${printable(group[0]!.tool).padEnd(28)} ${state}`);
  }
}

async function approve(db: Database, args: string[], io: McpCommandIO): Promise<void> {
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const [plugin, tool] = positional;
  const all = args.includes("--all");
  if (!plugin || (all ? tool !== undefined : !tool)) throw new Error(USAGE);
  const targets = all
    ? [...new Set(listPins(db, plugin).filter((row) => row.status === "pending").map((row) => row.tool))]
    : [tool!];
  if (all && targets.length === 0) {
    io.log(`Nothing pending for ${plugin}.`);
    return;
  }
  // What the owner is shown: the hash of each pending definition, so only those exact ones get pinned.
  const shown = new Map<string, string>();
  for (const name of targets) {
    const { approved, pending } = pinsFor(db, plugin, name);
    if (!pending) throw new Error(`nothing pending for ${printable(plugin)} / ${printable(name)}: it is already approved, or the server has not offered it (run \`agni mcp list ${printable(plugin)}\`)`);
    shown.set(name, pending.hash);
    for (const line of describeChange(approved, pending)) io.log(line);
  }
  const what = all ? `all ${targets.length} tool(s) of ${printable(plugin)}` : `${printable(plugin)} / ${printable(tool!)}`;
  if (!(await io.confirm(`Pin the definition above for ${what}? [y/N] `))) {
    io.log("Not changed.");
    return;
  }
  for (const name of targets) {
    // The server may have offered something else while the owner was reading: that is not approved.
    if (approvePending(db, plugin, name, shown.get(name)!)) io.log(`approved ${printable(plugin)} / ${printable(name)}`);
    else io.log(`NOT approved: ${printable(plugin)} / ${printable(name)} changed while you were reviewing; run the command again to see the new definition`);
  }
}

/** The command's logic, with the database and the terminal passed in so tests need neither. */
export async function runMcpCommand(args: string[], context: { db: Database; io: McpCommandIO }): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === "list") return list(context.db, rest.find((arg) => !arg.startsWith("--")), context.io);
  if (sub === "approve") return approve(context.db, rest, context.io);
  throw new Error(USAGE);
}

function terminalIO(assumeYes: boolean): McpCommandIO {
  return {
    log: (line) => console.log(line),
    confirm: async (question) => {
      if (assumeYes) return true;
      if (!process.stdin.isTTY) throw new Error("not a terminal: review the change above in a terminal, or pass --yes after reading it");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return /^y(es)?$/i.test((await rl.question(question)).trim());
      } finally {
        rl.close();
      }
    },
  };
}

async function mcpCommand(args: string[]): Promise<void> {
  let db: Database;
  try {
    db = openDatabaseForCLI(loadConfig().dbPath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  try {
    await runMcpCommand(args, { db, io: terminalIO(args.includes("--yes")) });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

/** CLI commands for s3-mcp. */
export const s3McpCommands: CommandTable = {
  commands: { mcp: mcpCommand },
  help: [
    "  mcp list [plugin]  show pinned MCP tools and the ones waiting for approval",
    "  mcp approve <plugin> <tool|--all>  review a changed or new MCP tool, then allow it (--yes skips the prompt)",
  ],
};
