/**
 * Sprint 3 merge, integration item (a): the routine tool offers and stores named pre-checks.
 *
 * Sprint 3 retired the model-written SQL pre-check (`kind: "sql"`) and put named checks in its place
 * (`routines/preflight-checks.ts`). Migration 63 tells the owner to "ask the bot to recreate it with a named
 * check", so the tool has to be able to. These tests walk that whole road: tool -> store -> run -> list frame -> card.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseServerFrame, type ServerFrame, type ServerFrameBody } from "@agni/protocol";
import { previewAction } from "../src/agent/card-preview";
import { openDatabase } from "../src/db";
import { decide } from "../src/policy/engine";
import { runPreflight, SQL_PREFLIGHT_RETIRED } from "../src/routines/preflight";
import { describeChecks } from "../src/routines/preflight-checks";
import type { Routine } from "../src/routines/types";
import { getRoutine } from "../src/stores/routines";
import { createRoutineTools } from "../src/tools/routines-tool";
import { dispatch, type DispatchDeps, type Session } from "../src/ws/dispatch";
import { FrameLog } from "../src/ws/frame-log";
import type { Router } from "../src/models/router";
import { policyRig, type PolicyRig } from "./policy-fixture";

const base = { name: "Approvals", prompt: "Tell me what is waiting.", cron: "*/10 * * * *", timezone: "UTC" };
const context = { threadID: "thr", turnID: "trn", signal: new AbortController().signal, chain: { depth: 1, rootAgentID: "ea", currentAgentID: "ea", handoffSummary: null } };

function tool(db: Database, name = "routine_create") {
  return createRoutineTools(db).find((item) => item.name === name)!;
}
function create(db: Database, args: Record<string, unknown>): Promise<Routine> {
  return tool(db).handler(args, context) as Promise<Routine>;
}

const cleanup: Array<() => void> = [];
let rig: PolicyRig | undefined;
afterEach(() => {
  rig?.close();
  rig = undefined;
  while (cleanup.length) cleanup.pop()!();
});

describe("routine_create offers and stores a named check", () => {
  test("the preflight schema lists check, and no longer lists sql", () => {
    const db = openDatabase(":memory:");
    cleanup.push(() => db.close());
    const schema = tool(db).schema as { properties: { preflight: { properties: { kind: { enum: string[] }; name?: { enum?: string[] } } } } };
    expect(schema.properties.preflight.properties.kind.enum).toEqual(["http", "check", "mail", "none"]);
    // The model is shown the names to choose from.
    expect(schema.properties.preflight.properties.name?.enum).toEqual(describeChecks().map((check) => check.name));
  });

  test("a check with no parameters is stored as given", async () => {
    const db = openDatabase(":memory:");
    cleanup.push(() => db.close());
    const created = await create(db, { ...base, preflight: { kind: "check", name: "pending_approvals" } });
    expect(created.preflight).toEqual({ kind: "check", name: "pending_approvals", params: {} });
    expect(getRoutine(db, created.id)?.preflight).toEqual({ kind: "check", name: "pending_approvals", params: {} });
  });

  test("defaults are filled in, so the same question is stored the same way", async () => {
    const db = openDatabase(":memory:");
    cleanup.push(() => db.close());
    const created = await create(db, { ...base, preflight: { kind: "check", name: "new_turns", params: { agentID: "ea" } } });
    expect(created.preflight).toEqual({ kind: "check", name: "new_turns", params: { agentID: "ea", hours: 24 } });
  });

  test("a stored check runs: the first look counts as a change, the same state again does not", async () => {
    const db = openDatabase(":memory:");
    cleanup.push(() => db.close());
    const created = await create(db, { ...base, preflight: { kind: "check", name: "open_tasks" } });
    const first = await runPreflight(created.preflight, db, null);
    expect(first.changed).toBe(true);
    expect((await runPreflight(created.preflight, db, first.hash)).changed).toBe(false);
  });

  test("an unknown check, or a parameter the check does not take, is refused with the choices", async () => {
    const db = openDatabase(":memory:");
    cleanup.push(() => db.close());
    await expect(create(db, { ...base, preflight: { kind: "check", name: "drop_everything" } })).rejects.toThrow(/pending_approvals/);
    await expect(create(db, { ...base, preflight: { kind: "check", name: "pending_approvals", params: { sql: "1" } } })).rejects.toThrow(/unknown parameter/);
    await expect(create(db, { ...base, preflight: { kind: "check", name: "new_turns" } })).rejects.toThrow(/agentID is required/);
  });

  test("a model-written SQL pre-check is refused, and the refusal points at the named checks", async () => {
    const db = openDatabase(":memory:");
    cleanup.push(() => db.close());
    await expect(create(db, { ...base, preflight: { kind: "sql", query: "SELECT count(*) FROM tasks" } })).rejects.toThrow(SQL_PREFLIGHT_RETIRED);
    // Even the old harmless-looking query: nothing a model writes becomes SQL.
    await expect(create(db, { ...base, preflight: { kind: "sql", query: "SELECT 1" } })).rejects.toThrow(/named check/);
  });
});

