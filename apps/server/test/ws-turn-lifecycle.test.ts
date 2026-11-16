import { afterEach, describe, expect, test } from "bun:test";
import { isTurnRunning } from "../src/ws/turn-registry";
import { gatedFetch, startHarness, waitFor, type Harness, type TestClient } from "./ws-harness";

/**
 * S1-01 / S1-02: a turn belongs to the server, not to the socket that started
 * it. Closing the socket (reload, phone lock, network blip) must not stop it,
 * and any authenticated connection can cancel any turn.
 */

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

async function skipOnboarding(client: TestClient): Promise<void> {
  client.send({ type: "agent.rename", agentId: "ea", name: "Agni" });
  await client.next("agent.updated");
}

describe("S1-01: closing the socket does not cancel the turn", () => {
  test("the turn finishes after its connection closed, and a reconnect replays its frames", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    harness = await startHarness({ fetch: gatedFetch(gate, ["still ", "here"]) });
    const first = await harness.connect();
    await skipOnboarding(first);

    first.send({ type: "msg.send", channelId: "main", text: "work on this" });
    const started = await first.next("turn.start");
    const seenBeforeClose = first.maxSeq;

    first.close();
    await waitFor(() => first.closed, 2000, "socket close");
    // Give the server's close handler time to run (it used to abort the turn).
    await Bun.sleep(100);
    release();

    await waitFor(
      () => harness!.db.query<{ stop_reason: string | null }, [string]>("SELECT stop_reason FROM turns WHERE id = ?").get(started.turnID)?.stop_reason !== null,
      3000,
      "turn to finish",
    );
    const row = harness.db.query<{ state: string; stop_reason: string }, [string]>("SELECT state, stop_reason FROM turns WHERE id = ?").get(started.turnID);
    expect(row).toEqual({ state: "done", stop_reason: "end" });

    // The frames the turn emitted while nobody listened replay on reconnect.
    const second = await harness.connect({ resyncFrom: seenBeforeClose });
    const ended = await second.next("turn.end", { match: (frame) => frame.turnID === started.turnID });
    expect(ended.stopReason).toBe("end");
  });
});

describe("S1-02: any connection can cancel any turn", () => {
  test("msg.cancel from a second device stops a turn the first device started", async () => {
    harness = await startHarness({ fetch: gatedFetch(new Promise<void>(() => undefined)) });
    const first = await harness.connect({ device: "phone" });
    const second = await harness.connect({ device: "laptop" });
    await skipOnboarding(first);

    first.send({ type: "msg.send", channelId: "main", text: "a long job" });
    const started = await first.next("turn.start");

    second.send({ type: "msg.cancel", turnID: started.turnID });
    const ended = await first.next("turn.end", { match: (frame) => frame.turnID === started.turnID, timeoutMs: 3000 });
    expect(ended.stopReason).toBe("cancelled");
    // The registry entry goes when the turn ends.
    await waitFor(() => !isTurnRunning(started.turnID), 2000, "registry cleanup");
  });

  test("a turn that was queued behind another can still be cancelled by id once it runs, from any connection", async () => {
    // The first turn waits for `release`; the second hangs until it is aborted.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = gatedFetch(gate);
    const hang = gatedFetch(new Promise<void>(() => undefined));
    let calls = 0;
    const fetchMock = ((url: string, init?: RequestInit) => (++calls === 1 ? first(url, init) : hang(url, init))) as unknown as typeof fetch;
    harness = await startHarness({ fetch: fetchMock });
    const owner = await harness.connect({ device: "phone" });
    const other = await harness.connect({ device: "laptop" });
    await skipOnboarding(owner);

    owner.send({ type: "msg.send", channelId: "main", text: "first" });
    await owner.next("turn.start");
    // Queued while the first runs, from a connection that goes away before it starts.
    other.send({ type: "msg.send", channelId: "main", text: "second" });
    await other.next("status.update", { match: (frame) => String(frame.text).startsWith("Queued") });
    other.close();
    await waitFor(() => other.closed, 2000, "socket close");

    release();
    const firstEnd = await owner.next("turn.end");
    expect(firstEnd.stopReason).toBe("end");
    const secondStart = await owner.next("turn.start", { timeoutMs: 3000 });

    // The queued turn's controller is registered server-wide, not on the dead socket.
    owner.send({ type: "msg.cancel", turnID: secondStart.turnID });
    const secondEnd = await owner.next("turn.end", { match: (frame) => frame.turnID === secondStart.turnID });
    expect(secondEnd.stopReason).toBe("cancelled");
  });
});

describe("shutdown", () => {
  test("stopping the server cancels the turns still running instead of leaving them", async () => {
    harness = await startHarness({ fetch: gatedFetch(new Promise<void>(() => undefined)) });
    const client = await harness.connect();
    await skipOnboarding(client);
    client.send({ type: "msg.send", channelId: "main", text: "a long job" });
    const started = await client.next("turn.start");

    harness.server.stop();
    await waitFor(
      () => harness!.db.query<{ stop_reason: string | null }, [string]>("SELECT stop_reason FROM turns WHERE id = ?").get(started.turnID)?.stop_reason !== null,
      3000,
      "turn to be stopped",
    );
    expect(harness.db.query("SELECT state, stop_reason FROM turns WHERE id = ?").get(started.turnID)).toEqual({ state: "done", stop_reason: "cancelled" });
  });
});
