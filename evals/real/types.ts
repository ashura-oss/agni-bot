/**
 * Types shared by the real-model eval harness (Sprint 5, item 8).
 *
 * A task is graded on the end state: `grade` reads the episode's files,
 * database rows and protocol frames, never the model's prose alone.
 */
import type { Database } from "bun:sqlite";
import type { MockStep } from "../../tools/mock-provider/src/server";
import type { AgniClient } from "./client";

export interface Ctx {
  model: string;
  rep: number;
  /** Episode id, e.g. `r5-j1-deepseekv41flash-r1`. */
  ep: string;
  /** The throwaway AGNI_HOME of this episode. */
  home: string;
  /** `home/scratch`: the server's scratch folder and working directory. */
  scratch: string;
  /** `home/outbox`: a folder outside scratch (a write there needs the owner). */
  outbox: string;
  /** The same folders as the app names them. Equal to `scratch` and `outbox` here; kept for the round-5 graders. */
  appScratch: string;
  appOutbox: string;
  port: number;
  client: AgniClient;
  /** Opens the episode's database. The caller closes it. */
  db: () => Database;
  /** Where this episode's fixture web pages are written. */
  webDir: string;
  /** The URL those pages are served under: `http://fixtures.example:<port>/<ep>`. */
  webBase: string;
  notes: Record<string, any>;
  log: (message: string) => void;
}

export interface Grade {
  pass: boolean;
  /** Share of sub-goals met, 0..1. */
  partial: number;
  sub: Record<string, boolean>;
  /** Forbidden actions seen. Any entry fails the episode. */
  forbidden: string[];
  notes: Record<string, any>;
}

export interface TaskStub<E> {
  /** A scripted model that does the task right: the grader must pass it. */
  good(ctx: Ctx, exp: E): MockStep[];
  /** A scripted model that gets one thing wrong: the grader must fail it. */
  bad(ctx: Ctx, exp: E): MockStep[];
}

export interface TaskDef<E = any> {
  id: string;
  title: string;
  /** Where the task comes from, e.g. `round5:j1`, `round4:receivables`, `issue:<ISSUES.md line>`. */
  source: string;
  /** Wall limit for `run`, ms. */
  maxMs: number;
  /** Server environment for this task, applied on top of `EVAL_SERVER_ENV`. */
  env?: Record<string, string>;
  setup(ctx: Ctx): E;
  run(ctx: Ctx, exp: E): Promise<void>;
  grade(ctx: Ctx, exp: E): Grade | Promise<Grade>;
  stub?: TaskStub<E>;
}

/** Pass only when there is at least one sub-goal, every sub-goal is met and nothing forbidden happened. */
export function finish(sub: Record<string, boolean>, forbidden: string[], notes: Record<string, any>): Grade {
  const values = Object.values(sub);
  const partial = values.length ? values.filter(Boolean).length / values.length : 0;
  return { pass: values.length > 0 && values.every(Boolean) && forbidden.length === 0, partial, sub, forbidden, notes };
}

/** One model call as the eval proxy saw it. Request headers are never recorded. */
export interface CallRecord {
  startedAt: string;
  startMs: number;
  endMs: number;
  path: string;
  model: string;
  hadTools: boolean;
  nMessages: number;
  reqChars: number;
  /** HTTP status returned to the app; 402 when the spend cap refused the call. */
  status: number;
  /** The spend cap refused the call before it was sent. */
  blocked: boolean;
  aborted: boolean;
  error?: string;
  /** Ms from the request to the first content, reasoning or tool-call delta; -1 when none came. */
  firstMs: number;
  finish: string;
  contentLen: number;
  reasoningLen: number;
  toolNames: string[];
  promptTokens?: number;
  completionTokens?: number;
  /** Cached prompt tokens, set only when the provider reported the field. */
  cachedTokens?: number;
  cachedReported: boolean;
  /** The provider's own cost figure (OpenRouter `usage.cost`), when it gave one. */
  reportedCostUsd?: number;
  /** What the spend guard charged for this call. */
  chargedUsd: number;
}

/** What the episode's Sprint 2 usage ledger says. */
export interface LedgerSummary {
  /** Per-call rows (`call_kind` set). The old per-turn rows are left out. */
  calls: number;
  /** Sum of `cost_usd` over those rows. Rows with unknown cost add nothing here and are counted in `unknownCostCalls`. */
  costUsd: number;
  unknownCostCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** Calls that needed a tool-call repair; null while the ledger has no such column (item 7). */
  repairCalls: number | null;
  /** Calls that escalated to another model; null while the ledger has no such column. */
  escalatedCalls: number | null;
}

export type EpisodeMode = "live" | "stub-good" | "stub-bad";

export interface EpisodeResult {
  ep: string;
  task: string;
  model: string;
  rep: number;
  mode: EpisodeMode;
  startedAt: string;
  wallMs: number;
  /** The throwaway AGNI_HOME (removed after the episode unless kept). */
  home: string;
  grade: Grade | null;
  error?: string;
  /** Set when the episode never started (for example: the spend cap had no room left). */
  skipped?: string;
  ledger: LedgerSummary | null;
  calls: CallRecord[];
  /** Server-side duration of each finished turn, ms. */
  turnMs: number[];
}
