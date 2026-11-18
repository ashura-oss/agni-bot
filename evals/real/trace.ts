/**
 * Span-shaped traces for an eval episode, one JSON span per line, shaped like
 * OpenTelemetry spans (trace id, span id, parent span id, start and end,
 * status, attributes; model-call attributes use the `gen_ai.*` names).
 *
 * The tree: one `episode` span; a `turn` span per turn; under each turn the
 * `model_call` spans that started inside it and its `tool_call` spans; an
 * `approval` span per card the owner answered. Spans carry names, counts and
 * outcomes, never tool arguments, results or prompt text.
 */
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { ApprovalRec } from "./client";
import type { CallRecord } from "./types";

export type SpanKind = "episode" | "turn" | "model_call" | "tool_call" | "approval";
export type SpanAttributes = Record<string, string | number | boolean | null>;

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: SpanKind;
  startTime: string;
  endTime: string;
  durationMs: number;
  status: "ok" | "error";
  attributes: SpanAttributes;
}

/** A `turns` row. */
export interface TurnRow {
  id: string;
  agent_id: string;
  stop_reason: string | null;
  started_at: string;
  ended_at: string | null;
}

export interface ToolSpanRow {
  callId: string;
  turn: string;
  tool: string;
  ok: number;
  /** `tool_calls.created_at`, taken as the end of the call. */
  at: string;
  durationMs: number | null;
}

export const newSpanId = (): string => randomBytes(8).toString("hex");
export const newTraceId = (): string => randomBytes(16).toString("hex");
const iso = (ms: number): string => new Date(ms).toISOString();

export interface TraceInput {
  traceId: string;
  episode: { name: string; startMs: number; endMs: number; ok: boolean; attributes: SpanAttributes };
  calls: CallRecord[];
  turns: TurnRow[];
  tools: ToolSpanRow[];
  approvals: ApprovalRec[];
}

export function buildTrace(input: TraceInput): Span[] {
  const { traceId } = input;
  const span = (parent: Span | null, name: string, kind: SpanKind, startMs: number, endMs: number, ok: boolean, attributes: SpanAttributes): Span => ({
    traceId,
    spanId: newSpanId(),
    parentSpanId: parent ? parent.spanId : null,
    name,
    kind,
    startTime: iso(startMs),
    endTime: iso(endMs),
    durationMs: Math.max(0, endMs - startMs),
    status: ok ? "ok" : "error",
    attributes,
  });
  const root = span(null, input.episode.name, "episode", input.episode.startMs, input.episode.endMs, input.episode.ok, input.episode.attributes);
  const spans: Span[] = [root];
  const turnSpans = new Map<string, Span>();
  for (const turn of input.turns) {
    const start = Date.parse(turn.started_at);
    const end = turn.ended_at ? Date.parse(turn.ended_at) : input.episode.endMs;
    const s = span(root, `turn ${turn.agent_id}`, "turn", start, end, turn.stop_reason === "end", {
      "agni.turn_id": turn.id,
      "agni.agent_id": turn.agent_id,
      "agni.stop_reason": turn.stop_reason,
    });
    turnSpans.set(turn.id, s);
    spans.push(s);
  }
  const turnAt = (ms: number): Span => {
    for (const s of turnSpans.values()) if (Date.parse(s.startTime) <= ms && ms <= Date.parse(s.endTime)) return s;
    return root;
  };
  for (const c of input.calls) {
    spans.push(
      span(turnAt(c.startMs), `model ${c.model || "?"}`, "model_call", c.startMs, c.endMs, c.status === 200 && !c.blocked, {
        "gen_ai.request.model": c.model,
        "gen_ai.usage.input_tokens": c.promptTokens ?? null,
        "gen_ai.usage.output_tokens": c.completionTokens ?? null,
        "agni.cached_tokens": c.cachedReported ? (c.cachedTokens ?? 0) : null,
        "agni.first_token_ms": c.firstMs,
        "agni.finish": c.finish,
        "agni.tool_calls": c.toolNames.length,
        "agni.blocked": c.blocked,
        "agni.charged_usd": c.chargedUsd,
        "http.status": c.status,
      }),
    );
  }
  for (const t of input.tools) {
    const end = Date.parse(t.at);
    spans.push(span(turnSpans.get(t.turn) ?? root, `tool ${t.tool}`, "tool_call", end - (t.durationMs ?? 0), end, t.ok === 1, {
      "agni.tool": t.tool,
      "agni.call_id": t.callId,
    }));
  }
  for (const a of input.approvals) {
    spans.push(span(root, "approval", "approval", a.at, a.at, true, { "agni.action": a.action.slice(0, 120), "agni.decision": a.decision }));
  }
  return spans;
}

export function writeTrace(path: string, spans: Span[]): void {
  writeFileSync(path, spans.map((s) => JSON.stringify(s)).join("\n") + "\n");
}
