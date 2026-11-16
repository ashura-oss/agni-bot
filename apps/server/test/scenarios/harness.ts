/**
 * Scenario harness: a real in-process Agni server driven over real WebSocket
 * frames, with a real SQLite file in a throwaway AGNI_HOME and a scripted
 * fake model behind the real Router. No network, no paid model, no keys.
 *
 * What is real: `startServer` (ws/server.ts), `dispatch`, the task loop, the
 * approval broker, every tool, the stores, the job runner, migrations.
 * What is fake: only the model endpoint (`FakeModel.fetch`).
 *
 * Scenario files import this and call `useScenarios()` once at the top; the
 * returned `start()` boots a scenario, and an `afterEach` hook it registered
 * tears everything down (cancels turns, rejects pending cards, closes
 * sockets, removes the temp home, restores env and the process-wide roster).
 */
import { afterEach, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, parseServerFrame, type ClientFrame, type ServerFrame } from "@agni/protocol";
import { PERSONAS } from "../../src/agent/personas";
import { setUsageRecorder } from "../../src/models/usage-hook";
import { noopAuditSink, setAuditSink } from "../../src/policy/audit-sink";
import { runStartupHooks } from "../../src/startup";
import { mintToken } from "../../src/auth/tokens";
import type { Config } from "../../src/config";
import { openDatabase } from "../../src/db";
import { JobRunner } from "../../src/jobs/runner";
import { registerTurnJob } from "../../src/jobs/turn";
import { HealthTracker } from "../../src/models/health";
import type { ProviderConfig } from "../../src/models/providers";
import { Router } from "../../src/models/router";
import { startServer, type RunningServer } from "../../src/ws/server";

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

