/**
 * S2-INT item 4: the engine's rule lookup uses resource patterns; a card carries its source, tier, expiry and
 * cut flag (and keeps them for a replay); a background run's card waits 30 minutes, a chat run's 10.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalSourceSchema, type ServerFrameBody } from "@agni/protocol";
import { ApprovalBroker } from "../src/agent/approval-broker";
import { loadCardMeta } from "../src/agent/pending-cards";
import { runTaskTurn } from "../src/agent/task-loop";
import { openDatabase } from "../src/db";
import { HealthTracker } from "../src/models/health";
import { Router } from "../src/models/router";
import { decide } from "../src/policy/engine";
import type { ApprovalCard } from "../src/policy/types";
import { addApprovalRule } from "../src/stores/approval-rules";
import { createThread } from "../src/stores/threads";
import { policyRig, type PolicyRig } from "./policy-fixture";
import { startHarness, sseResponse, sseToolCall, type Harness } from "./ws-harness";

let rig: PolicyRig | undefined;
let db: Database | undefined;
let harness: Harness | undefined;
afterEach(async () => {
  rig?.close(); rig = undefined;
  db?.close(); db = undefined;
  await harness?.stop(); harness = undefined;
});

describe("the engine matches a resource pattern rule", () => {
  test("a pattern rule lets a call through that no exact rule covers, and a call outside the pattern still asks", () => {
    rig = policyRig();
    const base = join(rig.scratch, "reports");
    mkdirSync(base, { recursive: true });
    for (const name of ["a.txt", "b.txt"]) writeFileSync(join(base, name), "old");
    writeFileSync(join(rig.scratch, "other.txt"), "old");
    const overwrite = (path: string) => decide(rig!.run, { tool: "write_file", args: { path, content: "new" }, callID: "c" });

    expect(overwrite(join(base, "a.txt")).action).toBe("ask");
    addApprovalRule(rig.db, { agentID: rig.run.bot, toolName: "write_file", target: "", resourcePattern: `${base.replace(/\\/g, "/")}/*.txt` });

    const inside = overwrite(join(base, "b.txt"));
    expect(inside).toMatchObject({ action: "run", via: "rule" });
    expect(overwrite(join(rig.scratch, "other.txt")).action).toBe("ask");
  });
});

const card = (overrides: Partial<ApprovalCard> = {}): ApprovalCard => ({
  tier: 2, risk: "egress", verb: "send an email", canRemember: false, unnamedDestinations: [], resources: [], operation: "send",
  sources: [
    { kind: "web", label: "example.com/offers", at: "2026-11-16T10:00:00Z" },
    { kind: "peer", label: "Juno", at: "2026-11-16T10:00:00Z" },
    { kind: "mcp", label: "results from Notes", at: "2026-11-16T10:00:00Z" },
    { kind: "routine", label: "saved routine state", at: "2026-11-16T10:00:00Z" },
    { kind: "email", label: "from ann@example.com", at: "2026-11-16T10:00:00Z" },
  ],
  ...overrides,
});

function brokerFor(database: Database): { broker: ApprovalBroker; frames: Array<Extract<ServerFrameBody, { type: "approval.request" }>> } {
  const frames: Array<Extract<ServerFrameBody, { type: "approval.request" }>> = [];
  const broker = new ApprovalBroker({
    db: database,
    emit: (frame) => { frames.push(frame as Extract<ServerFrameBody, { type: "approval.request" }>); },
    waitForDecision: async () => "reject",
  });
  return { broker, frames };
}

describe("an approval card carries what the owner needs to judge it", () => {
  test("source, tier, expiry and cut flag are on the frame, in the protocol's words, and saved for a replay", async () => {
    db = openDatabase(":memory:");
    const { broker, frames } = brokerFor(db);
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    await broker.request("thr", "trn", "mail_send", "call_1", { to: ["x@y.z"], subject: "s", body: "short" }, new AbortController().signal, { card: card(), agentID: "ea", botName: "Ava", expiresAt });
    const [frame] = frames;
    expect(frame!.source!.map((source) => source.kind)).toEqual(["web", "agent", "connector", "scheduled", "email"]);
    expect(frame!.source![0]).toEqual({ kind: "web", label: "example.com/offers" });
    for (const source of frame!.source!) expect(ApprovalSourceSchema.safeParse(source).success).toBe(true);
    expect(frame).toMatchObject({ tier: 2, expiresAt, truncated: false });
    expect(frame!.buttons).toEqual(["once", "reject"]);
    // What a reconnecting client is shown is the same card.
    expect(loadCardMeta(db, frame!.requestID)).toMatchObject({ tier: 2, expiresAt, truncated: false, source: frame!.source });
  });

  test("a long call is shown whole, so it is not marked cut; one too long for any card raises none", async () => {
    db = openDatabase(":memory:");
    const { broker, frames } = brokerFor(db);
    await broker.request("thr", "trn", "mail_send", "call_1", { to: ["x@y.z"], subject: "s", body: "word ".repeat(2_000) }, new AbortController().signal, { card: card({ sources: [] }), agentID: "ea" });
    expect(frames[0]!.truncated).toBe(false);
    expect(frames[0]!.preview).toContain("word ".repeat(2_000).trimEnd());
    expect(frames[0]!.source).toBeUndefined();
    expect(loadCardMeta(db, frames[0]!.requestID)?.truncated).toBe(false);
    await expect(broker.request("thr", "trn", "mail_send", "call_2", { to: ["x@y.z"], subject: "s", body: "word ".repeat(10_000) }, new AbortController().signal, { card: card({ sources: [] }), agentID: "ea" })).rejects.toThrow(/too long/);
    expect(frames).toHaveLength(1);
  });

  test("an untainted card has no source, and a card the engine said cannot be remembered never offers always", async () => {
    db = openDatabase(":memory:");
    const { broker, frames } = brokerFor(db);
    await broker.request("thr", "trn", "write_file", "call_1", { path: "x.txt", content: "c" }, new AbortController().signal, { card: card({ sources: [], canRemember: false, tier: 1, risk: "undoable" }), agentID: "ea" });
    expect(frames[0]!.source).toBeUndefined();
    expect(frames[0]!.buttons).toEqual(["once", "reject"]);
    expect(frames[0]!.tier).toBe(1);
  });
});

describe("how long a card waits", () => {
  const bashTurn = async (policy: { jobID?: string | null } | undefined): Promise<number> => {
    db = openDatabase(":memory:");
    let request = 0;
    const router = new Router(
      [{ id: "t", label: "T", baseUrl: "https://t.local/v1", apiKey: "k", model: "m" }], new HealthTracker(),
      (async () => (++request === 1 ? sseToolCall("bash", { command: "rm -rf /tmp/nothing-here" }) : sseResponse("done"))) as unknown as typeof fetch,
    );
    const controller = new AbortController();
    let expiresAt = "";
    const finished = runTaskTurn(db, router, { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, {
      threadID: createThread(db, "ea").id, text: "clean up",
      persona: { id: "ea", name: "Ava", color: "#fff", role: "r", systemPromptTemplate: "x", systemPrompt: "x", tools: ["bash"] },
      emit: (frame) => {
        if (frame.type === "approval.request") { expiresAt = frame.expiresAt ?? ""; controller.abort(); }
      },
      signal: controller.signal,
      ...(policy ? { policy } : {}),
    });
    await finished;
    return Date.parse(expiresAt) - Date.now();
  };

  test("a chat turn's card waits 10 minutes", async () => {
    const left = await bashTurn(undefined);
    expect(left).toBeGreaterThan(590_000);
    expect(left).toBeLessThanOrEqual(600_000);
  });

  test("a background job's card waits 30 minutes", async () => {
    const left = await bashTurn({ jobID: "job_background" });
    expect(left).toBeGreaterThan(1_790_000);
    expect(left).toBeLessThanOrEqual(1_800_000);
  });
});

describe("a replayed card never gains the always button", () => {
  test("a card saved as 'cannot be remembered' is replayed with once and deny only", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "agni-cards-"));
    const saved = process.env.AGNI_SCRATCH_DIR;
    process.env.AGNI_SCRATCH_DIR = scratch;
    try {
      // The first write makes the file (free); the second overwrites it, which asks and can be remembered.
      const write = () => sseToolCall("write_file", { path: "replay-me.txt", content: "new" });
      // write_file is a deferred tool: each turn loads it first.
      const load = () => sseToolCall("load_tools", { names: ["write_file"] });
      const script = [load, write, () => sseResponse("done"), load, write, () => sseResponse("done")];
      let index = 0;
      const h = await startHarness({ fetch: (async () => (script[Math.min(index++, script.length - 1)] as () => Response)()) as unknown as typeof fetch });
      harness = h;
      const client = await h.connect();
      client.send({ type: "agent.rename", agentId: "ea", name: "Agni" });
      await client.next("agent.updated");
      client.send({ type: "msg.send", channelId: "main", text: "write it" });
      await client.next("turn.end");
      client.send({ type: "msg.send", channelId: "main", text: "write it again" });
      const first = await client.next("approval.request");
      expect(first.buttons).toContain("always");
      h.db.run("UPDATE approvals SET card_meta = ? WHERE id = ?", [JSON.stringify({ tier: 1, canRemember: false }), first.requestID]);
      const other = await h.connect({ device: "tablet" });
      const replayed = await other.next("approval.request");
      expect(replayed.requestID).toBe(first.requestID);
      expect(replayed.buttons).toEqual(["once", "reject"]);
    } finally {
      if (saved === undefined) delete process.env.AGNI_SCRATCH_DIR; else process.env.AGNI_SCRATCH_DIR = saved;
    }
  });
});
