/**
 * S2-13: pause-all and per-bot off. `isRunPaused` is the one question the
 * policy engine asks at step boundaries and at delegation; the state lives in
 * the database (migration 59) so a CLI in another process can flip it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db";
import {
  bindPauseStore,
  isPauseStoreBound,
  isRunPaused,
  listBotStates,
  readPauseState,
  setAgentEnabled,
  setAllPaused,
  unbindPauseStore,
} from "../src/policy/pause";
import { setAuditSink, type AuditEvent } from "../src/policy/audit-sink";

let db: Database;
let events: AuditEvent[];

beforeEach(() => {
  db = openDatabase(":memory:");
  events = [];
  setAuditSink({ record: (event) => { events.push(event); } });
  bindPauseStore(db);
});

afterEach(() => {
  unbindPauseStore();
  setAuditSink({ record() {} });
  db.close();
});

describe("isRunPaused", () => {
  test("nothing is paused by default", () => {
    expect(isRunPaused({ agentID: "ea" })).toEqual({ paused: false });
    expect(isRunPaused({ agentID: null })).toEqual({ paused: false });
  });

  test("with no database bound it says not paused instead of throwing", () => {
    unbindPauseStore();
    expect(isRunPaused({ agentID: "ea" })).toEqual({ paused: false });
  });

  test("pause-all stops every bot, with a reason the model can read", () => {
    setAllPaused(db, true, { actor: "owner" });
    for (const agentID of ["ea", "researcher", null]) {
      const verdict = isRunPaused({ agentID });
      expect(verdict.paused).toBe(true);
      expect(verdict.reason).toContain("paused all bots");
      expect(verdict.reason).toContain("Do not retry");
    }
  });

  test("resume clears it", () => {
    setAllPaused(db, true, { actor: "owner" });
    setAllPaused(db, false, { actor: "owner" });
    expect(isRunPaused({ agentID: "ea" })).toEqual({ paused: false });
  });

  test("per-bot off stops that bot only, naming it", () => {
    setAgentEnabled(db, "researcher", false, { actor: "owner" });
    const off = isRunPaused({ agentID: "researcher" });
    expect(off.paused).toBe(true);
    expect(off.reason).toContain("is turned off by the owner");
    expect(off.reason).toContain("Do not retry");
    expect(isRunPaused({ agentID: "ea" })).toEqual({ paused: false });
    setAgentEnabled(db, "researcher", true, { actor: "owner" });
    expect(isRunPaused({ agentID: "researcher" })).toEqual({ paused: false });
  });

  test("resuming all does not turn on a bot that was off", () => {
    setAgentEnabled(db, "researcher", false, { actor: "owner" });
    setAllPaused(db, true, { actor: "owner" });
    setAllPaused(db, false, { actor: "owner" });
    expect(isRunPaused({ agentID: "researcher" }).paused).toBe(true);
    expect(isRunPaused({ agentID: "ea" }).paused).toBe(false);
  });

  test("pause-all wins over an enabled bot: the global reason is given", () => {
    setAllPaused(db, true, { actor: "owner" });
    expect(isRunPaused({ agentID: "ea" }).reason).toContain("paused all bots");
  });

  test("an unknown bot id is not off", () => {
    expect(setAgentEnabled(db, "nobody", false, { actor: "owner" })).toBe(false);
    expect(isRunPaused({ agentID: "nobody" })).toEqual({ paused: false });
  });
});

describe("state is shared across connections", () => {
  test("a change made by another connection is seen once the cache window passes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agni-s2-pause-"));
    try {
      const path = join(dir, "agni.db");
      const daemon = openDatabase(path);
      const cli = openDatabase(path);
      bindPauseStore(daemon, { cacheMs: 20 });
      expect(isRunPaused({ agentID: "ea" }).paused).toBe(false);
      setAllPaused(cli, true, { actor: "cli" });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(isRunPaused({ agentID: "ea" }).paused).toBe(true);
      daemon.close();
      cli.close();
    } finally {
      unbindPauseStore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a change made through this connection shows at once, whatever the cache window", () => {
    bindPauseStore(db, { cacheMs: 60_000 });
    expect(isRunPaused({ agentID: "ea" }).paused).toBe(false);
    setAllPaused(db, true, { actor: "owner" });
    expect(isRunPaused({ agentID: "ea" }).paused).toBe(true);
  });
});

describe("state and audit", () => {
  test("readPauseState and listBotStates report what was set", () => {
    expect(readPauseState(db)).toMatchObject({ paused: false });
    setAllPaused(db, true, { actor: "owner" });
    setAgentEnabled(db, "researcher", false, { actor: "owner" });
    expect(readPauseState(db).paused).toBe(true);
    const bots = listBotStates(db);
    expect(bots.find((bot) => bot.agentID === "researcher")).toMatchObject({ enabled: false });
    expect(bots.find((bot) => bot.agentID === "ea")).toMatchObject({ enabled: true });
  });

  test("pause, resume and enable changes are audited with who did them", () => {
    setAllPaused(db, true, { actor: "device_1" });
    setAllPaused(db, false, { actor: "device_1" });
    setAgentEnabled(db, "researcher", false, { actor: "device_1" });
    expect(events.map((event) => event.kind)).toEqual(["pause.set", "pause.set", "agent.enabled"]);
    expect(events[0]).toMatchObject({ actor: "device_1", detail: { paused: true } });
    expect(events[1]).toMatchObject({ detail: { paused: false } });
    expect(events[2]).toMatchObject({ detail: { agentID: "researcher", enabled: false } });
  });

  test("setting the state it already has records nothing", () => {
    setAllPaused(db, false, { actor: "owner" });
    setAgentEnabled(db, "ea", true, { actor: "owner" });
    expect(events).toEqual([]);
  });

  test("turning things on fails closed when the audit sink is down; pausing still happens", () => {
    setAllPaused(db, true, { actor: "owner" });
    setAuditSink({ record() { throw new Error("audit store down"); } });
    expect(() => setAllPaused(db, false, { actor: "owner" })).toThrow("audit store down");
    expect(readPauseState(db).paused).toBe(true);
    setAllPaused(db, true, { actor: "owner" }); // already paused: nothing to record
    setAgentEnabled(db, "researcher", false, { actor: "owner" }); // the stop direction never waits on the audit log
    expect(isRunPaused({ agentID: "researcher" }).paused).toBe(true);
    expect(() => setAgentEnabled(db, "researcher", true, { actor: "owner" })).toThrow("audit store down");
    expect(isRunPaused({ agentID: "researcher" }).paused).toBe(true);
  });
});

describe("fails closed when the state cannot be read", () => {
  test("a bound database that cannot be read means paused, with the reason, for everyone", () => {
    const dead = openDatabase(":memory:");
    dead.close();
    bindPauseStore(dead, { cacheMs: 0 });
    for (const agentID of ["ea", "researcher", null]) {
      expect(isRunPaused({ agentID })).toMatchObject({ paused: true, reason: "pause state unavailable", scope: "all", unavailable: true });
    }
  });

  test("a read error after a good read does not fall back to the old answer: it is paused", () => {
    const other = openDatabase(":memory:");
    bindPauseStore(other, { cacheMs: 0 });
    expect(isRunPaused({ agentID: "ea" }).paused).toBe(false);
    other.close();
    expect(isRunPaused({ agentID: "ea" })).toMatchObject({ paused: true, reason: "pause state unavailable" });
  });

  test("it recovers as soon as the state can be read again", () => {
    const dead = openDatabase(":memory:");
    dead.close();
    bindPauseStore(dead, { cacheMs: 0 });
    expect(isRunPaused({ agentID: "ea" }).paused).toBe(true);
    bindPauseStore(db, { cacheMs: 0 });
    expect(isRunPaused({ agentID: "ea" })).toEqual({ paused: false });
  });

  test("only a store that was deliberately left unbound says not paused", () => {
    unbindPauseStore();
    expect(isPauseStoreBound()).toBe(false);
    expect(isRunPaused({ agentID: "ea" })).toEqual({ paused: false });
    bindPauseStore(db);
    expect(isPauseStoreBound()).toBe(true);
  });
});

describe("a bot's id and its aliases are one bot", () => {
  test("turned off by one alias, it stays off under the other", () => {
    expect(setAgentEnabled(db, "agni", false, { actor: "owner" })).toBe(true);
    expect(isRunPaused({ agentID: "ea" }).paused).toBe(true);
    expect(isRunPaused({ agentID: "agni" }).paused).toBe(true);
    expect(setAgentEnabled(db, "ea", true, { actor: "owner" })).toBe(true);
    expect(isRunPaused({ agentID: "agni" }).paused).toBe(false);
    expect(setAgentEnabled(db, "ea", false, { actor: "owner" })).toBe(true);
    expect(isRunPaused({ agentID: "agni" }).paused).toBe(true);
  });

  test("a flag an older write left on the alias row still counts", () => {
    db.run("UPDATE agents SET disabled = 1 WHERE id = 'agni'");
    bindPauseStore(db, { cacheMs: 0 });
    expect(isRunPaused({ agentID: "ea" }).paused).toBe(true);
  });

  test("the alias row is not listed as a bot of its own", () => {
    const ids = listBotStates(db).map((bot) => bot.agentID);
    expect(ids).toContain("ea");
    expect(ids).not.toContain("agni");
  });
});