/** Poll a condition (used only for database state that has no event to await). */
export async function eventually(
  check: () => boolean,
  options: { timeoutMs?: number; label: string },
): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 3_000);
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${options.label}`);
    await Bun.sleep(10);
  }
}

/** A promise the test opens by hand: holds a model stream mid-response. */
export class Gate {
  readonly promise: Promise<void>;
  private resolveGate!: () => void;
  opened = false;

  constructor() {
    this.promise = new Promise<void>((resolve) => { this.resolveGate = resolve; });
  }

  open(): void {
    this.opened = true;
    this.resolveGate();
  }
}

export const gate = (): Gate => new Gate();

// ---------------------------------------------------------------------------
// the scripted fake model
// ---------------------------------------------------------------------------

export interface ToolCallSpec {
  /** Unique within a turn; generated when omitted. */
  id?: string;
  name: string;
  args: unknown;
}

export interface ModelStep {
  /** Streamed content deltas (a string is one delta). */
  text?: string | string[];
  /** Tool calls emitted in this one response. */
  calls?: ToolCallSpec[];
  /** Token usage the provider reports for this response. */
  usage?: { in: number; out: number };
  /**
   * Pause the stream until the gate opens: after the first text delta, or
   * before the first byte when the step has no text. An abort ends the pause.
   */
  hold?: Gate;
}

export interface WireMessage {
  role: string;
  content: string | Array<{ type: string; text?: string }> | null;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export interface ModelRequest {
  /** 1-based position among the turn requests this model has served. */
  index: number;
  messages: WireMessage[];
  tools: unknown[];
  maxTokens: number | undefined;
}

export const say = (...deltas: string[]): ModelStep => ({ text: deltas });
export const call = (name: string, args: unknown, id?: string): ModelStep => ({ calls: [{ name, args, ...(id ? { id } : {}) }] });
export const calls = (...specs: ToolCallSpec[]): ModelStep => ({ calls: specs });
/** `ea` and other big-toolset bots list most tools by name and load them on demand. */
export const loadTools = (...names: string[]): ModelStep => call("load_tools", { names });

export function textOf(message: WireMessage): string {
  if (typeof message.content === "string") return message.content;
  return (message.content ?? []).map((part) => part.text ?? "").join("");
}

/** What the model was told a tool call returned, as parsed JSON when it is JSON. */
export function toolResult(request: ModelRequest, callID: string): unknown {
  const message = request.messages.find((candidate) => candidate.role === "tool" && candidate.tool_call_id === callID);
  if (!message) return undefined;
  const text = textOf(message);
  try { return JSON.parse(text) as unknown; } catch { return text; }
}

const encoder = new TextEncoder();
const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
const abortError = (): Error => new DOMException("The operation was aborted.", "AbortError");

/**
 * An OpenAI-compatible `chat/completions` endpoint that plays back a script.
 * Turn requests (those that carry tools) consume one step each, in order;
 * helper requests (summaries, compaction: no tools) get a short canned reply
 * and do not consume the script.
 */
export class FakeModel {
  readonly requests: ModelRequest[] = [];
  readonly helperRequests: WireMessage[][] = [];
  /** Turn requests that arrived after the script ran out. */
  overruns = 0;
  private readonly script: ModelStep[] = [];
  private readonly gates = new Set<Gate>();
  private readonly arrivals: Array<{ count: number; resolve: () => void }> = [];
  private callCounter = 0;
  private abandoned = false;

  /** Append steps; they are played in order across turns. */
  queue(...steps: ModelStep[]): void {
    for (const step of steps) {
      this.script.push(step);
      if (step.hold) this.gates.add(step.hold);
    }
  }

  /** Resolves once the model has received at least `count` turn requests. */
  requested(count: number): Promise<void> {
    if (this.requests.length >= count) return Promise.resolve();
    return new Promise((resolve) => this.arrivals.push({ count, resolve }));
  }

  /** End the scenario: open every hold; later requests get a plain closing reply. */
  abandon(): void {
    this.abandoned = true;
    for (const held of this.gates) held.open();
  }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.endsWith("/chat/completions")) throw new Error(`the fake model only serves chat/completions, got ${url}`);
    if (init?.signal?.aborted) throw abortError();
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      messages?: WireMessage[];
      tools?: unknown[];
      max_tokens?: number;
    };
    const messages = body.messages ?? [];
    if (!body.tools || body.tools.length === 0) {
      this.helperRequests.push(messages);
      return this.respond({ text: "ok" }, init?.signal);
    }
    this.requests.push({ index: this.requests.length + 1, messages, tools: body.tools, maxTokens: body.max_tokens });
    for (const arrival of this.arrivals.filter((candidate) => this.requests.length >= candidate.count)) arrival.resolve();
    let step = this.script.shift();
    if (!step) {
      if (!this.abandoned) this.overruns += 1;
      step = { text: "(the scripted model has nothing more to say)" };
    }
    return this.respond(step, init?.signal);
  }) as typeof fetch;

  private respond(step: ModelStep, signal: AbortSignal | null | undefined): Response {
    const iterator = this.chunks(step, signal ?? undefined);
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await iterator.next();
            if (next.done) controller.close();
            else controller.enqueue(encoder.encode(next.value));
          } catch (error) {
            controller.error(error);
          }
        },
        async cancel() {
          await iterator.return(undefined);
        },
      }),
      { status: 200 },
    );
  }

  private async *chunks(step: ModelStep, signal: AbortSignal | undefined): AsyncGenerator<string> {
    const aborted = new Promise<never>((_, reject) => {
      if (signal?.aborted) reject(abortError());
      else signal?.addEventListener("abort", () => reject(abortError()), { once: true });
    });
    aborted.catch(() => undefined);
    const stillOpen = (): void => { if (signal?.aborted) throw abortError(); };
    const hold = async (): Promise<void> => {
      if (step.hold) await Promise.race([step.hold.promise, aborted]);
    };

    const deltas = typeof step.text === "string" ? [step.text] : step.text ?? [];
    if (deltas.length === 0) await hold();
    for (const [position, delta] of deltas.entries()) {
      stillOpen();
      yield sse({ choices: [{ delta: { content: delta } }] });
      if (position === 0) await hold();
    }
    stillOpen();
    if (step.calls?.length) {
      yield sse({
        choices: [{
          delta: {
            tool_calls: step.calls.map((spec, index) => ({
              index,
              id: spec.id ?? `call_${++this.callCounter}`,
              type: "function",
              function: { name: spec.name, arguments: JSON.stringify(spec.args) },
            })),
          },
        }],
      });
    }
    yield sse({
      choices: [{ delta: {}, finish_reason: step.calls?.length ? "tool_calls" : "stop" }],
      ...(step.usage ? { usage: { prompt_tokens: step.usage.in, completion_tokens: step.usage.out } } : {}),
    });
    yield "data: [DONE]\n\n";
  }
}

// ---------------------------------------------------------------------------
// a WebSocket client that records every frame
// ---------------------------------------------------------------------------

type FrameOf<T extends ServerFrame["type"]> = Extract<ServerFrame, { type: T }>;

interface WaitOptions<T extends ServerFrame["type"]> {
  /** Only consider frames at or after this index (see `mark()`). */
  since?: number;
  match?: (frame: FrameOf<T>) => boolean;
  timeoutMs?: number;
  /** What the wait stands for, for the failure message. */
  why?: string;
}

interface Waiter {
  since: number;
  test: (frame: ServerFrame) => boolean;
  resolve: (frame: ServerFrame) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ScenarioClient {
  /** Every valid server frame received, in order. */
  readonly frames: ServerFrame[] = [];
  /**
   * Every frame as the server sent it, before protocol validation strips fields
   * the schema does not know yet (so a test sees `source`, `tier` or `expiresAt`
   * on a card even while the client schema lags the server).
   */
  readonly rawFrames: Array<Record<string, unknown>> = [];
  /** Frames that failed protocol validation (a protocol bug if not empty). */
  readonly invalid: string[] = [];
  readonly closed: Promise<void>;
  /** Highest seq seen: what a reconnect passes to `resync`. */
  lastSeq = 0;
  private readonly waiters = new Set<Waiter>();
  private readonly listeners = new Set<(frame: ServerFrame) => void>();

  private constructor(private readonly ws: WebSocket, readonly label: string) {
    this.closed = new Promise<void>((resolve) => ws.addEventListener("close", () => resolve(), { once: true }));
    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const json = JSON.parse(event.data) as Record<string, unknown>;
      this.rawFrames.push(json);
      const parsed = parseServerFrame(json);
      if (!parsed.ok) {
        this.invalid.push(parsed.error);
        return;
      }
      const frame = parsed.frame;
      this.frames.push(frame);
      this.lastSeq = Math.max(this.lastSeq, frame.seq);
      const index = this.frames.length - 1;
      for (const listener of [...this.listeners]) listener(frame);
      for (const waiter of [...this.waiters]) {
        if (index >= waiter.since && waiter.test(frame)) {
          clearTimeout(waiter.timer);
          this.waiters.delete(waiter);
          waiter.resolve(frame);
        }
      }
    });
  }

  /**
   * Connect, `hello`, then `resync`. A fresh client resyncs from the hello's
   * seq (it wants nothing old); a reconnecting one passes the last seq it saw.
   * Returns after every frame the server sent during the handshake has arrived.
   */
  static async open(url: string, token: string, options: { label: string; resyncFrom?: number }): Promise<ScenarioClient> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error(`cannot connect to ${url}`)), { once: true });
    });
    const client = new ScenarioClient(ws, options.label);
    client.send({ type: "hello", v: PROTOCOL_VERSION, token, device: options.label });
    const hello = await client.waitFor("hello.ok", { why: "the handshake" });
    client.send({ type: "resync", lastSeq: options.resyncFrom ?? hello.lastSeq });
    await client.sync();
    return client;
  }

  send(frame: ClientFrame): void {
    this.ws.send(JSON.stringify(frame));
  }

  /** Send a frame the protocol package does not type yet (a frame a later task adds). */
  sendRaw(frame: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(frame));
  }

  /**
   * Call `listener` for every frame that arrives from now on (an owner who answers
   * approval cards while a background job runs). Returns the function that stops it.
   */
  onFrame(listener: (frame: ServerFrame) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Index to pass as `since` so a later wait ignores everything before now. */
  mark(): number {
    return this.frames.length;
  }

  until(
    test: (frame: ServerFrame) => boolean,
    options: { since?: number; timeoutMs?: number; why: string },
  ): Promise<ServerFrame> {
    const since = options.since ?? 0;
    const existing = this.frames.slice(since).find(test);
    if (existing) return Promise.resolve(existing);
    const timeoutMs = options.timeoutMs ?? 3_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(
          `[${this.label}] timed out after ${timeoutMs}ms waiting for ${options.why}. ` +
          `Frames since then: ${this.summary(since)}`,
        ));
      }, timeoutMs);
      const waiter: Waiter = { since, test, resolve, timer };
      this.waiters.add(waiter);
    });
  }

  waitFor<T extends ServerFrame["type"]>(type: T, options: WaitOptions<T> = {}): Promise<FrameOf<T>> {
    const { match, ...rest } = options;
    return this.until(
      (frame) => frame.type === type && (!match || match(frame as FrameOf<T>)),
      { ...rest, why: options.why ?? `a ${type} frame` },
    ) as Promise<FrameOf<T>>;
  }

  /** The first frame of any of these types. */
  firstOf(types: ServerFrame["type"][], options: { since?: number; timeoutMs?: number; why?: string } = {}): Promise<ServerFrame> {
    return this.until((frame) => types.includes(frame.type), { ...options, why: options.why ?? types.join(" or ") });
  }

  framesOf<T extends ServerFrame["type"]>(type: T, since = 0): Array<FrameOf<T>> {
    return this.frames.slice(since).filter((frame): frame is FrameOf<T> => frame.type === type);
  }

  /** Round trip through the server: every frame sent before this call has arrived when it returns. */
  async sync(): Promise<void> {
    const since = this.mark();
    this.send({ type: "channel.list" });
    await this.waitFor("channel.list.ok", { since, why: "the sync round trip" });
  }

  /** Send an owner message and wait for its turn to start; returns the turn's ID. */
  async startTurn(
    text: string,
    options: { channelId?: string; toAgentId?: string; timeoutMs?: number } = {},
  ): Promise<{ turnID: string; threadID: string; since: number }> {
    // Frames from earlier background work may still be in flight; flush them so the mark is clean.
    await this.sync();
    const since = this.mark();
    this.send({
      type: "msg.send",
      channelId: options.channelId ?? "main",
      text,
      ...(options.toAgentId ? { toAgentId: options.toAgentId } : {}),
    });
    const started = await this.waitFor("turn.start", {
      since,
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      why: `turn.start after sending "${text.slice(0, 40)}"`,
    });
    return { turnID: started.turnID, threadID: started.threadID, since };
  }

  close(): void {
    this.ws.close();
  }

  /** "turn.start x1, token x3, turn.end x1": enough to see what did happen. */
  summary(since = 0): string {
    const counts = new Map<string, number>();
    for (const frame of this.frames.slice(since)) counts.set(frame.type, (counts.get(frame.type) ?? 0) + 1);
    return [...counts].map(([type, count]) => `${type} x${count}`).join(", ") || "(none)";
  }
}

// ---------------------------------------------------------------------------
// the scenario: one server, one database, one scripted model
// ---------------------------------------------------------------------------

const provider: ProviderConfig = {
  id: "scenario",
  label: "Scenario",
  baseUrl: "https://scenario.invalid/v1",
  apiKey: "not-a-real-key",
  model: "scripted",
};

export interface ScenarioOptions {
  turnTimeoutMs?: number;
  /**
   * How long a background job waits on an approval card before the card
   * expires (an expiry is a denial). Chat turns use the server's own ceiling.
   */
  ownerWaitMs?: number;
  /** The model id the scripted provider reports. A task that prices calls needs a priced one. */
  model?: string;
  /**
   * Serve the model from a real HTTP endpoint (the mock provider) instead of
   * the in-process script: the base URL, such as `http://127.0.0.1:9911/v1`.
   */
  modelBaseUrl?: string;
}

