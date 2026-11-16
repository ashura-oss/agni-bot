/**
 * MCP tool pinning (S3-06). An MCP server controls what its tools are called,
 * how they are described and what arguments they take, and it can change all of
 * that after the owner trusted it. So the first time a plugin connects, each
 * tool's definition (name, description, input schema, annotations) is hashed and
 * stored. Afterwards a tool whose hash differs, or which is new, is not offered
 * to any bot until the owner approves it with `agni mcp approve`, which shows
 * the change first. A tool missing from a non-empty listing loses its pin.
 *
 * Everything here works on a bun:sqlite Database holding migration 60's tables.
 * The hub, the plugin service and the CLI share it, so an approval made in the
 * CLI is seen by the running daemon on its next `tools()` call.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { MCP_PINS_SQL } from "../db/s3/m60";

/** The part of an MCP tool listing that is pinned. */
export interface PinnedDefinition {
  name: string;
  description?: string | undefined;
  inputSchema?: unknown;
  annotations?: unknown;
}

export interface PinCandidate {
  /** The server's own tool name. */
  tool: string;
  hash: string;
  definition: string;
}

export interface PinRow {
  plugin: string;
  tool: string;
  status: "approved" | "pending";
  hash: string;
  definition: string;
  recordedAt: string;
}

/** JSON with object keys sorted at every depth, so key order never changes a hash. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) out[key] = canonical(item);
    }
    return out;
  }
  return value;
}

export function canonicalDefinition(def: PinnedDefinition): string {
  return JSON.stringify(canonical({
    name: def.name,
    description: def.description ?? "",
    inputSchema: def.inputSchema ?? {},
    annotations: def.annotations ?? {},
  }));
}

export function hashToolDefinition(def: PinnedDefinition): string {
  return createHash("sha256").update(canonicalDefinition(def)).digest("hex");
}

/** A private in-memory database with the pin tables: the hub's default when it is given none. */
export function memoryPins(): Database {
  const db = new Database(":memory:");
  db.exec(MCP_PINS_SQL);
  return db;
}

export type PinVerdict = "approved" | "pending";

/**
 * Compare what a server lists now with what is pinned, and record the result.
 * The first connect of a plugin is trusted as it stands. After that a tool is
 * `approved` only when its hash matches the approved pin; a changed or new tool
 * is `pending` (and its latest offered definition is stored for the diff);
 * a pinned tool the server no longer lists loses its pins, but only when the
 * listing is not empty (an empty one never drops anything).
 */
export function reconcilePins(db: Database, plugin: string, offered: PinCandidate[], now: () => string = () => new Date().toISOString()): Map<string, PinVerdict> {
  const verdicts = new Map<string, PinVerdict>();
  db.transaction(() => {
    const trusted = db.query("SELECT 1 FROM mcp_pin_plugins WHERE plugin_id = ?").get(plugin) !== null;
    const stamp = now();
    if (!trusted) {
      db.run("INSERT INTO mcp_pin_plugins (plugin_id, trusted_at) VALUES (?, ?)", [plugin, stamp]);
      db.run("DELETE FROM mcp_tool_pins WHERE plugin_id = ?", [plugin]);
    }
    const approved = new Map(
      db.query<{ tool_name: string; hash: string }, [string]>("SELECT tool_name, hash FROM mcp_tool_pins WHERE plugin_id = ? AND status = 'approved'").all(plugin)
        .map((row) => [row.tool_name, row.hash]),
    );
    const listed = new Set(offered.map((item) => item.tool));
    // Removed tools drop every pin they had, so a tool that comes back is new and needs approval.
    // Only on a non-empty listing: a server that is still starting may list nothing, and that is
    // not the server removing its tools (it would cost the owner every approval for no reason).
    if (offered.length > 0) {
      for (const known of db.query<{ tool_name: string }, [string]>("SELECT DISTINCT tool_name FROM mcp_tool_pins WHERE plugin_id = ?").all(plugin)) {
        if (!listed.has(known.tool_name)) db.run("DELETE FROM mcp_tool_pins WHERE plugin_id = ? AND tool_name = ?", [plugin, known.tool_name]);
      }
    }
    for (const item of offered) {
      if (!trusted) {
        db.run("INSERT INTO mcp_tool_pins (plugin_id, tool_name, status, hash, definition, recorded_at) VALUES (?, ?, 'approved', ?, ?, ?)", [plugin, item.tool, item.hash, item.definition, stamp]);
        verdicts.set(item.tool, "approved");
        continue;
      }
      if (approved.get(item.tool) === item.hash) {
        db.run("DELETE FROM mcp_tool_pins WHERE plugin_id = ? AND tool_name = ? AND status = 'pending'", [plugin, item.tool]);
        verdicts.set(item.tool, "approved");
        continue;
      }
      db.run(
        `INSERT INTO mcp_tool_pins (plugin_id, tool_name, status, hash, definition, recorded_at) VALUES (?, ?, 'pending', ?, ?, ?)
         ON CONFLICT (plugin_id, tool_name, status) DO UPDATE SET hash = excluded.hash, definition = excluded.definition, recorded_at = excluded.recorded_at`,
        [plugin, item.tool, item.hash, item.definition, stamp],
      );
      verdicts.set(item.tool, "pending");
    }
  })();
  return verdicts;
}

