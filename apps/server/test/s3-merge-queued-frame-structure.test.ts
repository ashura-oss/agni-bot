/**
 * Sprint 3 merge fix round 4: `queued_messages.frame` is JSON the server reads back at boot. Masking a saved key in it
 * must touch only the owner's words, never the frame's keys or the JSON syntax, or boot replay misroutes the message
 * (a registered value equal to a key name) or throws at every boot (a value that spans `","`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, type ClientFrame } from "@agni/protocol";
import { mintToken } from "../src/auth/tokens";
import type { Config } from "../src/config";
import { openDatabase } from "../src/db";
import { HealthTracker } from "../src/models/health";
import type { ProviderConfig } from "../src/models/providers";
import { Router } from "../src/models/router";
import { ensureConversation } from "../src/stores/conversations";
import { registerSecret } from "../src/util/redact";
import { startServer, type RunningServer } from "../src/ws/server";

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

function config(dbPath: string): Config {
  return {
    host: "127.0.0.1", port: 0, dbPath, pidPath: "", logPath: "", providers: [provider],
    firstTokenTimeoutMs: 60_000, turnTimeoutMs: 60_000, helloTimeoutMs: 2000, frameLogCapacity: 100,
    jobPollMs: 1000, maxConcurrentTurns: 4, pluginsPath: "",
  } as Config;
}

async function open(server: RunningServer, token: string): Promise<{ send(frame: ClientFrame): void; waitFor(match: (frame: Frame) => boolean): Promise<Frame> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  const frames: Frame[] = [];
  // A saved value that matches JSON syntax also mangles frames on the wire; a frame that does not parse is skipped.
  ws.addEventListener("message", (event) => {
    try { frames.push(JSON.parse(String(event.data)) as Frame); } catch { /* skipped */ }
  });
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

interface QueuedRow { id: string; frame: string; text: string; device_id: string; device_name: string; created_at: string }

/** Queue one owner message to the conversation behind a running turn, and return the row the server wrote for it. */
async function queueBehindBusyTurn(db: Database, dbPath: string, conversationID: string, text: string, texts?: string[]): Promise<{ row: QueuedRow; release: () => void; stop: () => Promise<void> }> {
  const { token } = await mintToken(db, "t");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const fetchMock = (async () => {
    calls += 1;
    if (calls === 1) await gate;
    return reply("ok");
  }) as unknown as typeof fetch;
  const server = startServer(config(dbPath), db, new Router([provider], new HealthTracker(), fetchMock));
  let stopped: Promise<void> | null = null;
  const stop = (): Promise<void> => (stopped ??= Promise.resolve(server.stop()));
  cleanups.push(stop);
  const client = await open(server, token);
  client.send({ type: "msg.send", conversationID, text: "first question" });
  await client.waitFor((frame) => frame.type === "turn.start");
  client.send({ type: "msg.send", conversationID, text, ...(texts ? { texts } : {}) });
  const deadline = Date.now() + 4000;
  while (db.query<{ n: number }, []>("SELECT count(*) AS n FROM queued_messages").get()!.n === 0 && Date.now() < deadline) await Bun.sleep(10);
  const row = db.query<QueuedRow, []>("SELECT id, frame, text, device_id, device_name, created_at FROM queued_messages").get()!;
  return { row, release, stop };
}

function freshDB(): { db: Database; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "agni-s3-frame-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "agni.db");
  const db = openDatabase(path);
  db.run("UPDATE agents SET onboarded = 1");
  cleanups.push(() => db.close());
  return { db, path };
}