export class Scenario {
  readonly model = new FakeModel();
  readonly clients: ScenarioClient[] = [];
  readonly home: string;
  readonly dbPath: string;
  /** The default device's token (the owner's first device). */
  token = "";
  db!: Database;
  server!: RunningServer;
  private router!: Router;
  private jobRunner: JobRunner | undefined;
  /** Index into `clients` where the current server process began (see `restart`). */
  private epoch = 0;
  private readonly savedEnv: Record<string, string | undefined> = {};
  private readonly rosterSize = PERSONAS.length;

  private constructor(private readonly options: ScenarioOptions) {
    this.home = mkdtempSync(join(tmpdir(), "agni-scenario-"));
    this.dbPath = join(this.home, "data", "agni.sqlite");
  }

  static async start(options: ScenarioOptions = {}): Promise<Scenario> {
    const scenario = new Scenario(options);
    try {
      await scenario.boot();
    } catch (error) {
      await scenario.stop();
      throw error;
    }
    return scenario;
  }

  get url(): string {
    return this.server.url;
  }

  /** The owner's scratch tree (AGNI_HOME/scratch), where writes run free. */
  get scratch(): string {
    return join(this.home, "scratch");
  }

  /** A path inside the temp home but outside scratch: writes there need an approval. */
  outside(...parts: string[]): string {
    return join(this.home, "outside", ...parts);
  }

