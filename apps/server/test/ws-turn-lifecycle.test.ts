import { afterEach, describe, expect, test } from "bun:test";
import { isTurnRunning } from "../src/ws/turn-registry";
import { mintToken, revokeDevice } from "../src/auth/tokens";
import { TestClient as Client, gatedFetch, sseResponse, startHarness, waitFor, type Harness, type TestClient } from "./ws-harness";

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

describe("shutdown does not start queued work", () => {
  test("a message queued behind a cancelled turn stays queued on disk instead of starting once stop() resolves", async () => {
    harness = await startHarness({ fetch: gatedFetch(new Promise<void>(() => undefined)) });
    const client = await harness.connect();
    await skipOnboarding(client);
    client.send({ type: "msg.send", channelId: "main", text: "first" });
    await client.next("turn.start");
    client.send({ type: "msg.send", channelId: "main", text: "second" });
    await client.next("status.update", { match: (frame) => String(frame.text).startsWith("Queued") });

    await harness.server.stop();
    await Bun.sleep(200);
    expect(harness.db.query("SELECT count(*) AS n FROM turns").get()).toEqual({ n: 1 });
    // Still on disk, so the next boot picks it up.
    expect(harness.db.query("SELECT text FROM queued_messages").all()).toEqual([{ text: "second" }]);
  });
});

describe("a crashed turn is closed for everyone", () => {
  test("an unexpected failure broadcasts turn.end with an error stop and finishes the turn row", async () => {
    harness = await startHarness({ fetch: gatedFetch(Promise.resolve()) });
    const asker = await harness.connect({ device: "phone" });
    const watcher = await harness.connect({ device: "laptop" });
    await skipOnboarding(asker);
    harness.db.run("CREATE TRIGGER boom BEFORE INSERT ON agent_sessions BEGIN SELECT RAISE(ABORT, 'boom'); END");

    // The asking connection may be gone by the time the turn fails, so the news must reach everyone else.
    asker.send({ type: "msg.send", channelId: "main", text: "this will crash" });
    asker.close();
    const other = watcher;
    const started = await other.next("turn.start", { timeoutMs: 3000 }).catch(() => null);
    const ended = await other.next("turn.end", { timeoutMs: 3000 });
    expect(ended.stopReason).toBe("error");
    if (started) expect(ended.turnID).toBe(started.turnID);
    const row = harness.db.query<{ state: string; stop_reason: string }, [string]>("SELECT state, stop_reason FROM turns WHERE id = ?").get(ended.turnID);
    expect(row).toEqual({ state: "done", stop_reason: "error" });
  });
});

describe("revoking a device stops the turns it started", () => {
  const deviceID = (): string => harness!.db.query<{ id: string }, []>("SELECT id FROM devices LIMIT 1").get()!.id;

  test("the revocation sweep cancels a turn whose socket is already gone", async () => {
    // Longer first-token window than the 2 s sweep, so the sweep is what ends the turn.
    harness = await startHarness({ fetch: gatedFetch(new Promise<void>(() => undefined)), config: { firstTokenTimeoutMs: 20_000, turnTimeoutMs: 20_000 } });
    const client = await harness.connect();
    await skipOnboarding(client);
    client.send({ type: "msg.send", channelId: "main", text: "a long job" });
    const started = await client.next("turn.start");
    client.close();
    await waitFor(() => client.closed, 2000, "socket close");

    revokeDevice(harness.db, deviceID());
    await waitFor(
      () => harness!.db.query<{ stop_reason: string | null }, [string]>("SELECT stop_reason FROM turns WHERE id = ?").get(started.turnID)?.stop_reason === "cancelled",
      4500,
      "revoked device's turn to be cancelled",
    );
  }, 8000);

  test("logging out cancels the turns that device started", async () => {
    harness = await startHarness({ fetch: gatedFetch(new Promise<void>(() => undefined)) });
    const client = await harness.connect();
    await skipOnboarding(client);
    client.send({ type: "msg.send", channelId: "main", text: "a long job" });
    const started = await client.next("turn.start");

    const response = await fetch(`${harness.base}/auth/logout`, { method: "POST", headers: { authorization: `Bearer ${harness.token}`, origin: harness.base } });
    expect(response.status).toBe(200);
    await waitFor(
      () => harness!.db.query<{ stop_reason: string | null }, [string]>("SELECT stop_reason FROM turns WHERE id = ?").get(started.turnID)?.stop_reason === "cancelled",
      2000,
      "logged-out device's turn to be cancelled",
    );
  });
});

describe("a revoked device's queued messages never run", () => {
  const logout = (token: string) => fetch(`${harness!.base}/auth/logout`, { method: "POST", headers: { authorization: `Bearer ${token}`, origin: harness!.base } });

  test("two messages queued by a device that is then revoked are dropped, not run", async () => {
    harness = await startHarness({ fetch: gatedFetch(new Promise<void>(() => undefined)), config: { firstTokenTimeoutMs: 20_000, turnTimeoutMs: 20_000 } });
    const client = await harness.connect();
    await skipOnboarding(client);
    client.send({ type: "msg.send", channelId: "main", text: "first" });
    await client.next("turn.start");
    client.send({ type: "msg.send", channelId: "main", text: "queued one" });
    client.send({ type: "msg.send", channelId: "main", text: "queued two" });
    await client.next("status.update", { match: (frame) => String(frame.text).startsWith("Queued behind") });

    expect((await logout(harness.token)).status).toBe(200);
    await Bun.sleep(300);
    expect(harness.db.query("SELECT count(*) AS n FROM turns").get()).toEqual({ n: 1 });
    expect(harness.db.query("SELECT count(*) AS n FROM channel_messages WHERE text LIKE 'queued%'").get()).toEqual({ n: 0 });
    expect(harness.db.query("SELECT count(*) AS n FROM queued_messages").get()).toEqual({ n: 0 });
  });

  test("a mixed queue keeps only the good device's text, and a merge does not carry the revoked device's words", async () => {
    const bodies: string[] = [];
    const hang = gatedFetch(new Promise<void>(() => undefined));
    let calls = 0;
    const fetchMock = ((url: string, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      return ++calls === 1 ? hang(url, init) : Promise.resolve(sseResponse("ok"));
    }) as unknown as typeof fetch;
    harness = await startHarness({ fetch: fetchMock, config: { firstTokenTimeoutMs: 20_000, turnTimeoutMs: 20_000 } });
    const bad = await harness.connect({ device: "bad" });
    await skipOnboarding(bad);
    const good = await Client.connect(harness.url, (await mintToken(harness.db, "good")).token, { device: "good" });
    harness.clients.push(good);

    good.send({ type: "msg.send", channelId: "main", text: "first" });
    const started = await good.next("turn.start");
    bad.send({ type: "msg.send", channelId: "main", text: "REVOKEDWORDS" });
    good.send({ type: "msg.send", channelId: "main", text: "goodwords" });
    await bad.next("status.update", { match: (frame) => String(frame.text).startsWith("Queued behind") });

    expect((await logout(harness.token)).status).toBe(200);
    good.send({ type: "msg.cancel", turnID: started.turnID });
    await waitFor(() => bodies.some((body) => body.includes("goodwords")), 3000, "the good device's message to run");
    await Bun.sleep(200);
    expect(bodies.some((body) => body.includes("REVOKEDWORDS"))).toBe(false);
    expect(harness.db.query("SELECT count(*) AS n FROM channel_messages WHERE text LIKE '%REVOKEDWORDS%' AND text LIKE '%goodwords%'").get()).toEqual({ n: 0 });
  });
});
