import type { Migration } from "../migrations";

/**
 * The tables behind MCP tool pinning (S3-06). Exported on its own so the hub's
 * in-memory fallback creates exactly the schema the migration does.
 *
 *  - `mcp_pin_plugins`: a plugin whose first connect has been trusted. Kept
 *    apart from the tool rows so a server that lists no tools once cannot make
 *    the next listing a "first trust" again.
 *  - `mcp_tool_pins`: per plugin and server tool name, the approved hash and
 *    canonical definition, and (when the server offers something else) a pending
 *    row the owner has not approved. `hash` is sha-256 of the canonical JSON in
 *    `definition`; `definition` is kept so `agni mcp approve` can show a diff.
 */
export const MCP_PINS_SQL = `
  CREATE TABLE IF NOT EXISTS mcp_pin_plugins (
    plugin_id TEXT PRIMARY KEY,
    trusted_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mcp_tool_pins (
    plugin_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('approved', 'pending')),
    hash TEXT NOT NULL,
    definition TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (plugin_id, tool_name, status)
  );
`;

export const migration: Migration | null = { id: 60, name: "mcp_tool_pins", sql: MCP_PINS_SQL };