  private async boot(): Promise<void> {
    for (const key of ["AGNI_HOME", "AGNI_SCRATCH_DIR"]) this.savedEnv[key] = process.env[key];
    process.env.AGNI_HOME = this.home;
    delete process.env.AGNI_SCRATCH_DIR;
    mkdirSync(this.scratch, { recursive: true });
    this.db = openDatabase(this.dbPath);
    // Skip first-run onboarding: the scenarios are about work, not the name prompt.
    this.db.run("UPDATE agents SET onboarded = 1 WHERE id = 'ea'");
    this.token = (await mintToken(this.db, "scenario-owner")).token;
    // The sprint startup hooks `serve()` runs (audit sink, usage recorder), so scenarios see the wiring the daemon has.
    await runStartupHooks({ db: this.db, config: this.config() });
    this.listen();
  }

  private config(): Config {
    return {
      host: "127.0.0.1",
      port: 0,
      dbPath: this.dbPath,
      pidPath: "",
      logPath: "",
      providers: [this.activeProvider()],
      firstTokenTimeoutMs: 10_000,
      turnTimeoutMs: this.options.turnTimeoutMs ?? 30_000,
      helloTimeoutMs: 2_000,
      frameLogCapacity: 5_000,
      jobPollMs: 1_000,
      maxConcurrentTurns: 8,
      pluginsPath: "",
    };
  }

