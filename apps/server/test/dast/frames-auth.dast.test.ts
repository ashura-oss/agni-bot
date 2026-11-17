import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { ClientFrameSchema, PROTOCOL_VERSION, parseClientFrame } from "@agni/protocol";
import { revokeDevice, mintToken } from "../../src/auth/tokens";
import { FRAMES_NEEDING_AUTH } from "./client-frames";
import { startDast, type Dast } from "./dast-harness";
import type { TestClient } from "../ws-harness";

/**
 * S3-12: every client frame except `hello` is refused on a socket that has not
 * said hello. The gate is `requireAuth` in `ws/dispatch.ts`; these tests go in
 * through a real socket, so a frame that reaches a handler without passing the
 * gate shows up as a database change or a non-error reply.
 */

let dast: Dast | undefined;
afterEach(async () => {
  await dast?.stop();
  dast = undefined;
});

interface Probe {
  /** Server frames received before the socket closed or went quiet. */
  frames: Array<Record<string, unknown>>;
  closeCode: number | null;
}

/** Open a fresh socket, optionally run `before`, send one raw frame, and collect what comes back. */
async function probe(url: string, frame: unknown, before?: (ws: WebSocket) => Promise<void>): Promise<Probe> {
  const ws = new WebSocket(url);
  const result: Probe = { frames: [], closeCode: null };
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error(`cannot open ${url}`)), { once: true });
  });
  const closed = new Promise<void>((resolve) => ws.addEventListener("close", (event) => { result.closeCode = event.code; resolve(); }, { once: true }));
  ws.addEventListener("message", (event) => result.frames.push(JSON.parse(String(event.data))));
  if (before) await before(ws);
  const sentAt = result.frames.length;
  ws.send(typeof frame === "string" ? frame : JSON.stringify(frame));
  // Done when the server answered this frame or hung up on it.
  const deadline = Date.now() + 3000;
  while (result.frames.length === sentAt && result.closeCode === null && Date.now() < deadline) await Bun.sleep(5);
  if (result.closeCode === null) ws.close();
  await Promise.race([closed, Bun.sleep(200)]);
  return result;
}

/** Row counts of every table but `meta` (the frame counter moves on its own). */
function snapshot(db: Database): Record<string, number> {
  const out: Record<string, number> = {};
  const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  for (const { name } of tables) {
    if (name === "meta" || name.endsWith("_fts") || name.includes("_fts_")) continue;
    out[name] = db.query<{ n: number }, []>(`SELECT count(*) AS n FROM "${name}"`).get()!.n;
  }
  return out;
}

/** An authenticated client that has already received the first-run welcome messages, so what it sees next is news. */
async function connectedAndQuiet(server: Dast): Promise<TestClient> {
  const owner = await server.harness.connect();
  await owner.next("msg.new");
  await owner.next("msg.new");
  owner.drain();
  return owner;
}

describe("the frame table covers the protocol", () => {
  test("every client frame type except hello has a valid example here, and every example parses", () => {
    const declared = ClientFrameSchema.options.map((option) => option.shape.type.value as string).filter((type) => type !== "hello").sort();
    const covered: string[] = [...new Set(FRAMES_NEEDING_AUTH.map((frame) => frame.type as string))].sort();
    // A new frame type with no entry fails here: add it to client-frames.ts so the gate is checked for it.
    expect(covered).toEqual(declared);
    for (const frame of FRAMES_NEEDING_AUTH) {
      const parsed = parseClientFrame(frame);
      if (!parsed.ok) throw new Error(`${frame.type} is not a valid frame: ${parsed.error}`);
    }
  });
});