describe("the policy engine and the owner's card", () => {
  test("a good check is put to the owner, a bad one is refused before any card with the choices named", () => {
    rig = policyRig();
    const run = rig.another({ principal: { kind: "owner" }, jobID: "job_owner" });
    const ask = (preflight: unknown) => decide(run, { tool: "routine_create", args: { ...base, preflight }, callID: "c1" }, { record: false });
    expect(ask({ kind: "check", name: "pending_approvals" }).action).toBe("ask");
    const bad = ask({ kind: "check", name: "drop_everything" });
    expect(bad.action).toBe("refuse");
    if (bad.action === "refuse") expect(bad.error).toMatch(/pending_approvals/);
    // The old kind never reaches a card.
    const sql = ask({ kind: "sql", query: "SELECT 1" });
    expect(sql.action).toBe("refuse");
  });

  test("the card names the check that will run, and its parameters with the defaults filled in", () => {
    const text = previewAction("routine_create", { ...base, preflight: { kind: "check", name: "new_turns", params: { agentID: "ea" } } }, "Agni");
    expect(text).toContain("Before each run: it runs the check new_turns");
    expect(text).toContain('"agentID":"ea"');
    expect(text).toContain('"hours":24');
    expect(text).not.toContain("nothing (it runs on every tick)");
  });
});

describe("the owner's job list", () => {
  test("a routine with a named check goes out in a frame that parses", async () => {
    const db = openDatabase(":memory:");
    cleanup.push(() => db.close());
    const created = await create(db, { ...base, preflight: { kind: "check", name: "failed_jobs" } });
    const replies: ServerFrame[] = [];
    const frameLog = new FrameLog(10);
    const deps = {
      db, router: {} as Router, frameLog, config: {} as never,
      emit: (body: ServerFrameBody): ServerFrame => frameLog.next(body),
      reply: (body: ServerFrameBody): ServerFrame => { const frame = frameLog.next(body, { replay: false }); replies.push(frame); return frame; },
      send: () => undefined, close: () => undefined,
    } as DispatchDeps;
    const session = { id: "conn", authed: true, agentID: "ea", aborts: new Map() } as Session;
    await dispatch(deps, session, JSON.stringify({ type: "job.list" }));
    const parsed = parseServerFrame(JSON.parse(JSON.stringify(replies[0])));
    expect(parsed.ok, parsed.ok ? "" : JSON.stringify(parsed.error)).toBe(true);
    const jobs = (replies[0] as unknown as { jobs: Array<{ id: string; routine?: { preflight: string } }> }).jobs;
    expect(jobs.find((job) => job.id === created.jobID)?.routine?.preflight).toBe("check");
  });
});

describe("migration 63's promise: the bot can recreate a paused routine with a named check", () => {
  test("a routine paused for its SQL pre-check is recreated by routine_create with a named check, and it runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agni-m63-recreate-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "agni.db");

    // A database as it was before migration 63: a routine holding a model-written query.
    const first = openDatabase(path);
    const legacy = await create(first, { ...base, name: "Task watcher", preflight: { kind: "none" } });
    first.run("UPDATE routines SET preflight = ? WHERE id = ?", [JSON.stringify({ kind: "sql", query: "SELECT count(*) FROM tasks" }), legacy.id]);
    first.run("DELETE FROM schema_migrations WHERE id = 63");
    first.close();

    // Opening it applies migration 63: the routine is paused, and the run row tells the owner what to do.
    const db = openDatabase(path);
    cleanup.push(() => db.close());
    const note = db.query<{ error: string }, [string]>("SELECT error FROM routine_runs WHERE routine_id = ?").get(legacy.id);
    expect(note?.error).toContain("recreate it with a named check");
    expect(db.query("SELECT enabled FROM jobs WHERE id = ?").get(legacy.jobID)).toEqual({ enabled: 0 });

    // The bot does as the note says.
    const again = await create(db, { ...base, name: "Task watcher", preflight: { kind: "check", name: "open_tasks" } });
    expect(again.preflight).toEqual({ kind: "check", name: "open_tasks", params: {} });
    expect(db.query("SELECT enabled FROM jobs WHERE id = ?").get(again.jobID)).toEqual({ enabled: 1 });
    expect((await runPreflight(again.preflight, db, null)).changed).toBe(true);
  });
});