  private activeProvider(): ProviderConfig {
    return {
      ...provider,
      ...(this.options.model ? { model: this.options.model } : {}),
      ...(this.options.modelBaseUrl ? { baseUrl: this.options.modelBaseUrl } : {}),
    };
  }

  private listen(): void {
    // The router calls whatever fetch it is given: the script, or the real one for a mock provider on loopback.
    this.router = new Router([this.activeProvider()], new HealthTracker(), this.options.modelBaseUrl ? fetch : this.model.fetch);
    this.server = startServer(this.config(), this.db, this.router);
    this.jobRunner = undefined;
  }

  /** Another paired device, as its own token (for "a second phone"). */
  async pairDevice(name: string): Promise<string> {
    return (await mintToken(this.db, name)).token;
  }

  async connect(options: { label?: string; token?: string; resyncFrom?: number } = {}): Promise<ScenarioClient> {
    const client = await ScenarioClient.open(this.url, options.token ?? this.token, {
      label: options.label ?? `client${this.clients.length + 1}`,
      ...(options.resyncFrom !== undefined ? { resyncFrom: options.resyncFrom } : {}),
    });
    this.clients.push(client);
    return client;
  }

  /**
   * Make sure the server has processed everything that happened on sockets
   * before this call (a close, a cancel): one throwaway connection's round trip.
   */
  async barrier(): Promise<void> {
    const probe = await this.connect({ label: "probe" });
    probe.close();
    await probe.closed;
  }

  /**
   * A new process on the same database: the old server and database handle
   * are dropped (as a kill would drop them) and a fresh server boots on the
   * file, running its boot-time recovery. The model and its script carry over.
   */
  async restart(): Promise<void> {
    for (const client of this.clients) client.close();
    this.epoch = this.clients.length;
    this.server.stop();
    this.db.close();
    this.db = openDatabase(this.dbPath);
    await runStartupHooks({ db: this.db, config: this.config() });
    this.listen();
  }

  /** The job runner the daemon would own, with the turn job registered. Drive it with `tick()`. */
  runner(): JobRunner {
    if (!this.jobRunner) {
      this.jobRunner = new JobRunner(this.db, this.server.emit, { maxPerTick: 10 });
      registerTurnJob(this.jobRunner, {
        db: this.db,
        router: this.router,
        settings: {
          firstTokenTimeoutMs: 10_000,
          turnTimeoutMs: this.options.turnTimeoutMs ?? 30_000,
          ...(this.options.ownerWaitMs ? { ownerWaitMs: this.options.ownerWaitMs } : {}),
        },
        emit: this.server.emit,
      });
    }
    return this.jobRunner;
  }

