/**
 * S3-06 asks plugins.json for an owner flag, `"local": true`, that lifts the
 * MCP server's private-address check. It lives on the plugin entry and is
 * synced from the file on disk exactly like `trustedTools`: the file is the
 * authority, so a hand edit (or its removal) is used and never written over.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPluginsFile, savePluginsFile, syncTrustedTools, type PluginEntry, type PluginsFile } from "../src/plugins/config";

let roots: string[] = [];
afterEach(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  roots = [];
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "agni-localflag-"));
  roots.push(dir);
  return join(dir, "plugins.json");
}

const mcpEntry = (extra: Partial<PluginEntry> = {}): PluginEntry => ({ account: "owner", enabled: true, auth: { kind: "mcp", url: "https://mcp.example.com" }, ...extra });

describe("PluginEntry.local", () => {
  test("a local flag written by hand is loaded and survives a save", () => {
    const path = scratch();
    writeFileSync(path, JSON.stringify({ version: 1, plugins: { granola: mcpEntry({ local: true }) } }));
    const config = loadPluginsFile(path);
    expect(config.plugins.granola!.local).toBe(true);
    savePluginsFile(path, config);
    expect(JSON.parse(readFileSync(path, "utf8")).plugins.granola.local).toBe(true);
  });

  test("syncing copies a flag the owner added after the config was loaded", () => {
    const path = scratch();
    writeFileSync(path, JSON.stringify({ version: 1, plugins: { granola: mcpEntry() } }));
    const config = loadPluginsFile(path);
    expect(config.plugins.granola!.local).toBeUndefined();
    writeFileSync(path, JSON.stringify({ version: 1, plugins: { granola: mcpEntry({ local: true }) } }));
    syncTrustedTools(path, config);
    expect(config.plugins.granola!.local).toBe(true);
  });

  test("syncing drops a flag the owner removed, so a later save does not bring it back", () => {
    const path = scratch();
    writeFileSync(path, JSON.stringify({ version: 1, plugins: { granola: mcpEntry({ local: true }) } }));
    const config = loadPluginsFile(path);
    writeFileSync(path, JSON.stringify({ version: 1, plugins: { granola: mcpEntry() } }));
    syncTrustedTools(path, config);
    expect(config.plugins.granola!.local).toBeUndefined();
    savePluginsFile(path, config);
    expect(JSON.parse(readFileSync(path, "utf8")).plugins.granola).not.toHaveProperty("local");
  });

  test("only the literal true counts: a string or a number is not a flag", () => {
    const path = scratch();
    writeFileSync(path, JSON.stringify({ version: 1, plugins: { granola: mcpEntry() } }));
    const config = loadPluginsFile(path);
    for (const value of ["true", 1, "yes", {}]) {
      writeFileSync(path, JSON.stringify({ version: 1, plugins: { granola: { ...mcpEntry(), local: value } } }));
      syncTrustedTools(path, config);
      expect(config.plugins.granola!.local).toBeUndefined();
    }
  });

  test("the trusted tools still sync alongside it", () => {
    const path = scratch();
    writeFileSync(path, JSON.stringify({ version: 1, plugins: { granola: mcpEntry() } }));
    const config: PluginsFile = loadPluginsFile(path);
    writeFileSync(path, JSON.stringify({ version: 1, plugins: { granola: mcpEntry({ local: true, trustedTools: ["search"] }) } }));
    syncTrustedTools(path, config);
    expect(config.plugins.granola).toMatchObject({ local: true, trustedTools: ["search"] });
  });
});