describe("unauthenticated socket", () => {
  test("every frame except hello is refused with an unauthorized error and changes nothing", async () => {
    dast = await startDast();
    const before = snapshot(dast.harness.db);
    const leaked: string[] = [];
    const executed: string[] = [];
    for (const frame of FRAMES_NEEDING_AUTH) {
      const result = await probe(dast.harness.url, frame);
      // Refused means: an `unauthorized` error, or the connection dropped. Anything else is a handler that ran.
      const nonError = result.frames.filter((reply) => reply.type !== "error");
      if (nonError.length > 0) leaked.push(`${frame.type} -> ${nonError.map((reply) => reply.type).join(",")}`);
      const refused = result.frames.some((reply) => reply.type === "error" && reply.code === "unauthorized") || (result.frames.length === 0 && result.closeCode !== null);
      if (!refused) executed.push(`${frame.type} -> ${JSON.stringify(result.frames.map((reply) => [reply.type, reply.code]))} close=${result.closeCode}`);
    }
    expect(leaked).toEqual([]);
    expect(executed).toEqual([]);
    expect(snapshot(dast.harness.db)).toEqual(before);
  });

  test("a refused frame is not fanned out to authenticated devices", async () => {
    dast = await startDast();
    const owner = await connectedAndQuiet(dast);
    for (const frame of FRAMES_NEEDING_AUTH.slice(0, 12)) await probe(dast.harness.url, frame);
    await Bun.sleep(100);
    expect(owner.seen()).toEqual([]);
  });

  test("a malformed or unknown frame is a bad_frame error that answers only the sender", async () => {
    dast = await startDast();
    const owner = await connectedAndQuiet(dast);
    for (const raw of ["not json", "[]", "null", JSON.stringify({ type: "no.such.frame" }), JSON.stringify({ type: "msg.send" })]) {
      const result = await probe(dast.harness.url, raw);
      expect(result.frames.every((reply) => reply.type === "error")).toBe(true);
    }
    await Bun.sleep(50);
    expect(owner.seen()).toEqual([]);
  });

  test("hello with a wrong or revoked token is refused and the socket stays unauthenticated", async () => {
    dast = await startDast();
    const { token } = await mintToken(dast.harness.db, "to-revoke");
    const revoked = dast.harness.db.query<{ id: string }, []>("SELECT id FROM devices WHERE name = 'to-revoke'").get()!.id;
    revokeDevice(dast.harness.db, revoked);
    for (const bad of ["agni_notatoken", token]) {
      const result = await probe(dast.harness.url, { type: "hello", v: PROTOCOL_VERSION, token: bad, device: "attacker" });
      expect(result.frames.some((reply) => reply.type === "hello.ok")).toBe(false);
      expect(result.frames.some((reply) => reply.type === "error" && reply.code === "unauthorized")).toBe(true);
      expect(result.closeCode).toBe(4003);
    }
  });

  test("a wrong-token hello does not unlock the frames that follow it", async () => {
    dast = await startDast();
    const result = await probe(dast.harness.url, { type: "plugin.list" }, async (ws) => {
      ws.send(JSON.stringify({ type: "hello", v: PROTOCOL_VERSION, token: "agni_nope", device: "attacker" }));
      await Bun.sleep(100);
    });
    expect(result.frames.some((reply) => reply.type === "plugin.list.ok")).toBe(false);
  });

  test("a socket that never says hello is dropped at the hello timeout", async () => {
    dast = await startDast({ config: { helloTimeoutMs: 150 } });
    const ws = new WebSocket(dast.harness.url);
    const code = await new Promise<number>((resolve, reject) => {
      ws.addEventListener("close", (event) => resolve(event.code), { once: true });
      ws.addEventListener("error", () => reject(new Error("socket error")), { once: true });
    });
    expect(code).toBe(4001);
  });

  test("a revoked device loses its open session: the next frame is refused and the socket closed", async () => {
    dast = await startDast();
    const client = await dast.harness.connect();
    const id = dast.harness.db.query<{ id: string }, []>("SELECT id FROM devices WHERE name = 'test-device'").get()!.id;
    revokeDevice(dast.harness.db, id);
    client.drain();
    client.send({ type: "plugin.list" });
    const refusal = await client.next("error");
    expect(refusal.code).toBe("unauthorized");
    expect(client.seen().some((frame) => frame.type === "plugin.list.ok")).toBe(false);
  });
});
