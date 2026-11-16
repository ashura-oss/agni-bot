import { s2Commands } from "./s2-commands";
import { s3Commands } from "./s3-commands";

/** A table of extra CLI commands a sprint adds, with the help lines `usage()` prints for them. */
export interface CommandTable {
  commands: Record<string, (args: string[]) => Promise<void> | void>;
  help: string[];
}

const TABLES: CommandTable[] = [s2Commands, s3Commands];

/** Every extra help line, in table order. */
export function extraHelpLines(tables: CommandTable[] = TABLES): string[] {
  return tables.flatMap((table) => table.help);
}

/** Run `command` from the first table that has it. False when none does. */
export async function runExtraCommand(
  command: string,
  args: string[],
  tables: CommandTable[] = TABLES,
): Promise<boolean> {
  for (const table of tables) {
    const run = Object.hasOwn(table.commands, command) ? table.commands[command] : undefined;
    if (!run) continue;
    await run(args);
    return true;
  }
  return false;
}
