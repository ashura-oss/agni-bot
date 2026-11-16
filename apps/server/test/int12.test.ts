/**
 * int12: the routine state cut decides by position in the whole turn, and old
 * closure notes stay recognised.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { hideRoutineState } from "../src/routines/run";
import { stripRoutineState } from "../src/routines/prompt";
import { appendMessage, createThread } from "../src/stores/threads";
import { createTurn } from "../src/stores/threads";

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

function turnWith(replies: string[]): { turnID: string; texts: () => string[] } {
  db = openDatabase(":memory:");
  const thread = createThread(db, "ea");
  createTurn(db, { id: "trn_r", threadID: thread.id, agentID: "ea" });
  for (const text of replies) appendMessage(db, { threadID: thread.id, turnID: "trn_r", role: "assistant", text });
  return { turnID: "trn_r", texts: () => db!.query<{ text: string }, []>("SELECT text FROM messages WHERE role = 'assistant' ORDER BY rowid").all().map((row) => row.text) };
}
const JSON_REPORT = '```json\n{"rows": [1, 2, 3]}\n```';
const STATE = 'Routine state (used next run):\n```json\n{"seen": 2}\n```';

describe("hideRoutineState cuts only the state block, from the turn's last reply", () => {
  test("earlier replies are left exactly as they are, json reports included", () => {
    const keyed = 'Routine state (used next run)\n```json\n{"stateContext":{"a":1}}\n```';
    const turn = turnWith([`Step one:\n${JSON_REPORT}`, JSON_REPORT, `First.\n\n${keyed}`, "All done."]);
    hideRoutineState(db!, turn.turnID);
    expect(turn.texts()).toEqual([`Step one:\n${JSON_REPORT}`, JSON_REPORT, `First.\n\n${keyed}`, "All done."]);
  });

  test("the last reply's keyed block and its label are cut, and nothing else", () => {
    const keyed = 'Routine state (used next run):\n```json\n{"stateContext":{"seen":2}}\n```';
    const turn = turnWith(["Working.", `Report.\n${JSON_REPORT}\n\n${keyed}`]);
    hideRoutineState(db!, turn.turnID);
    expect(turn.texts()).toEqual(["Working.", `Report.\n${JSON_REPORT}`]);
  });

  test("the last reply's labelled json block without the key is cut with its label", () => {
    const turn = turnWith(["Working.", `Report.\n\n${STATE}`]);
    hideRoutineState(db!, turn.turnID);
    expect(turn.texts()).toEqual(["Working.", "Report."]);
  });

  test("a json block with no label and no key is the routine's own content: kept, wherever it sits", () => {
    const reply = `Here is the data:\n${JSON_REPORT}`;
    const turn = turnWith([reply]);
    hideRoutineState(db!, turn.turnID);
    expect(turn.texts()).toEqual([reply]);
    expect(stripRoutineState(reply)).toBe(reply);
  });

  test("a last reply that is only the state block is not deleted: it says the run completed", () => {
    const turn = turnWith(["Working.", STATE]);
    hideRoutineState(db!, turn.turnID);
    expect(turn.texts()).toEqual(["Working.", "Routine completed; state saved."]);
  });

  test("a last reply that ends in a plain fence (no json label) keeps it, with or without a label", () => {
    const reply = "Run this:\n```\nnpm test\n```";
    const turn = turnWith([reply]);
    hideRoutineState(db!, turn.turnID);
    expect(turn.texts()).toEqual([reply]);
    const labelled = "Done.\n\nRoutine state (used next run):\n```\nsomething\n```";
    expect(stripRoutineState(labelled)).toBe(labelled);
  });

  test("NOTHING_TO_REPORT as the last reply stores nothing; earlier replies stay", () => {
    const turn = turnWith(["Checked the inbox.", `NOTHING_TO_REPORT\n\n${STATE}`]);
    hideRoutineState(db!, turn.turnID);
    expect(turn.texts()).toEqual(["Checked the inbox."]);
  });
});

describe("notes stored under earlier wordings, with no record, are plain system text now (S2-17)", () => {
  const earlier = [
    "[The owner pressed Stop on my previous request, so I did not finish it. That request is closed: I will not resume it, retry its actions, or ask for its approvals again unless the owner asks for it again in a new message.]",
    "[My previous request was interrupted by a restart and was not completed. That request is closed: I will not resume it, re-run its tool calls, or ask for its approvals again unless the owner asks for it again in a new message.]",
    "[My previous request came from a device that has since been revoked. That request is closed: I will not resume it, retry its actions, or ask for its approvals again.]",
  ];

  test("the words alone are not enough: only a row with the record is a closure note", async () => {
    const { isClosureNote } = await import("../src/agent/closure");
    const { blockTranscript } = await import("../src/agent/rollover");
    for (const note of earlier) {
      expect(isClosureNote("system", note)).toBe(false);
      expect(blockTranscript([{ role: "system", text: note }])).not.toContain("is closed");
      // With the record they are read as before.
      expect(isClosureNote("system", note, "closure")).toBe(true);
      expect(blockTranscript([{ role: "system", text: note, kind: "closure" }])).toContain("is closed");
    }
    expect(isClosureNote("system", "[Check the inbox and report.]")).toBe(false);
  });
});

describe("the running turn named for a conversation is the newest one", () => {
  test("two turns in one conversation: the later registered one is returned", async () => {
    const { registerTurn, runningTurnIn, unregisterTurn } = await import("../src/ws/turn-registry");
    const first = new AbortController();
    const second = new AbortController();
    registerTurn("trn_old", "thr_a", first);
    registerTurn("trn_new", "thr_b", second);
    try {
      expect(runningTurnIn(["thr_a", "thr_b"])).toEqual({ turnID: "trn_new", threadID: "thr_b" });
    } finally {
      unregisterTurn("trn_old", first);
      unregisterTurn("trn_new", second);
    }
  });
});


describe("task_status gives the full result only to the bot that delegated the task", () => {
  async function setup() {
    const { ToolRegistry } = await import("../src/tools/registry");
    const { registerDelegateTaskTool } = await import("../src/tools/delegate-task-tool");
    const { saveArtifact } = await import("../src/stores/artifacts");
    const { setDelegationArtifact, setDelegationState } = await import("../src/stores/tasks");
    db = openDatabase(":memory:");
    db.run("UPDATE agents SET visibility = 'shared' WHERE id = 'researcher'");
    const as = (agentID: string) => {
      const registry = new ToolRegistry();
      registerDelegateTaskTool(registry, { db: db!, emit: () => undefined, currentAgentID: agentID, channelID: "main", parentTurnID: "trn_p", parentThreadID: "thr_p" });
      const ctx = { threadID: "thr_p", turnID: "trn_p", signal: new AbortController().signal };
      return (name: string, args: Record<string, unknown>) =>
        (registry.get(name)!.handler as unknown as (a: Record<string, unknown>, c: unknown) => Promise<Record<string, unknown>>)(args, ctx);
    };
    const queued = await as("ea")("delegate_task", { toAgentID: "researcher", goal: "Write the report" }) as { taskID: string };
    const long = Array.from({ length: 60 }, (_, i) => `private finding ${i + 1}`).join("\n");
    const artifact = saveArtifact(db, { taskID: queued.taskID, agentID: "researcher", content: long });
    setDelegationArtifact(db, queued.taskID, artifact.id);
    setDelegationState(db, queued.taskID, "done", "done");
    return { as, taskID: queued.taskID, artifactID: artifact.id };
  }

  test("the delegating bot and the bot that did the work see all of it", async () => {
    const { as, taskID } = await setup();
    for (const caller of ["ea", "researcher"]) {
      const view = await as(caller)("task_status", { taskID }) as { result: string };
      expect(view.result.split("\n")).toHaveLength(60);
    }
  });

  test("any other bot holding the task ID gets the short summary, no artifact reference and no notes", async () => {
    const { as, taskID } = await setup();
    const view = await as("coder")("task_status", { taskID }) as { result: string; artifactRef: string | null; resultRedacted: boolean };
    expect(view.result.length).toBeLessThanOrEqual(241);
    expect(view.result).not.toContain("\n");
    expect(view.result).not.toContain("private finding 40");
    expect(view.artifactRef).toBeNull();
  });

  test("delegate_wait gives the same view", async () => {
    const { as, taskID } = await setup();
    const view = await as("coder")("delegate_wait", { taskID, timeoutMs: 1000 }) as { result: string };
    expect(view.result.length).toBeLessThanOrEqual(241);
  });
});
