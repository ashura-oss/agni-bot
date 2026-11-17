import { mergeCommandTables } from "./command-table";
import { s3DoctorCommands } from "./s3-doctor";
import { s3McpCommands } from "./s3-mcp";
import { s3VaultCommands } from "./s3-vault";

/** Sprint 3's extra CLI commands, merged from one table per task. */
export const s3Commands = mergeCommandTables(s3VaultCommands, s3McpCommands, s3DoctorCommands);
