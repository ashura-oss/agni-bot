/**
 * Sprint 3 merge fix round 1, item 1: the OAuth tokens in the plugin connection rows are masked from the first
 * line the daemon logs, not only after a row has been read (`readConnectionTokens`) or `vault migrate` ran.
 *
 * What the exit test found: after a daemon start, a model that quoted the refresh token put it raw into the
 * approval card, `tool_calls`, `approvals` and the message log, because nothing had read the connection row yet.
 * `startupS3` now reads every row once, after the vault is open, and registers the tokens under the row's slot.
 *
 * Each test is one "process": the registry is emptied, the vault (vault mode) is locked and unlocked again like a
 * restart, and only then does the startup hook run. Throwaway homes, in-memory keystore.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTaskTurn } from "../src/agent/task-loop";
import { openDatabase } from "../src/db";
import { HealthTracker } from "../src/models/health";
import { Router } from "../src/models/router";
import { completeConnect, startPending } from "../src/plugins/store";
import { lockVault, unlockVault } from "../src/secrets";
import { startupS3 } from "../src/startup/s3";
import { createThread } from "../src/stores/threads";
import { redact } from "../src/util/redact";
import { clearSecretsForTests } from "../src/util/redact-core";
import { provider, sseResponse, sseToolCall } from "./ws-harness";

const S = {
  access: "ya29.merge-canary-access-token-7741",
  refresh: "1//merge-canary-refresh-token-9903",
};
const masked = (value: string): boolean => redact(`before ${value} after`) === "before [redacted] after";

let home = "";
let scratch = "";
let db: Database;
let savedMode: string | undefined;
let savedScratch: string | undefined;
beforeEach(() => {
  savedMode = process.env.AGNI_SECRETS_MODE;
  savedScratch = process.env.AGNI_SCRATCH_DIR;
  delete process.env.AGNI_SECRETS_MODE;
  lockVault();
  home = mkdtempSync(join(tmpdir(), "agni-mergeconn-"));
  scratch = join(home, "scratch");
  mkdirSync(scratch, { recursive: true });
  process.env.AGNI_SCRATCH_DIR = scratch;
  db = openDatabase(":memory:");
});
afterEach(() => {
  db.close();
  lockVault();
  if (savedMode === undefined) delete process.env.AGNI_SECRETS_MODE;
  else process.env.AGNI_SECRETS_MODE = savedMode;
  if (savedScratch === undefined) delete process.env.AGNI_SCRATCH_DIR;
  else process.env.AGNI_SCRATCH_DIR = savedScratch;
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** A connected row, then a "restart": an empty registry, and in vault mode the vault opened again. */
async function connectThenRestart(mode: "file" | "vault"): Promise<void> {
  if (mode === "vault") {
    await unlockVault({ home, create: true });
    process.env.AGNI_SECRETS_MODE = "vault";
  }
  const row = startPending(db, { pluginID: "google-calendar", account: "agent", scopes: [], capabilities: {} });
  completeConnect(db, row.id, { access_token: S.access, refresh_token: S.refresh, expires_at: Date.now() + 3_600_000 }, "agent@example.com");
  clearSecretsForTests();
  if (mode === "vault") {
    lockVault();
    await unlockVault({ home, create: false });
  }
}

describe("a stored connection's tokens at daemon start", () => {
  for (const mode of ["file", "vault"] as const) {
    test(`${mode} mode: before the start hook the refresh token is not masked, after it both tokens are`, async () => {
      await connectThenRestart(mode);
      // A restart with no row read yet: this is the window the exit test found.
      expect(masked(S.refresh), "the refresh token was already masked before the start hook ran (the test proves nothing)").toBe(false);
      await startupS3({ db, config: {} as never });
      expect(masked(S.refresh)).toBe(true);
      expect(masked(S.access)).toBe(true);
    });
  }

  test("a row with no credential (an MCP connect, a pending sign-in) registers nothing and throws nothing", async () => {
    startPending(db, { pluginID: "granola", account: "owner", scopes: [], capabilities: {} });
    clearSecretsForTests();
    await expect(startupS3({ db, config: {} as never })).resolves.toBeUndefined();
  });

  test("a refresh after the start still replaces the tokens the way it did (the start does not pin the old ones live)", async () => {
    await connectThenRestart("file");
    await startupS3({ db, config: {} as never });
    const { getConnectionFor, updateTokens } = await import("../src/plugins/store");
    const row = getConnectionFor(db, "google-calendar", "agent")!;
    const fresh = { access_token: "ya29.merge-canary-access-token-newer-1", refresh_token: S.refresh, expires_at: Date.now() + 3_600_000 };
    updateTokens(db, row.id, fresh);
    expect(masked(fresh.access_token)).toBe(true);
    // The replaced access token stays masked until it expires (it may still work), as before.
    expect(masked(S.access)).toBe(true);
  });
});

describe("a model that quotes the refresh token after a start", () => {
  /** Every row of every table except the connection rows themselves (which hold the tokens by design in file mode). */
  function everythingStored(): string {
    const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'plugin_connections'").all();
    return tables.map(({ name }) => JSON.stringify(db.query(`SELECT * FROM "${name}"`).all())).join("\n");
  }

  for (const mode of ["file", "vault"] as const) {
    test(`${mode} mode: a write_file that overwrites a file with it leaves the raw token in no stored row`, async () => {
      await connectThenRestart(mode);
      await startupS3({ db, config: {} as never });
      writeFileSync(join(scratch, "notes.txt"), "old"); // an existing file: overwriting it asks the owner
      let request = 0;
      const router = new Router([provider], new HealthTracker(), (async () => (++request === 1 ? sseToolCall("write_file", { path: "notes.txt", content: `token ${S.refresh}` }) : sseResponse("done"))) as unknown as typeof fetch);
      const frames: string[] = [];
      const controller = new AbortController();
      await runTaskTurn(db, router, { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, {
        threadID: createThread(db, "ea").id, text: "save the token",
        persona: { id: "ea", name: "Ava", color: "#fff", role: "r", systemPromptTemplate: "x", systemPrompt: "x", tools: ["write_file"] },
        emit: (frame) => {
          frames.push(JSON.stringify(frame));
          if (frame.type === "approval.request") controller.abort();
        },
        signal: controller.signal,
      });
      const toolCalls = db.query<{ args: string }, []>("SELECT args FROM tool_calls").all();
      expect(toolCalls.length, "the model's call was not stored at all").toBeGreaterThan(0);
      expect(toolCalls[0]!.args).toContain("[redacted]");
      expect(everythingStored()).not.toContain(S.refresh);
      // The frames the client is sent are masked later, by the socket; here the ones the loop builds itself are.
      for (const frame of frames) if (frame.includes('"approval.request"')) expect(frame).not.toContain(S.refresh);
    });
  }
});