describe("the queued frame keeps its shape when a saved value looks like part of it", () => {
  test("a saved value equal to a frame key name does not rename the key", async () => {
    registerSecret("conversation");
    const { db, path } = freshDB();
    const conversation = ensureConversation(db, "researcher");
    const { row, release } = await queueBehindBusyTurn(db, path, conversation.id, "remember the conversation we had");
    release();
    const frame = JSON.parse(row.frame) as { conversationID?: string; text: string };
    expect(frame.conversationID).toBe(conversation.id);
    expect(frame.text).toBe("remember the [redacted] we had");
    expect(row.text).toBe("remember the [redacted] we had");
  });

  test("a saved value that spans the quotes between two fields does not break the JSON", async () => {
    const { db, path } = freshDB();
    const conversation = ensureConversation(db, "researcher");
    registerSecret('","text":"'); // a value like this also mangles frames on the wire: the helper skips what does not parse and polls the database
    const { row, release } = await queueBehindBusyTurn(db, path, conversation.id, "hello there");
    release();
    const frame = JSON.parse(row.frame) as { conversationID?: string; text: string };
    expect(frame.conversationID).toBe(conversation.id);
    expect(frame.text).toBe("hello there");
  });

  test("every content field is masked: text and texts", async () => {
    const key = "sk-frame-canary-1a2b3c4d5e6f7a8b9c0d";
    registerSecret(key);
    const { db, path } = freshDB();
    const conversation = ensureConversation(db, "researcher");
    const { row, release } = await queueBehindBusyTurn(db, path, conversation.id, `key ${key}`, [`part one ${key}`, "part two"]);
    release();
    expect(row.frame).not.toContain(key);
    const frame = JSON.parse(row.frame) as { texts?: string[] };
    expect(frame.texts).toEqual(["part one [redacted]", "part two"]);
  });

  test("a row written with a saved key name replays into the conversation it was sent to", async () => {
    registerSecret("conversation");
    const { db, path } = freshDB();
    const conversation = ensureConversation(db, "researcher");
    const { row, release, stop } = await queueBehindBusyTurn(db, path, conversation.id, "remember the conversation we had");
    release();
    // The process dies with the row still queued: stop the server, put the row back, boot again on the same file.
    await stop();
    db.close();
    const crashed = openDatabase(path);
    cleanups.push(() => crashed.close());
    crashed.run("DELETE FROM queued_messages");
    crashed.run("INSERT INTO queued_messages (id, frame, text, device_id, device_name, created_at) VALUES (?, ?, ?, ?, ?, ?)", [row.id, row.frame, row.text, row.device_id, row.device_name, row.created_at]);
    const server = startServer(config(path), crashed, new Router([provider], new HealthTracker(), (async () => reply("back")) as unknown as typeof fetch));
    cleanups.push(() => server.stop());
    const deadline = Date.now() + 4000;
    const landed = (): string[] => {
      const active = crashed.query<{ active_thread_id: string | null }, [string]>("SELECT active_thread_id FROM conversations WHERE id = ?").get(conversation.id)?.active_thread_id;
      return active ? crashed.query<{ text: string }, [string]>("SELECT text FROM messages WHERE thread_id = ? AND role = 'user'").all(active).map((r) => r.text) : [];
    };
    while (!landed().includes("remember the [redacted] we had") && Date.now() < deadline) await Bun.sleep(10);
    expect(landed()).toContain("remember the [redacted] we had");
  });
});

describe("boot replay survives a queued row that does not parse", () => {
  test("an unparseable row is dropped and the server still starts", async () => {
    const { db, path } = freshDB();
    const { device } = await mintToken(db, "t");
    db.run("INSERT INTO queued_messages (id, frame, text, device_id, device_name, created_at) VALUES ('qmsg_bad', ?, 'x', ?, 't', ?)", [
      '{"type":"msg.send","text":"broken[redacted]x"', device.id, new Date().toISOString(),
    ]);
    db.run("INSERT INTO queued_messages (id, frame, text, device_id, device_name, created_at) VALUES ('qmsg_ok', ?, 'still runs', ?, 't', ?)", [
      JSON.stringify({ type: "msg.send", channelId: "main", text: "still runs" }), device.id, new Date(Date.now() + 1000).toISOString(),
    ]);
    const server = startServer(config(path), db, new Router([provider], new HealthTracker(), (async () => reply("back")) as unknown as typeof fetch));
    cleanups.push(() => server.stop());
    expect(server.port).toBeGreaterThan(0);
    const deadline = Date.now() + 4000;
    const stored = (): number => db.query<{ n: number }, []>("SELECT count(*) AS n FROM channel_messages WHERE text = 'still runs'").get()!.n;
    while (stored() < 1 && Date.now() < deadline) await Bun.sleep(10);
    expect(stored()).toBe(1);
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM queued_messages WHERE id = 'qmsg_bad'").get()!.n).toBe(0);
  });
});
