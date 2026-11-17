/**
 * A grading context for grader tests: a real episode database (the server's
 * own migrations, so every real column is there), real scratch and outbox
 * folders, and an unconnected protocol client whose recorded frames a test
 * fills in. Rows are inserted with the columns the server writes.
 */
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openDatabase } from "../../../apps/server/src/db";
import type { MockStep } from "../../../tools/mock-provider/src/server";
import { AgniClient } from "../client";
import type { Ctx } from "../types";

export interface TurnRef {
  thread: string;
  turn: string;
}

export interface GradeHarness {
  ctx: Ctx;
  /** The episode database, opened with the server's migrations. */
  db: Database;
  addAgent(id: string, displayName: string, tools?: string[]): void;
  addTurn(agent: string): TurnRef;
  /** Returns the call id. */
  addToolCall(r: { agent?: string; tool: string; args: unknown; ok?: boolean; result?: string; error?: string; turn?: TurnRef }): string;
  addApproval(r: { tool: string; action: string; decision: "once" | "reject"; callId?: string }): void;
  addJob(r: { kind: string; payload: unknown; state: string; runAt: string; attempts?: number; createdAt?: string; enabled?: number; result?: string }): void;
  cleanup(): void;
}

/**
 * Play a stub script's `write_file` calls into scratch, as the server would
 * have (each one also recorded as a `tool_calls` row), so a grader test can
 * grade the end state a scripted model leaves behind.
 */
export function applyScriptWrites(h: GradeHarness, steps: MockStep[]): void {
  for (const step of steps) {
    for (const call of step.calls ?? []) {
      if (call.name !== "write_file") continue;
      const args = call.args as { path: string; content: string };
      const path = join(h.ctx.scratch, args.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, args.content);
      h.addToolCall({ tool: "write_file", args });
    }
  }
}

let seq = 0;
const newId = (prefix: string): string => `${prefix}_${Date.now().toString(36)}_${(seq++).toString(36)}`;
const now = (): string => new Date().toISOString();

export function makeGradeHarness(opts: { model?: string; rep?: number; ep?: string } = {}): GradeHarness {
  const home = mkdtempSync(join(tmpdir(), "agni-eval-grade-"));
  const scratch = join(home, "scratch");
  const outbox = join(home, "outbox");
  const webDir = join(home, "web");
  for (const dir of [scratch, outbox, webDir]) mkdirSync(dir, { recursive: true });
  const dbPath = join(home, "data", "agni.sqlite");
  const db = openDatabase(dbPath);
  const ep = opts.ep ?? "grade-test";
  const ctx: Ctx = {
    model: opts.model ?? "test/model", rep: opts.rep ?? 1, ep, home, scratch, outbox, appScratch: scratch, appOutbox: outbox, port: 0,
    client: new AgniClient(), db: () => new Database(dbPath), webDir, webBase: `http://fixtures.example:1/${ep}`, notes: {}, log: () => {},
  };
  const addTurn = (agent: string): TurnRef => {
    const thread = newId("thr");
    const turn = newId("turn");
    const t = now();
    db.run("INSERT INTO threads (id, agent_id, created_at, updated_at) VALUES (?, ?, ?, ?)", [thread, agent, t, t]);
    db.run("INSERT INTO turns (id, thread_id, agent_id, state, stop_reason, started_at, ended_at) VALUES (?, ?, ?, 'done', 'end', ?, ?)", [turn, thread, agent, t, t]);
    return { thread, turn };
  };
  return {
    ctx,
    db,
    addAgent(id, displayName, tools = []) {
      const t = now();
      db.run("INSERT INTO agents (id, name, display_name, tools, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", [id, displayName, displayName, JSON.stringify(tools), t, t]);
    },
    addTurn,
    addToolCall(r) {
      const at = r.turn ?? addTurn(r.agent ?? "ea");
      const callId = newId("call");
      db.run(
        "INSERT INTO tool_calls (id, thread_id, turn_id, call_id, tool_name, args, result, ok, error, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [newId("tc"), at.thread, at.turn, callId, r.tool, JSON.stringify(r.args), r.result ?? null, r.ok === false ? 0 : 1, r.error ?? null, 5, now()],
      );
      return callId;
    },
    addApproval(r) {
      const t = now();
      db.run(
        "INSERT INTO approvals (id, action, preview, status, decision, created_at, decided_at, call_id, tool_name) VALUES (?, ?, ?, 'decided', ?, ?, ?, ?, ?)",
        [newId("apr"), r.action, r.action, r.decision, t, t, r.callId ?? null, r.tool],
      );
    },
    addJob(r) {
      const t = r.createdAt ?? now();
      db.run(
        "INSERT INTO jobs (id, kind, payload, state, run_at, attempts, created_at, updated_at, enabled, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [newId("job"), r.kind, JSON.stringify(r.payload), r.state, r.runAt, r.attempts ?? 0, t, t, r.enabled ?? 1, r.result ?? null],
      );
    },
    cleanup() {
      db.close();
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}
