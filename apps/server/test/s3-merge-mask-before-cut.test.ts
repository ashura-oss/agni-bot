/**
 * Sprint 3 merge fix round 1, item 4: the task loop masks a secret before it cuts the text, never after.
 *
 * A secret that straddles a cut is no longer a whole value when `redact()` runs, so the part before the cut goes out unmasked:
 *  - a tool's error message was cut to 500 characters, stored and given to the model, and only then masked;
 *  - the `tool.end` frame's preview was cut to 120 characters (error and success alike) and masked later by the socket;
 *  - the `tool.start` preview was cut to 60 to 120 characters and then masked.
 * Each test places a registered key so that it straddles the cut, through a real turn and a tool that echoes what it was given.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerFrameBody } from "@agni/protocol";
import { runTaskTurn } from "../src/agent/task-loop";
import { openDatabase } from "../src/db";
import { HealthTracker } from "../src/models/health";
import { Router } from "../src/models/router";
import { readFile } from "../src/tools/read-file";
import { createThread } from "../src/stores/threads";
import { registerSecret } from "../src/util/redact";
import { provider, sseResponse, sseToolCall } from "./ws-harness";

const KEY = "sk-cut-canary-0a1b2c3d4e5f6a7b8c9d";
/** Enough of the key that seeing it means the key leaked, and short enough that a cut can leave it whole-but-for-its-end. */
const LEAK = KEY.slice(0, 14);

let root = "";
let scratch = "";
let db: Database;
let savedScratch: string | undefined;
beforeEach(() => {
  savedScratch = process.env.AGNI_SCRATCH_DIR;
  root = mkdtempSync(join(tmpdir(), "agni-mergecut-"));
  scratch = join(root, "scratch");
  mkdirSync(scratch, { recursive: true });
  process.env.AGNI_SCRATCH_DIR = scratch;
  db = openDatabase(":memory:");
  registerSecret(KEY);
});
afterEach(() => {
  db.close();
  if (savedScratch === undefined) delete process.env.AGNI_SCRATCH_DIR;
  else process.env.AGNI_SCRATCH_DIR = savedScratch;
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

interface Turn { frames: ServerFrameBody[]; stored: { args: string; result: string | null }; messageLog: string }

/** One turn in which the model makes one call to `tool`, then answers. */
async function turnWith(tool: string, args: Record<string, unknown>): Promise<Turn> {
  let request = 0;
  const router = new Router([provider], new HealthTracker(), (async () => (++request === 1 ? sseToolCall(tool, args) : sseResponse("done"))) as unknown as typeof fetch);
  const frames: ServerFrameBody[] = [];
  const thread = createThread(db, "ea");
  await runTaskTurn(db, router, { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, {
    threadID: thread.id, text: "go",
    persona: { id: "ea", name: "Ava", color: "#fff", role: "r", systemPromptTemplate: "x", systemPrompt: "x", tools: ["read_file", "memory_write"] },
    emit: (frame) => { frames.push(frame); },
    signal: new AbortController().signal,
  });
  const stored = db.query<{ args: string; result: string | null }, []>("SELECT args, result FROM tool_calls").get()!;
  const messageLog = db.query<{ message_log: string }, []>("SELECT message_log FROM agent_sessions").get()!.message_log;
  return { frames, stored, messageLog };
}

/** `length` characters of path: segments of up to 100 characters joined by `/` (a name may not be longer than 255). */
function pathOf(length: number): string {
  const segments: string[] = [];
  let left = length;
  while (left > 0) {
    const size = Math.min(100, left);
    segments.push("f".repeat(size));
    left -= size + 1; // the separator
  }
  return segments.join("/").slice(0, length);
}

describe("a tool error is masked before it is cut to 500 characters", () => {
  /** A read of a file that is not there: the error message holds the whole path, so the key's place in it is chosen by the path's length. */
  function missingFileWithKeyAt(offset: number): string {
    const probe = (() => { try { readFile({ path: "zq9zq9/x" }); } catch (error) { return (error as Error).message; } return ""; })();
    const start = probe.indexOf("zq9zq9");
    expect(start, "the error message of a missing file no longer holds its path").toBeGreaterThan(0);
    const lead = offset - start - 1;
    expect(lead, "the scratch folder's path is too long to place the key at the cut").toBeGreaterThan(0);
    return `${pathOf(lead)}/${KEY}`;
  }

  test("the stored result, the message log and the tool.end preview hold no part of a key that straddles the cut", async () => {
    const path = missingFileWithKeyAt(485);
    const { frames, stored, messageLog } = await turnWith("read_file", { path });
    const failed = JSON.parse(stored.result!) as { error: string };
    // The key sits at 485 to 520 of a message cut at 500: this is the test's own check that the cut falls inside it.
    expect(failed.error, "the cut did not fall inside the key: the test is not testing the cut").toContain("ENOENT");
    expect(failed.error).not.toContain(LEAK);
    expect(messageLog).not.toContain(LEAK);
    const end = frames.find((frame) => frame.type === "tool.end");
    expect(end && "preview" in end ? end.preview : "").not.toContain(LEAK);
  });
});

describe("the tool.end preview is masked before it is cut to 120 characters", () => {
  test("an error whose message holds the key across the cut", async () => {
    // A directory named for the key: reading it fails with "<path> is not a file", the key at 100 to 135.
    const name = `${"d".repeat(100)}${KEY}`;
    mkdirSync(join(scratch, name));
    const { frames, stored } = await turnWith("read_file", { path: name });
    expect(JSON.parse(stored.result!).error, "the tool did not fail as the test expects").toContain("is not a file");
    const end = frames.find((frame) => frame.type === "tool.end");
    expect(end && "preview" in end ? end.preview : "(no tool.end frame)").not.toContain(LEAK);
  });

  test("a result whose JSON holds the key across the cut", async () => {
    writeFileSync(join(scratch, "note.txt"), `${"x".repeat(60)}${KEY}`);
    const { frames, stored } = await turnWith("read_file", { path: "note.txt" });
    expect(stored.result).toContain("[redacted]");
    const end = frames.find((frame) => frame.type === "tool.end");
    expect(end && "preview" in end ? end.preview : "(no tool.end frame)").not.toContain(LEAK);
  });
});

describe("the tool.start preview is masked before it is cut", () => {
  test("a memory note that holds the key across the cut at 60 characters", async () => {
    const { frames } = await turnWith("memory_write", { text: `${"y".repeat(40)}${KEY}` });
    const start = frames.find((frame) => frame.type === "tool.start");
    expect(start && "preview" in start ? start.preview : "(no tool.start frame)").not.toContain(LEAK);
  });
});
