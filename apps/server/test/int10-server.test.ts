/**
 * Web exit retest, server items: closure note wording, the routine state label,
 * and a database that waits instead of throwing when someone else is reading.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { INTERRUPTED_REQUEST_NOTE, REVOKED_REQUEST_NOTE, STOPPED_REQUEST_NOTE } from "../src/agent/closure";
import { stripRoutineState } from "../src/routines/prompt";

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

describe("closure notes do not claim the request never ran", () => {
  for (const [name, note] of [["stopped", STOPPED_REQUEST_NOTE], ["interrupted", INTERRUPTED_REQUEST_NOTE], ["revoked", REVOKED_REQUEST_NOTE]] as const) {
    test(`${name}: some steps may have run, do not resume, check the real state when asked`, () => {
      expect(note).toMatch(/steps may already have run/);
      expect(note).toMatch(/will not resume it/);
      expect(note).toMatch(/check the actual state/i);
      expect(note).not.toMatch(/never ran|did not run/i);
    });
  }
});

describe("the routine state block is cut from what the owner sees", () => {
  test("a labelled block without a stateContext key is cut too", () => {
    const reply = 'Inbox is quiet.\n\nRoutine state (used next run):\n```json\n{"seen": 2, "lastId": "abc"}\n```';
    expect(stripRoutineState(reply)).toBe("Inbox is quiet.");
  });

  test("a trailing bare fenced json block that is the last thing in the reply is cut", () => {
    expect(stripRoutineState('Two new mails.\n\n```json\n{"seen": 2}\n```\n')).toBe("Two new mails.");
  });

  test("the label alone, or with a bold or heading marker, goes with its block", () => {
    expect(stripRoutineState('Done.\n\n**Routine state (used next run)**\n```json\n{"a":1}\n```')).toBe("Done.");
    expect(stripRoutineState('Done.\n\n## Routine state (used next run):\n```json\n[1,2]\n```')).toBe("Done.");
  });

  test("a json block in the middle of a reply, or one that is not last, stays", () => {
    const middle = 'Here is the data:\n```json\n{"x":1}\n```\nAnd that is all I found.';
    expect(stripRoutineState(middle)).toBe(middle);
  });

  test("a block with a stateContext key is still cut, and the key-less one does not count as state", async () => {
    const { parseRoutineState } = await import("../src/routines/prompt");
    const withKey = 'Ok.\n\nRoutine state (used next run)\n```json\n{"stateContext":{"seen":1}}\n```';
    expect(stripRoutineState(withKey)).toBe("Ok.");
    expect(parseRoutineState(withKey)).toEqual({ found: true, value: { seen: 1 } });
    // No stateContext: the parse warns and keeps the previous state, as before.
    expect(parseRoutineState('Ok.\n\nRoutine state (used next run):\n```json\n{"seen": 2}\n```')).toEqual({ found: false });
  });
});

describe("a locked database does not become an unhandled rejection", () => {
  test("the job runner's poll survives a writer holding the lock, and works again once it lets go", async () => {
    const { Database: Sqlite } = await import("bun:sqlite");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { JobRunner } = await import("../src/jobs/runner");
    const { enqueueJob, getJob } = await import("../src/stores/jobs");
    const dir = mkdtempSync(join(tmpdir(), "agni-locked-"));
    const path = join(dir, "agni.sqlite");
    db = openDatabase(path);
    db.exec("PRAGMA busy_timeout = 20;");
    // Due work, so the poll has to write to claim it while the other writer holds the lock.
    const job = enqueueJob(db, { kind: "probe" });
    const other = new Sqlite(path);
    other.exec("BEGIN IMMEDIATE");
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", listener);
    const runner = new JobRunner(db, () => undefined, { pollMs: 25 });
    let ran = 0;
    runner.register("probe", async () => { ran += 1; return { result: "ok" }; });
    try {
      runner.start();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(unhandled).toEqual([]);
      expect(ran).toBe(0);
      other.exec("ROLLBACK");
      other.close();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(ran).toBe(1);
      expect(getJob(db, job.id)!.state).toBe("done");
    } finally {
      runner.stop();
      process.off("unhandledRejection", listener);
      db.close(); db = undefined;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a delegated result keeps its line breaks when the delegating bot reads it", () => {
  async function viewOf(visibility: "summary" | "shared", content: string): Promise<{ result: string }> {
    const { ToolRegistry } = await import("../src/tools/registry");
    const { registerDelegateTaskTool } = await import("../src/tools/delegate-task-tool");
    const { saveArtifact } = await import("../src/stores/artifacts");
    const { setDelegationArtifact, setDelegationState } = await import("../src/stores/tasks");
    db = openDatabase(":memory:");
    db.run("UPDATE agents SET visibility = ? WHERE id = 'researcher'", [visibility]);
    const registry = new ToolRegistry();
    registerDelegateTaskTool(registry, { db, emit: () => undefined, currentAgentID: "ea", channelID: "main", parentTurnID: "trn_p", parentThreadID: "thr_p" });
    const ctx = { threadID: "thr_p", turnID: "trn_p", signal: new AbortController().signal };
    const call = (name: string, args: Record<string, unknown>) =>
      (registry.get(name)!.handler as unknown as (a: Record<string, unknown>, c: unknown) => Promise<Record<string, unknown>>)(args, ctx);
    const queued = await call("delegate_task", { toAgentID: "researcher", goal: "List things" }) as { taskID: string };
    const artifact = saveArtifact(db, { taskID: queued.taskID, agentID: "researcher", content });
    setDelegationArtifact(db, queued.taskID, artifact.id);
    setDelegationState(db, queued.taskID, "done", "done");
    return await call("task_status", { taskID: queued.taskID }) as { result: string };
  }
  const sixty = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");

  for (const visibility of ["summary", "shared"] as const) {
    test(`${visibility}: 60 lines come back as 60 lines`, async () => {
      const view = await viewOf(visibility, sixty);
      expect(view.result.split("\n")).toHaveLength(60);
      expect(view.result.startsWith("line 1\nline 2\n")).toBe(true);
    });
  }

  test("only runs of blank lines are collapsed, and spaces inside a line", async () => {
    const view = await viewOf("summary", "first   line\n\n\n\n\nsecond line\t\twith tabs  \nthird");
    expect(view.result).toBe("first line\n\nsecond line with tabs\nthird");
  });

  test("the short summary a third bot gets may stay one line", async () => {
    const { redactForCaller } = await import("../src/agent/visibility");
    const out = redactForCaller("one\ntwo\nthree", "researcher", "someone_else", "summary");
    expect(out.text).toBe("one two three");
  });
});
