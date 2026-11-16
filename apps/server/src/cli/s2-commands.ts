import { mergeCommandTables } from "./command-table";
import { s2OpsCommands } from "./s2-ops";

/** Sprint 2's extra CLI commands, merged from one table per task. */
export const s2Commands = mergeCommandTables(s2OpsCommands);
