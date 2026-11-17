/**
 * One eval episode: a fresh throwaway home, the task's fixtures, a model
 * (OpenRouter through the proxy, or a scripted mock in stub mode), a real
 * server, the real WebSocket protocol, the task's owner messages, then the
 * end-state grade, the ledger, the trace, and cleanup.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockProvider, type MockProvider } from "../../tools/mock-provider/src/server";
import { AgniClient } from "./client";
import { readLedger } from "./ledger";
import { startProxy, type ProxyHandle } from "./proxy";
import { startEpisodeServer, type EpisodeServer } from "./server";
import type { SpendGuard } from "./spend";
import { buildTrace, newTraceId, writeTrace, type TurnRow } from "./trace";
import type { Ctx, EpisodeMode, EpisodeResult, TaskDef } from "./types";
import { sleep, toolRows, type ToolRow } from "./util";
import type { WebFixtures } from "./web-fixtures";

export const LIVE_UPSTREAM = "https://openrouter.ai";
/** The model name a stub episode runs under. */
export const STUB_MODEL = "stub/model";

export interface EpisodeOptions {
  task: TaskDef;
  /** The OpenRouter model id (live mode). Ignored in stub mode. */
  model: string;
  rep: number;
  mode: EpisodeMode;
  guard: SpendGuard;
  web: WebFixtures;
  /** The episode writes `result.json`, `trace.jsonl`, `harness.log` and the server logs to `<outDir>/<ep>/`. */
  outDir: string;
  /** The OpenRouter key, required in live mode. It goes to the proxy only and is never written. */
  apiKey?: string;
  /** Keep the throwaway AGNI_HOME afterwards (debugging). */
  keepHome?: boolean;
}

export function shortModel(model: string): string {
  return model.replace(/^.*\//, "").replace(/[^a-z0-9]+/gi, "").toLowerCase().slice(0, 24) || "model";
}

export function episodeId(task: string, model: string, rep: number, mode: EpisodeMode): string {
  return `${task}-${mode === "live" ? shortModel(model) : mode}-r${rep}`;
}

export async function runEpisode(o: EpisodeOptions): Promise<EpisodeResult> {
  if (o.mode === "live" && !o.apiKey) throw new Error("live mode needs the OpenRouter key (OPENROUTER_API_KEY)");
  if (o.mode !== "live" && !o.task.stub) throw new Error(`task ${o.task.id} has no stub script`);
  const model = o.mode === "live" ? o.model : STUB_MODEL;
  const ep = episodeId(o.task.id, model, o.rep, o.mode);
  const epDir = join(o.outDir, ep);
  mkdirSync(epDir, { recursive: true });
  const home = mkdtempSync(join(tmpdir(), "agni-eval-"));
  const scratch = join(home, "scratch");
  const outbox = join(home, "outbox");
  mkdirSync(scratch, { recursive: true });
  mkdirSync(outbox, { recursive: true });
  const webDir = join(o.web.root, ep);
  mkdirSync(webDir, { recursive: true });
  const dbPath = join(home, "data", "agni.sqlite");
  const logLines: string[] = [];
  const startedMs = Date.now();
  const result: EpisodeResult = {
    ep, task: o.task.id, model, rep: o.rep, mode: o.mode, startedAt: new Date(startedMs).toISOString(), wallMs: 0, home,
    grade: null, ledger: null, calls: [], turnMs: [],
  };
  const ctx: Ctx = {
    model, rep: o.rep, ep, home, scratch, outbox, appScratch: scratch, appOutbox: outbox, port: 0, client: new AgniClient(),
    db: () => new Database(dbPath), webDir, webBase: o.web.baseFor(ep), notes: {},
    log: (message) => { logLines.push(`${new Date().toISOString()} ${message}`); },
  };
  let mock: MockProvider | undefined;
  let proxy: ProxyHandle | undefined;
  let server: EpisodeServer | undefined;
  let exp: unknown;
  let setupDone = false;
  try {
    exp = o.task.setup(ctx);
    setupDone = true;
    let upstreamBase = LIVE_UPSTREAM;
    if (o.mode !== "live") {
      const script = o.mode === "stub-good" ? o.task.stub!.good(ctx, exp) : o.task.stub!.bad(ctx, exp);
      mock = createMockProvider({ script, model: STUB_MODEL, delayMs: 1 });
      upstreamBase = `http://127.0.0.1:${mock.port}`;
    }
    proxy = startProxy({ upstreamBase, guard: o.guard, ...(o.mode === "live" ? { upstreamKey: o.apiKey! } : {}) });
    server = await startEpisodeServer({ home, scratch, baseUrl: proxy.url, model, ...(o.task.env ? { env: o.task.env } : {}), logDir: epDir });
    ctx.port = server.port;
    ctx.client = await AgniClient.connect(server.port, server.token);
    // First run: the owner names the default bot, as round 5 did.
    await sleep(800);
    ctx.client.send({ type: "msg.send", text: "Ada", channelId: "main" });
    try {
      await ctx.client.waitFrame((f) => f.type === "agent.updated", 6000);
    } catch {
      ctx.log("no agent.updated after naming the bot");
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        o.task.run(ctx, exp),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`task wall limit ${o.task.maxMs} ms`)), o.task.maxMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    await sleep(1500);
    result.grade = await o.task.grade(ctx, exp);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    ctx.log(`EPISODE ERROR ${result.error}`);
    if (setupDone && existsSync(dbPath)) {
      try {
        result.grade = await o.task.grade(ctx, exp);
      } catch (gradeError) {
        ctx.log(`grading after the error failed: ${String(gradeError)}`);
      }
    }
  }
  result.wallMs = Date.now() - startedMs;

  // Read the episode database before the server stops and the home goes.
  let turns: TurnRow[] = [];
  let tools: ToolRow[] = [];
  if (existsSync(dbPath)) {
    try {
      const db = ctx.db();
      try {
        result.ledger = readLedger(db);
        turns = db.query<TurnRow, []>("SELECT id, agent_id, stop_reason, started_at, ended_at FROM turns ORDER BY started_at").all();
      } finally {
        db.close();
      }
      tools = toolRows(ctx);
    } catch (error) {
      ctx.log(`reading the episode database failed: ${String(error)}`);
    }
  }
  result.turnMs = turns.filter((t) => t.ended_at !== null).map((t) => Date.parse(t.ended_at!) - Date.parse(t.started_at));
  ctx.client.close();
  if (server) await server.stop();
  result.calls = proxy ? [...proxy.calls] : [];
  proxy?.stop();
  mock?.stop();

  writeTrace(
    join(epDir, "trace.jsonl"),
    buildTrace({
      traceId: newTraceId(),
      episode: {
        name: `episode ${ep}`,
        startMs: startedMs,
        endMs: startedMs + result.wallMs,
        ok: result.grade?.pass === true,
        attributes: { "agni.task": o.task.id, "agni.model": model, "agni.rep": o.rep, "agni.mode": o.mode, "agni.pass": result.grade?.pass ?? null },
      },
      calls: result.calls,
      turns,
      tools: tools.map((t) => ({ callId: t.callId, turn: t.turn, tool: t.tool, ok: t.ok, at: t.at, durationMs: t.durationMs })),
      approvals: ctx.client.approvals,
    }),
  );
  writeFileSync(join(epDir, "harness.log"), logLines.join("\n"));
  writeFileSync(join(epDir, "result.json"), JSON.stringify({ ...result, notes: ctx.notes }, null, 1));
  if (!o.keepHome) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  return result;
}
