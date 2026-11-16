/**
 * Shared helpers for tests that run a real server over a real socket. Not a
 * test file (no `.test.`), so bun does not collect it.
 */
import type { Database } from "bun:sqlite";
import { PROTOCOL_VERSION, parseServerFrame, type ClientFrame, type ServerFrame } from "@agni/protocol";
import { mintToken } from "../src/auth/tokens";
import type { Config } from "../src/config";
import { openDatabase } from "../src/db";
import { HealthTracker } from "../src/models/health";
import type { ProviderConfig } from "../src/models/providers";
import { Router } from "../src/models/router";
import { startServer, type RunningServer } from "../src/ws/server";

export const provider: ProviderConfig = {
  id: "test",
  label: "Test",
  baseUrl: "https://test.local/v1",
  apiKey: "test-key",
  model: "mock-model",
};

const encoder = new TextEncoder();

export function sseResponse(...deltas: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const delta of deltas) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

export function sseToolCall(name: string, args: unknown): Response {
  const event = {
    choices: [{
      delta: {
        tool_calls: [{ index: 0, id: `call-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
      },
    }],
  };
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`));
      controller.close();
    },
  }), { status: 200 });
}

/** First provider call returns `first`; every later call returns plain text. */
export function toolThenText(first: () => Response, text = "ok"): typeof fetch {
  let calls = 0;
  return (async () => (++calls === 1 ? first() : sseResponse(text))) as unknown as typeof fetch;
}

/** The first provider calls return `calls` in order; every later call returns plain text. */
export function toolsThenText(calls: Array<() => Response>, text = "ok"): typeof fetch {
  let index = 0;
  return (async () => (index < calls.length ? calls[index++]!() : sseResponse(text))) as unknown as typeof fetch;
}

/** A provider fetch that waits for `gate` (or for the request to be aborted) before answering. */
export function gatedFetch(gate: Promise<void>, deltas = ["done"]): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    await new Promise<void>((resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      void gate.then(resolve);
    });
    return sseResponse(...deltas);
  }) as unknown as typeof fetch;
}

export function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    dbPath: ":memory:",
    pidPath: "",
    logPath: "",
    providers: [provider],
    firstTokenTimeoutMs: 1000,
    turnTimeoutMs: 5000,
    helloTimeoutMs: 2000,
    frameLogCapacity: 200,
    jobPollMs: 1000,
    maxConcurrentTurns: 4,
    pluginsPath: "",
    ...overrides,
  };
}

export class TestClient {
  private readonly frames: ServerFrame[] = [];
  private readonly waiters: Array<{
    type: string;
    match?: (frame: ServerFrame) => boolean;
    resolve: (frame: ServerFrame) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  /** Highest seq this client has been sent. */
  maxSeq = 0;
  closed = false;

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("close", () => { this.closed = true; });
    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const parsed = parseServerFrame(JSON.parse(event.data));
      if (!parsed.ok) return;
      const frame = parsed.frame;
      if (frame.type !== "error") this.maxSeq = Math.max(this.maxSeq, frame.seq);
      const index = this.waiters.findIndex((waiter) => waiter.type === frame.type && (!waiter.match || waiter.match(frame)));
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        if (waiter) {
          clearTimeout(waiter.timer);
          waiter.resolve(frame);
          return;
        }
      }
      this.frames.push(frame);
    });
  }

  /**
   * Connect, hello, and resync. `resyncFrom` replays everything after that seq
   * (a reconnecting client); by default the client resyncs from the hello.ok seq.
   */
  static async connect(url: string, token: string, options: { resyncFrom?: number; device?: string } = {}): Promise<TestClient> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error(`cannot connect to ${url}`)), { once: true });
    });
    const client = new TestClient(ws);
    client.send({ type: "hello", v: PROTOCOL_VERSION, token, device: options.device ?? "test" });
    const hello = await client.next("hello.ok");
    client.send({ type: "resync", lastSeq: options.resyncFrom ?? hello.lastSeq });
    await client.next("agents.update");
    return client;
  }

  send(frame: ClientFrame): void {
    this.ws.send(JSON.stringify(frame));
  }

  /** Send a raw (possibly invalid) frame. */
  sendRaw(frame: unknown): void {
    this.ws.send(JSON.stringify(frame));
  }

  next<T extends ServerFrame["type"]>(
    type: T,
    options: { timeoutMs?: number; match?: (frame: Extract<ServerFrame, { type: T }>) => boolean } = {},
  ): Promise<Extract<ServerFrame, { type: T }>> {
    const { timeoutMs = 3000, match } = options;
    const queued = this.frames.findIndex((frame) => frame.type === type && (!match || match(frame as Extract<ServerFrame, { type: T }>)));
    if (queued >= 0) return Promise.resolve(this.frames.splice(queued, 1)[0] as Extract<ServerFrame, { type: T }>);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs);
      this.waiters.push({
        type,
        ...(match ? { match: match as (frame: ServerFrame) => boolean } : {}),
        resolve: resolve as (frame: ServerFrame) => void,
        timer,
      });
    });
  }

  /** Frames received so far that no waiter consumed. */
  seen(): ServerFrame[] {
    return [...this.frames];
  }

  drain(): void {
    this.frames.length = 0;
  }

  close(): void {
    this.ws.close();
  }
}

export interface Harness {
  db: Database;
  server: RunningServer;
  token: string;
  url: string;
  base: string;
  clients: TestClient[];
  connect(options?: { resyncFrom?: number; device?: string }): Promise<TestClient>;
  /** Stop the server, let the turns it cancelled finish writing, then close the database. */
  stop(): Promise<void>;
}

/** Start a server on an ephemeral port with an in-memory database. */
export async function startHarness(options: { fetch?: typeof fetch; config?: Partial<Config>; db?: Database } = {}): Promise<Harness> {
  const db = options.db ?? openDatabase(":memory:");
  const { token } = await mintToken(db, "test-device");
  const router = new Router(
    [provider],
    new HealthTracker(),
    options.fetch ?? ((async () => sseResponse("hello ", "there")) as unknown as typeof fetch),
  );
  const server = startServer(baseConfig(options.config), db, router);
  const url = `ws://127.0.0.1:${server.port}/ws`;
  const clients: TestClient[] = [];
  return {
    db,
    server,
    token,
    url,
    base: `http://127.0.0.1:${server.port}`,
    clients,
    async connect(connectOptions) {
      const client = await TestClient.connect(url, token, connectOptions);
      clients.push(client);
      return client;
    },
    async stop() {
      for (const client of clients) client.close();
      // Stopping cancels running turns; they finish asynchronously and must not
      // find the database closed under them.
      await server.stop();
      await Bun.sleep(30);
      db.close();
    },
  };
}

/** Poll until `check` is true or the deadline passes. */
export async function waitFor(check: () => boolean, timeoutMs = 3000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(10);
  }
}
