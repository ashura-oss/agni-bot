/**
 * S2-13: pausing stops the turns that are running. The turn registry aborts
 * them with a `paused` / `agent_off` reason; the startup watcher does the same
 * for a pause made from another process (`agni pause`).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { bindPauseStore, setAgentEnabled, setAllPaused, unbindPauseStore } from "../src/policy/pause";
import { setAuditSink } from "../src/policy/audit-sink";
import { enforcePause } from "../src/startup/s2-audit";
import { cancelTurnsForPause, registerTurn, runningTurnCountForAgent, unregisterTurn } from "../src/ws/turn-registry";

let db: Database;
const live: Array<[string, AbortController]> = [];

function start(turnID: string, agentID?: string): AbortController {
  const controller = new AbortController();
  registerTurn(turnID, `thr_${turnID}`, controller, undefined, agentID);
  live.push([turnID, controller]);
  return controller;
}

beforeEach(() => {
  db = openDatabase(":memory:");
  setAuditSink({ record() {} });
  bindPauseStore(db);
});

afterEach(() => {
  for (const [turnID, controller] of live.splice(0)) unregisterTurn(turnID, controller);
  unbindPauseStore();
  db.close();
});

describe("cancelTurnsForPause", () => {
  test("pause-all aborts every running turn with the reason `paused`", () => {
    const a = start("trn_a", "ea");
    const b = start("trn_b", "researcher");
    const c = start("trn_c");
    expect(cancelTurnsForPause("paused")).toBe(3);
    for (const controller of [a, b, c]) {
      expect(controller.signal.aborted).toBe(true);
      expect(controller.signal.reason).toBe("paused");
    }
  });

  test("a second pause does not count turns that are already stopped", () => {
    start("trn_a", "ea");
    expect(cancelTurnsForPause("paused")).toBe(1);
    expect(cancelTurnsForPause("paused")).toBe(0);
  });

  test("turning a bot off aborts only that bot's turns, with the reason `agent_off`", () => {
    const mine = start("trn_a", "researcher");
    const other = start("trn_b", "ea");
    const anonymous = start("trn_c");
    expect(runningTurnCountForAgent("researcher")).toBe(1);
    expect(cancelTurnsForPause("agent_off", "researcher")).toBe(1);
    expect(mine.signal.reason).toBe("agent_off");
    expect(other.signal.aborted).toBe(false);
    expect(anonymous.signal.aborted).toBe(false);
    expect(runningTurnCountForAgent("researcher")).toBe(0);
  });
});

describe("enforcePause (the watcher's step)", () => {
  test("does nothing while nothing is paused", () => {
    const turn = start("trn_a", "ea");
    expect(enforcePause({ db })).toBe(0);
    expect(turn.signal.aborted).toBe(false);
  });

  test("a pause made through the database stops running turns", () => {
    const turn = start("trn_a", "ea");
    setAllPaused(db, true, { actor: "cli" });
    expect(enforcePause({ db })).toBe(1);
    expect(turn.signal.reason).toBe("paused");
  });

  test("a bot turned off through the database stops its turns and no one else's", () => {
    const mine = start("trn_a", "researcher");
    const other = start("trn_b", "ea");
    setAgentEnabled(db, "researcher", false, { actor: "cli" });
    expect(enforcePause({ db })).toBe(1);
    expect(mine.signal.reason).toBe("agent_off");
    expect(other.signal.aborted).toBe(false);
  });
});
