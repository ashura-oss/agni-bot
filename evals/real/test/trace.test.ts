import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTrace, newTraceId, writeTrace } from "../trace";
import type { CallRecord } from "../types";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const T0 = Date.parse("2026-11-18T10:00:00.000Z");
function call(startMs: number, over: Partial<CallRecord> = {}): CallRecord {
  return {
    startedAt: new Date(startMs).toISOString(), startMs, endMs: startMs + 100, path: "/api/v1/chat/completions", model: "m", hadTools: true,
    nMessages: 2, reqChars: 100, status: 200, blocked: false, aborted: false, firstMs: 40, finish: "stop", contentLen: 10, reasoningLen: 0,
    toolNames: [], cachedReported: false, chargedUsd: 0.001, ...over,
  };
}

function sample() {
  return buildTrace({
    traceId: newTraceId(),
    episode: { name: "episode t", startMs: T0, endMs: T0 + 60_000, ok: true, attributes: { "agni.task": "t" } },
    turns: [{ id: "turn_1", agent_id: "ea", stop_reason: "end", started_at: new Date(T0 + 1000).toISOString(), ended_at: new Date(T0 + 10_000).toISOString() }],
    calls: [call(T0 + 2000), call(T0 + 30_000, { status: 402, blocked: true })],
    tools: [{ callId: "call_1", turn: "turn_1", tool: "read_file", ok: 1, at: new Date(T0 + 5000).toISOString(), durationMs: 20 }],
    approvals: [{ requestID: "apr_1", action: "run shell: ls", preview: "", decision: "once", at: T0 + 4000 }],
  });
}

describe("episode trace", () => {
  test("one trace, one root, unique span ids", () => {
    const spans = sample();
    expect(new Set(spans.map((s) => s.traceId)).size).toBe(1);
    expect(spans.filter((s) => s.parentSpanId === null).map((s) => s.kind)).toEqual(["episode"]);
    expect(new Set(spans.map((s) => s.spanId)).size).toBe(spans.length);
    expect(spans.map((s) => s.kind).sort()).toEqual(["approval", "episode", "model_call", "model_call", "tool_call", "turn"]);
  });

  test("calls and tools hang under the turn they belong to; a call outside every turn hangs under the episode", () => {
    const spans = sample();
    const root = spans.find((s) => s.kind === "episode")!;
    const turn = spans.find((s) => s.kind === "turn")!;
    const [inside, outside] = spans.filter((s) => s.kind === "model_call");
    expect(inside!.parentSpanId).toBe(turn.spanId);
    expect(outside!.parentSpanId).toBe(root.spanId);
    expect(outside!.status).toBe("error");
    expect(spans.find((s) => s.kind === "tool_call")!.parentSpanId).toBe(turn.spanId);
  });

  test("cached tokens are null, not 0, when the provider did not report them", () => {
    const calls = sample().filter((s) => s.kind === "model_call");
    expect(calls[0]!.attributes["agni.cached_tokens"]).toBeNull();
  });

  test("the trace file is one JSON span per line", () => {
    const dir = mkdtempSync(join(tmpdir(), "agni-eval-trace-"));
    dirs.push(dir);
    const spans = sample();
    writeTrace(join(dir, "trace.jsonl"), spans);
    const lines = readFileSync(join(dir, "trace.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(spans.length);
    expect(JSON.parse(lines[0]!).kind).toBe("episode");
  });
});
