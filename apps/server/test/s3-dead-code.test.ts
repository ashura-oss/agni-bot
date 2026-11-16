/**
 * S3-9 item 6: two things the Sprint 3 branches each did a share of are done
 * once. `plugins/config.ts` syncs the owner's `local` flag, so the MCP URL
 * module's own copy is gone; the OAuth state lives in `oauth_states`, so the
 * old state-in-the-tokens-column lookup is gone and a pending row carries no state.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db";
import * as mcpUrl from "../src/plugins/mcp-url";
import { readLocalFlag } from "../src/plugins/mcp-url";
import * as store from "../src/plugins/store";
import { syncTrustedTools, type PluginsFile } from "../src/plugins/config";

let roots: string[] = [];
afterEach(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  roots = [];
});

describe("the owner's local flag", () => {
  test("syncTrustedTools (plugins/config.ts) carries it from the file into memory, and removal too", () => {
    const dir = mkdtempSync(join(tmpdir(), "agni-local-"));
    roots.push(dir);
    const path = join(dir, "plugins.json");
    const memory = { plugins: { lan: { enabled: true, local: true }, other: { enabled: true } } } as unknown as PluginsFile;
    writeFileSync(path, JSON.stringify({ plugins: { lan: { enabled: true }, other: { enabled: true, local: true } } }));
    syncTrustedTools(path, memory);
    expect(memory.plugins.lan?.local).toBeUndefined();
    expect(memory.plugins.other?.local).toBe(true);
    expect(readLocalFlag(path, "other")).toBe(true);
    expect(readLocalFlag(path, "lan")).toBe(false);
  });

  test("plugins/mcp-url.ts no longer has its own copy of the sync", () => {
    expect("syncLocalFlags" in mcpUrl).toBe(false);
  });
});

describe("OAuth state", () => {
  test("the connection store no longer looks a pending row up by state, nor takes one", () => {
    expect("getConnectionByState" in store).toBe(false);
  });

  test("a pending connection carries no state in its tokens column", () => {
    const db = openDatabase(":memory:");
    try {
      const pending = store.startPending(db, { pluginID: "calendar", account: "agent", scopes: ["s"], capabilities: [] });
      expect(pending.status).toBe("pending");
      expect(pending.tokens ?? "").not.toContain("state");
      expect(store.readConnectionTokens(pending)).toEqual({});
    } finally {
      db.close();
    }
  });
});
