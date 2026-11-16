/** A table of extra CLI commands a sprint task adds, with the help lines `usage()` prints for them. */
export interface CommandTable {
  commands: Record<string, (args: string[]) => Promise<void> | void>;
  help: string[];
}

/**
 * Combine several tables into one: commands are spread together, help lines are
 * concatenated in order. A command name in two tables throws, so two engineers
 * can never silently shadow each other.
 */
export function mergeCommandTables(...tables: CommandTable[]): CommandTable {
  const commands: CommandTable["commands"] = {};
  for (const table of tables) {
    for (const [name, run] of Object.entries(table.commands)) {
      if (Object.hasOwn(commands, name)) throw new Error(`duplicate CLI command "${name}"`);
      commands[name] = run;
    }
  }
  return { commands, help: tables.flatMap((table) => table.help) };
}
