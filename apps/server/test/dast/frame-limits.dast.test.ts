import { afterEach, describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "@agni/protocol";
import { startDast, type Dast } from "./dast-harness";

/**
 * S3-12 / S3-05: the socket refuses a frame far larger than any client sends
 * (`maxPayloadLength`), before the server parses it and whether or not the
 * connection has said hello, and a connection that floods frames is slowed or
 * dropped. The numbers are the test's own, chosen well clear of real use:
 * the largest honest frame is a 100,000-character message (about 400 KB as
 * UTF-8 at the very worst).
 */

let dast: Dast | undefined;
afterEach(async () => {
  await dast?.stop();
  dast = undefined;
});

const MiB = 1024 * 1024;
/**
 * How a server that refuses a frame for its size ends the connection: 1009 ("message too big") when it
 * sends a close frame, 1006 (abnormal closure) when it drops the socket without one, which Bun does.
 */
const REFUSED_BY_TRANSPORT = [1009, 1006];

function open(url: string): Promise<{ ws: WebSocket; frames: Array<Record<string, unknown>>; closed: Promise<number> }> {
  const ws = new WebSocket(url);
  const frames: Array<Record<string, unknown>> = [];
  const closed = new Promise<number>((resolve) => ws.addEventListener("close", (event) => resolve(event.code), { once: true }));
  ws.addEventListener("message", (event) => frames.push(JSON.parse(String(event.data))));
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve({ ws, frames, closed }), { once: true });
    ws.addEventListener("error", () => reject(new Error("cannot open")), { once: true });
  });
}

async function closeCodeWithin(closed: Promise<number>, ms: number): Promise<number | "open"> {
  return Promise.race([closed, Bun.sleep(ms).then(() => "open" as const)]);
}

describe("oversize frames", () => {
  test("a 4 MiB frame is refused before hello: the socket is closed and nothing was processed", async () => {
    dast = await startDast();
    const { ws, frames, closed } = await open(dast.harness.url);
    // A valid hello whose device name is 4 MiB: it parses fine if the server reads it at all.
    ws.send(JSON.stringify({ type: "hello", v: PROTOCOL_VERSION, token: dast.harness.token, device: "x".repeat(4 * MiB) }));
    const code = await closeCodeWithin(closed, 3000);
    expect({ closedForSize: REFUSED_BY_TRANSPORT.includes(code as number), authenticated: frames.some((frame) => frame.type === "hello.ok") }).toEqual({ closedForSize: true, authenticated: false });
    expect((await fetch(`${dast.base}/health`)).status).toBe(200);
  });

  test("a 4 MiB frame is refused on an authenticated socket too, and the owner's other devices carry on", async () => {
    dast = await startDast();
    const owner = await dast.harness.connect();
    const { ws, frames, closed } = await open(dast.harness.url);
    ws.send(JSON.stringify({ type: "hello", v: PROTOCOL_VERSION, token: dast.harness.token, device: "second" }));
    while (!frames.some((frame) => frame.type === "hello.ok")) await Bun.sleep(5);
    ws.send(JSON.stringify({ type: "user.typing", isTyping: true, channelId: "x".repeat(4 * MiB) }));
    expect(REFUSED_BY_TRANSPORT).toContain(await closeCodeWithin(closed, 3000) as number);
    owner.send({ type: "plugin.list" });
    await owner.next("plugin.list.ok");
  });

  test("a 4 MiB message text is refused by the transport, not just by the 100,000-character check", async () => {
    dast = await startDast();
    const { ws, frames, closed } = await open(dast.harness.url);
    ws.send(JSON.stringify({ type: "hello", v: PROTOCOL_VERSION, token: dast.harness.token, device: "big" }));
    while (!frames.some((frame) => frame.type === "hello.ok")) await Bun.sleep(5);
    ws.send(JSON.stringify({ type: "msg.send", threadID: "", text: "y".repeat(4 * MiB) }));
    expect(REFUSED_BY_TRANSPORT).toContain(await closeCodeWithin(closed, 3000) as number);
  });

  test("a frame at the largest honest size is still accepted (the limit is not too tight)", async () => {
    dast = await startDast();
    const client = await dast.harness.connect();
    // 99,000 characters of text, each three bytes in UTF-8: the biggest legitimate chat frame.
    client.send({ type: "msg.send", threadID: "", text: "é".repeat(99_000) });
    const started = await client.next("turn.start", { timeoutMs: 5000 });
    expect(started.type).toBe("turn.start");
    expect(client.closed).toBe(false);
  });
});

describe("frame flood", () => {
  test("a connection that sends a thousand frames at once is told to slow down or is dropped", async () => {
    dast = await startDast();
    const { ws, frames, closed } = await open(dast.harness.url);
    ws.send(JSON.stringify({ type: "hello", v: PROTOCOL_VERSION, token: dast.harness.token, device: "flooder" }));
    while (!frames.some((frame) => frame.type === "hello.ok")) await Bun.sleep(5);
    for (let i = 0; i < 1000; i++) ws.send(JSON.stringify({ type: "plugin.list" }));
    type Outcome = "dropped" | "rate-limit error" | "shed" | "absorbed all 1000";
    const outcome = await Promise.race<Outcome>([
      closed.then(() => "dropped" as const),
      (async (): Promise<Outcome> => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          if (frames.some((frame) => frame.type === "error" && /rate|limit|too many|slow/i.test(`${frame.code} ${frame.message}`))) return "rate-limit error";
          if (frames.filter((frame) => frame.type === "plugin.list.ok").length >= 1000) return "absorbed all 1000";
          await Bun.sleep(10);
        }
        // Quiet for five seconds with fewer than 1000 answers: the excess was shed.
        return "shed";
      })(),
    ]);
    // Anything but answering the whole flood counts as a limit: close, error, or silently shed.
    expect(outcome).not.toBe("absorbed all 1000");
  });

  test("an ordinary burst of a dozen frames is answered in full", async () => {
    dast = await startDast();
    const client = await dast.harness.connect();
    client.drain();
    for (let i = 0; i < 12; i++) client.send({ type: "plugin.list" });
    for (let i = 0; i < 12; i++) await client.next("plugin.list.ok");
    expect(client.closed).toBe(false);
  });

  test("one flooding device does not take the others down", async () => {
    dast = await startDast();
    const owner = await dast.harness.connect();
    const { ws, frames } = await open(dast.harness.url);
    ws.send(JSON.stringify({ type: "hello", v: PROTOCOL_VERSION, token: dast.harness.token, device: "flooder" }));
    while (!frames.some((frame) => frame.type === "hello.ok")) await Bun.sleep(5);
    for (let i = 0; i < 1000; i++) ws.send(JSON.stringify({ type: "plugin.list" }));
    owner.send({ type: "plugin.list" });
    await owner.next("plugin.list.ok", { timeoutMs: 5000 });
    ws.close();
  });
});