  get<T>(sql: string, ...params: Array<string | number | null>): T | null {
    return this.db.query(sql).get(...params) as T | null;
  }

  all<T>(sql: string, ...params: Array<string | number | null>): T[] {
    return this.db.query(sql).all(...params) as T[];
  }

  /**
   * The turns the current server process announced and never ended, that the
   * database still shows running. Frames from before a restart belong to the
   * dead process and say nothing about what this one is running.
   */
  private openTurns(): string[] {
    const started = new Set<string>();
    const ended = new Set<string>();
    for (const client of this.clients.slice(this.epoch)) {
      for (const frame of client.frames) {
        if (frame.type === "turn.start") started.add(frame.turnID);
        if (frame.type === "turn.end") ended.add(frame.turnID);
      }
    }
    return [...started].filter((id) => {
      if (ended.has(id)) return false;
      return this.get<{ state: string }>("SELECT state FROM turns WHERE id = ?", id)?.state === "running";
    });
  }

  /** Let every turn this scenario started finish, so nothing outlives the test. */
  private async drain(): Promise<void> {
    this.model.abandon();
    const open = this.openTurns();
    const pendingCards = this.all<{ id: string }>("SELECT id FROM approvals WHERE status = 'pending'");
    if (open.length === 0 && pendingCards.length === 0) return;
    try {
      const janitor = await this.connect({ label: "janitor" });
      for (const card of pendingCards) janitor.send({ type: "approve.reply", requestID: card.id, decision: "reject" });
      for (const turnID of open) janitor.send({ type: "msg.cancel", turnID });
      await janitor.sync();
    } catch {
      // The server is already gone; abandoning the model is all that is left to do.
    }
    const deadline = Date.now() + 2_500;
    while (this.openTurns().length > 0 && Date.now() < deadline) await Bun.sleep(10);
  }

  async stop(): Promise<void> {
    try {
      if (this.server && this.db) await this.drain();
    } catch {
      // Teardown must always finish; the failing test already has its error.
    }
    for (const client of this.clients) client.close();
    try { this.server?.stop(); } catch { /* already stopped */ }
    // Process-wide hooks a startup hook may have set point at this database: drop them before it closes.
    setAuditSink(noopAuditSink);
    setUsageRecorder(() => {});
    try { this.db?.close(); } catch { /* already closed */ }
    for (const [key, value] of Object.entries(this.savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    // create_agent adds to the process-wide roster; later test files must start clean.
    PERSONAS.length = this.rosterSize;
    rmSync(this.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

/** Scenarios wait on sockets and the database; Bun's 5 s default is too tight for a failing run's waits. */
export const SCENARIO_TIMEOUT_MS = 20_000;

/** `test` with the scenario timeout. */
export function scenarioTest(name: string, body: () => Promise<void>): void {
  test(name, body, SCENARIO_TIMEOUT_MS);
}

/** Register the teardown hook and hand back the scenario starter. Call once per test file, at the top. */
export function useScenarios(): { start: (options?: ScenarioOptions) => Promise<Scenario> } {
  const live: Scenario[] = [];
  afterEach(async () => {
    for (const scenario of live.splice(0)) await scenario.stop();
  }, SCENARIO_TIMEOUT_MS);
  return {
    async start(options) {
      const scenario = await Scenario.start(options);
      live.push(scenario);
      return scenario;
    },
  };
}

/** Wire-level check that a request's tool results all have their calling assistant message, and vice versa. */
export function toolPairingProblems(messages: WireMessage[]): string[] {
  const problems: string[] = [];
  const called = new Set<string>();
  const answered = new Set<string>();
  for (const message of messages) {
    for (const entry of message.tool_calls ?? []) called.add(entry.id);
    if (message.role === "tool") {
      const id = message.tool_call_id ?? "(none)";
      answered.add(id);
      if (!called.has(id)) problems.push(`tool result ${id} has no earlier assistant message that made the call`);
    }
  }
  for (const id of called) if (!answered.has(id)) problems.push(`tool call ${id} has no tool result`);
  return problems;
}
