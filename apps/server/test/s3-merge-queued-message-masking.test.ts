/**
 * Sprint 3 merge fix round 3, item 1: a message the owner sends while the thread is busy waits in `queued_messages` (so a crash
 * does not lose it). The words and the frame are written before anything acknowledges them, so they are masked there too.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { PROTOCOL_VERSION, type ClientFrame } from "@agni/protocol";
import { mintToken } from "../src/auth/tokens";
import type { Config } from "../src/config";
import { openDatabase } from "../src/db";
import { HealthTracker } from "../src/models/health";
import type { ProviderConfig } from "../src/models/providers";
import { Router } from "../src/models/router";
import { registerSecret } from "../src/util/redact";
import { startServer, type RunningServer } from "../src/ws/server";

const KEY = "sk-queued-canary-0f9e8d7c6b5a4f3e2d1c";
const provider: ProviderConfig = { id: "test", label: "Test", baseUrl: "https://test.local/v1", apiKey: "k", model: "m" };
const encoder = new TextEncoder();
const reply = (content: string): Response =>
  new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`));
      controller.close();
    },
  }), { status: 200 });

type Frame = { type: string; [key: string]: unknown };
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function open(server: RunningServer, token: string): Promise<{ send(frame: ClientFrame): void; waitFor(match: (frame: Frame) => boolean): Promise<Frame> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  const frames: Frame[] = [];
  ws.addEventListener("message", (event) => frames.push(JSON.parse(String(event.data)) as Frame));
  await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
  cleanups.push(() => ws.close());
  const waitFor = async (match: (frame: Frame) => boolean): Promise<Frame> => {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const found = frames.find(match);
      if (found) return found;
      await Bun.sleep(10);
    }
    throw new Error("timed out waiting for a frame");
  };
  const send = (frame: ClientFrame): void => ws.send(JSON.stringify(frame));
  send({ type: "hello", v: PROTOCOL_VERSION, token, device: "t" });
  await waitFor((frame) => frame.type === "hello.ok");
  return { send, waitFor };
}

describe("queued_messages holds the owner's words with a saved key masked", () => {
  test("a message queued behind a busy thread is on disk without the key", async () => {
    registerSecret(KEY);
    const db: Database = openDatabase(":memory:");
    db.run("UPDATE agents SET onboarded = 1 WHERE id = 'ea'");
    cleanups.push(() => db.close());
    const { token } = await mintToken(db, "t");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const fetchMock = (async () => {
      calls += 1;
      if (calls === 1) await gate;
      return reply("ok");
    }) as unknown as typeof fetch;
    const config = {
      host: "127.0.0.1", port: 0, dbPath: ":memory:", pidPath: "", logPath: "", providers: [provider],
      firstTokenTimeoutMs: 60_000, turnTimeoutMs: 60_000, helloTimeoutMs: 2000, frameLogCapacity: 100,
      jobPollMs: 1000, maxConcurrentTurns: 4, pluginsPath: "",
    } as Config;
    const server = startServer(config, db, new Router([provider], new HealthTracker(), fetchMock));
    cleanups.push(() => server.stop());
    const client = await open(server, token);
    client.send({ type: "msg.send", channelId: "main", text: "first question" });
    await client.waitFor((frame) => frame.type === "turn.start");
    client.send({ type: "msg.send", channelId: "main", text: `use this key: ${KEY}` });
    await client.waitFor((frame) => frame.type === "status.update" && String(frame.text).startsWith("Queued"));
    const rows = db.query<{ text: string; frame: string }, []>("SELECT text, frame FROM queued_messages").all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe("use this key: [redacted]");
    expect(rows[0]!.frame).not.toContain(KEY);
    release();
  });
});
