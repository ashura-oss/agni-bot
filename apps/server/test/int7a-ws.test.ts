import { afterEach, describe, expect, test } from "bun:test";
import { gatedFetch, sseResponse, startHarness, waitFor, type Harness, type TestClient } from "./ws-harness";

/** Sprint 1 final fixes, part A, over the socket. */

let harness: Harness | undefined;
afterEach(async () => { await harness?.stop(); harness = undefined; });

async function skipOnboarding(client: TestClient): Promise<void> {
  client.send({ type: "agent.rename", agentId: "ea", name: "Agni" });
  await client.next("agent.updated");
}

describe("msg.cancel for a turn that is not running", () => {
  test("the asker is told not_running (not not_found, which means a missing rule), not left waiting", async () => {
    harness = await startHarness({});
    const client = await harness.connect();
    client.send({ type: "msg.cancel", turnID: "trn_does_not_exist" });
    const error = await client.next("error");
    expect(error.code).toBe("not_running");
  });
});

describe("a burst queued behind a running turn keeps every message", () => {
  test("TWO and THREE become one turn whose text holds both, in order", async () => {
    const bodies: string[] = [];
    const hang = gatedFetch(new Promise<void>(() => undefined));
    let calls = 0;
    const fetchMock = ((url: string, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      return ++calls === 1 ? hang(url, init) : Promise.resolve(sseResponse("ok"));
    }) as unknown as typeof fetch;
    harness = await startHarness({ fetch: fetchMock, config: { firstTokenTimeoutMs: 20_000, turnTimeoutMs: 20_000 } });
    const client = await harness.connect();
    await skipOnboarding(client);
    client.send({ type: "msg.send", channelId: "main", text: "ONE" });
    const started = await client.next("turn.start");
    client.send({ type: "msg.send", channelId: "main", text: "TWO please" });
    client.send({ type: "msg.send", channelId: "main", text: "THREE please" });
    await client.next("status.update", { match: (frame) => String(frame.text).startsWith("Queued behind") });
    client.send({ type: "msg.cancel", turnID: started.turnID });

    await waitFor(() => bodies.length >= 2, 3000, "the merged turn's model call");
    const second = JSON.parse(bodies[1]!) as { messages: Array<{ role: string; content: unknown }> };
    const last = second.messages.filter((message) => message.role === "user").at(-1)!;
    const text = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
    expect(text).toContain("TWO please");
    expect(text).toContain("THREE please");
    expect(text.indexOf("TWO please")).toBeLessThan(text.indexOf("THREE please"));
    // The owner's own history keeps both messages too.
    await waitFor(() => (harness!.db.query("SELECT count(*) AS n FROM channel_messages WHERE text LIKE '%TWO please%' OR text LIKE '%THREE please%'").get() as { n: number }).n >= 1, 3000, "the merged message to be stored");
    const stored = harness.db.query<{ text: string }, []>("SELECT text FROM channel_messages WHERE from_type = 'user' ORDER BY rowid").all().map((row) => row.text).join(" | ");
    expect(stored).toContain("TWO please");
    expect(stored).toContain("THREE please");
  });
});

describe("provider labels", () => {
  test("OpenRouter is labelled free only when its configured model is a :free one", async () => {
    const { loadProviders } = await import("../src/models/providers");
    const home = (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "agni-int7a-prov-"));
    const base = { AGNI_HOME: home, OPENROUTER_API_KEY: "sk-test-key-123456" };
    const free = loadProviders({ ...base, OPENROUTER_MODEL: "meta-llama/llama-3.3-70b-instruct:free" }).find((p) => p.id === "openrouter")!;
    const paid = loadProviders({ ...base, OPENROUTER_MODEL: "deepseek/deepseek-chat-v3" }).find((p) => p.id === "openrouter")!;
    expect(free.label).toBe("OpenRouter (:free)");
    expect(paid.label).toBe("OpenRouter");
  });
});
