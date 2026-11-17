/**
 * S2-INT item 10: a turn the pause switch stops says so in the notes it leaves behind (not "a restart"), and
 * every roster the server sends marks the bots that are off.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { ServerFrameBody } from "@agni/protocol";
import { ABORT_REASONS, abortReasonOf } from "../src/agent/abort-reason";
import { AGENT_OFF_REQUEST_NOTE, PAUSED_REQUEST_NOTE, closeRequest, closureWording, isClosureNote } from "../src/agent/closure";
import { mentionRoster, personaInfo } from "../src/agent/personas";
import { openDatabase } from "../src/db";
import { setAuditSink } from "../src/policy/audit-sink";
import { bindPauseStore, setAgentEnabled, unbindPauseStore } from "../src/policy/pause";
import { createUpdateAgentTool } from "../src/tools/update-agent-tool";
import { createThread, recentMessages } from "../src/stores/threads";
import { gatedFetch, startHarness, type Harness } from "./ws-harness";

let db: Database | undefined;
let harness: Harness | undefined;
afterEach(async () => {
  db?.close(); db = undefined;
  await harness?.stop(); harness = undefined;
  unbindPauseStore();
  setAuditSink({ record() {} });
});

describe("abort reasons", () => {
  test("paused and agent_off are reasons a signal can carry", () => {
    expect(ABORT_REASONS).toEqual(expect.arrayContaining(["paused", "agent_off"]));
    for (const reason of ["paused", "agent_off"] as const) {
      const controller = new AbortController();
      controller.abort(reason);
      expect(abortReasonOf(controller.signal)).toBe(reason);
    }
  });
});

describe("the notes a stopped request leaves", () => {
  test("a paused request and a request of a bot that was turned off each get their own fixed note", () => {
    db = openDatabase(":memory:");
    const thread = createThread(db, "ea");
    closeRequest(db, { threadID: thread.id, reason: "paused" });
    closeRequest(db, { threadID: thread.id, reason: "agent_off" });
    const rows = recentMessages(db, thread.id, 20).filter((row) => row.role === "system");
    expect(rows.map((row) => row.text)).toEqual([PAUSED_REQUEST_NOTE, AGENT_OFF_REQUEST_NOTE]);
    expect(PAUSED_REQUEST_NOTE).toContain("paused all bots");
    expect(AGENT_OFF_REQUEST_NOTE).toContain("turned me off");
    // Neither blames a restart or a Stop, and both say the request is closed and may have run in part.
    for (const note of [PAUSED_REQUEST_NOTE, AGENT_OFF_REQUEST_NOTE]) {
      expect(note).not.toContain("restart");
      expect(note).not.toContain("pressed Stop");
      expect(note).toContain("That request is closed");
      expect(note).toContain("may already have run");
    }
  });

  test("a bot cannot write these notes into a job, routine or rule: the wording is refused", () => {
    expect(closureWording(PAUSED_REQUEST_NOTE)).toBe(true);
    expect(closureWording(AGENT_OFF_REQUEST_NOTE)).toBe(true);
    expect(closureWording("the OWNER   paused all bots, so my previous request was stopped")).toBe(true);
    expect(closureWording("the owner turned me off, so my previous request was stopped")).toBe(true);
    expect(closureWording("remind me to pause the music at noon")).toBe(false);
  });

  test("a note is a closure note only by its record, not by its words", () => {
    expect(isClosureNote("system", PAUSED_REQUEST_NOTE, null)).toBe(false);
    expect(isClosureNote("system", PAUSED_REQUEST_NOTE, "closure")).toBe(true);
  });
});

describe("a turn stopped by the switch leaves the right note", () => {
  const start = async (): Promise<{ client: Awaited<ReturnType<Harness["connect"]>>; h: Harness }> => {
    const h = await startHarness({ fetch: gatedFetch(new Promise<void>(() => undefined)) });
    harness = h;
    bindPauseStore(h.db);
    const client = await h.connect();
    client.send({ type: "agent.rename", agentId: "ea", name: "Agni" });
    await client.next("agent.updated");
    return { client, h };
  };
  const closureNotes = (h: Harness): string[] => h.db.query<{ text: string }, []>("SELECT text FROM messages WHERE kind = 'closure' ORDER BY rowid").all().map((row) => row.text.split("\n")[0]!); // the first line is the fixed note; a record of the tool log follows

  test("pause-all", async () => {
    const { client, h } = await start();
    client.send({ type: "msg.send", channelId: "main", text: "think for a long time" });
    await client.next("turn.start");
    client.send({ type: "policy.pause", paused: true });
    await client.next("turn.end", { timeoutMs: 5000 });
    expect(closureNotes(h)).toEqual([PAUSED_REQUEST_NOTE]);
  });

  test("turning the bot off", async () => {
    const { client, h } = await start();
    client.send({ type: "msg.send", channelId: "main", text: "think for a long time" });
    await client.next("turn.start");
    client.send({ type: "agent.enabled.set", agentID: "ea", enabled: false });
    await client.next("turn.end", { timeoutMs: 5000 });
    expect(closureNotes(h)).toEqual([AGENT_OFF_REQUEST_NOTE]);
  });
});

describe("the roster marks the bots that are off", () => {
  test("personaInfo sets enabled false on a bot that is off, and says nothing for a bot that is on", () => {
    db = openDatabase(":memory:");
    bindPauseStore(db);
    setAuditSink({ record() {} });
    expect(mentionRoster(db).every((agent) => !("enabled" in agent))).toBe(true);
    setAgentEnabled(db, "researcher", false, { actor: "test" });
    // The mention list holds every bot, hidden specialists included; the researcher is one of them.
    const everyone = mentionRoster(db);
    expect(everyone.find((agent) => agent.id === "researcher")?.enabled).toBe(false);
    // A bot that is on carries no flag at all.
    expect(everyone.find((agent) => agent.id === "ea")).not.toHaveProperty("enabled");
    expect(personaInfo(db).find((agent) => agent.id === "ea")).not.toHaveProperty("enabled");
    setAgentEnabled(db, "researcher", true, { actor: "test" });
    expect(mentionRoster(db).find((agent) => agent.id === "researcher")).not.toHaveProperty("enabled");
  });

  test("the alias row of the default bot follows the bot", () => {
    db = openDatabase(":memory:");
    bindPauseStore(db);
    setAuditSink({ record() {} });
    setAgentEnabled(db, "agni", false, { actor: "test" });
    expect(personaInfo(db).find((agent) => agent.id === "ea")?.enabled).toBe(false);
  });

  test("the roster an agent tool sends carries the flag too", async () => {
    db = openDatabase(":memory:");
    bindPauseStore(db);
    setAuditSink({ record() {} });
    setAgentEnabled(db, "researcher", false, { actor: "test" });
    setAgentEnabled(db, "ea", false, { actor: "test" });
    const frames: ServerFrameBody[] = [];
    const tool = createUpdateAgentTool({ db, emit: (frame) => { frames.push(frame); } });
    const result = await (tool.handler as unknown as (args: unknown, ctx: unknown) => Promise<unknown>)(
      { role: "keeps the calendar" },
      { threadID: "t", turnID: "u", signal: new AbortController().signal, chain: { depth: 1, rootAgentID: "ea", currentAgentID: "ea", handoffSummary: null } },
    );
    expect(result).not.toHaveProperty("error");
    const update = frames.find((frame) => frame.type === "agents.update");
    expect(update?.type === "agents.update" && update.agents.find((agent) => agent.id === "ea")?.enabled).toBe(false);
    expect(update?.type === "agents.update" && update.mentions?.find((agent) => agent.id === "researcher")?.enabled).toBe(false);
  });
});