/** Approved hash per server tool name, read fresh so an approval made elsewhere counts at once. */
export function approvedHashes(db: Database, plugin: string): Map<string, string> {
  return new Map(
    db.query<{ tool_name: string; hash: string }, [string]>("SELECT tool_name, hash FROM mcp_tool_pins WHERE plugin_id = ? AND status = 'approved'").all(plugin)
      .map((row) => [row.tool_name, row.hash]),
  );
}

export function listPins(db: Database, plugin?: string): PinRow[] {
  const rows = plugin === undefined
    ? db.query<Record<string, string>, []>("SELECT * FROM mcp_tool_pins ORDER BY plugin_id, tool_name, status").all()
    : db.query<Record<string, string>, [string]>("SELECT * FROM mcp_tool_pins WHERE plugin_id = ? ORDER BY tool_name, status").all(plugin);
  return rows.map((row) => ({
    plugin: row.plugin_id!,
    tool: row.tool_name!,
    status: row.status as PinRow["status"],
    hash: row.hash!,
    definition: row.definition!,
    recordedAt: row.recorded_at!,
  }));
}

/** The approved and pending rows for one tool, for showing a diff. */
export function pinsFor(db: Database, plugin: string, tool: string): { approved?: PinRow; pending?: PinRow } {
  const rows = listPins(db, plugin).filter((row) => row.tool === tool);
  return { approved: rows.find((row) => row.status === "approved"), pending: rows.find((row) => row.status === "pending") };
}

/**
 * Make the pending definition the approved one, but only if it is still the one
 * the owner was shown (`expectedHash`). False when nothing is pending or it has
 * changed since.
 */
export function approvePending(db: Database, plugin: string, tool: string, expectedHash: string, now: () => string = () => new Date().toISOString()): boolean {
  return db.transaction(() => {
    const pending = pinsFor(db, plugin, tool).pending;
    if (!pending || pending.hash !== expectedHash) return false;
    db.run("DELETE FROM mcp_tool_pins WHERE plugin_id = ? AND tool_name = ?", [plugin, tool]);
    db.run("INSERT INTO mcp_tool_pins (plugin_id, tool_name, status, hash, definition, recorded_at) VALUES (?, ?, 'approved', ?, ?, ?)", [plugin, tool, pending.hash, pending.definition, now()]);
    return true;
  })();
}

/** Forget a plugin entirely (disconnect, or a different server URL): its next connect is a first trust. */
export function clearPlugin(db: Database, plugin: string): void {
  db.transaction(() => {
    db.run("DELETE FROM mcp_tool_pins WHERE plugin_id = ?", [plugin]);
    db.run("DELETE FROM mcp_pin_plugins WHERE plugin_id = ?", [plugin]);
  })();
}
