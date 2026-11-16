import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { checkBudget, configureBudget, grantContinueOnce } from "../src/policy/budget";
import {
  RUN_CAP_DEFAULTS,
  SPEND_CAP_DEFAULTS,
  getRunCaps,
  getSpendCaps,
  getSpendStatus,
  setRunCaps,
  setSpendCaps,
} from "../src/stores/policy-settings";
import { localDayBounds } from "../src/stores/usage";
import {
  DEFAULT_MAX_CONCURRENT_DELEGATIONS,
  DEFAULT_MAX_SELF_SCHEDULED_JOBS,
  DEFAULT_ROOT_JOB_WALL_MS,
  canStartDelegation,
  canSelfSchedule,
  maxConcurrentDelegations,
  maxSelfScheduledJobs,
  rootJobWallMs,
  wallTimeExceeded,
} from "../src/agent/guardrails";

let db: Database;
let seq = 0;
beforeEach(() => {
  db = openDatabase(":memory:");
  configureBudget(db);
});
afterEach(() => db.close());

function spend(costUsd: number | null, who: { agentID?: string; jobID?: string; rootJobID?: string; at?: Date } = {}): void {
  const at = who.at ?? new Date();
  db.run(
    `INSERT INTO usage_ledger (id, provider, model, input_tokens, output_tokens, day, created_at, cost_usd, agent_id, job_id, root_job_id, call_kind)
     VALUES (?, 'openrouter', 'm', 1, 1, ?, ?, ?, ?, ?, ?, 'turn')`,
    [`use_t${++seq}`, at.toISOString().slice(0, 10), at.toISOString(), costUsd, who.agentID ?? null, who.jobID ?? null, who.rootJobID ?? who.jobID ?? null],
  );
}

describe("policy settings", () => {
  test("the owner's decisions are the defaults", () => {
    expect(SPEND_CAP_DEFAULTS).toEqual({ dayUsd: 2, perBotDayUsd: 1, perJobUsd: 0.5 });
    expect(RUN_CAP_DEFAULTS).toEqual({ rootJobWallMs: 30 * 60_000, maxConcurrentDelegations: 4, maxSelfScheduledJobsPerBot: 10 });
    expect(getSpendCaps(db)).toEqual(SPEND_CAP_DEFAULTS);
    expect(getRunCaps(db)).toEqual(RUN_CAP_DEFAULTS);
  });

  test("setters persist, merge partial updates, and null means no cap", () => {
    setSpendCaps(db, { dayUsd: 0.05 });
    expect(getSpendCaps(db)).toEqual({ dayUsd: 0.05, perBotDayUsd: 1, perJobUsd: 0.5 });
    setSpendCaps(db, { perBotDayUsd: null });
    expect(getSpendCaps(db).perBotDayUsd).toBeNull();
    setRunCaps(db, { maxConcurrentDelegations: 2 });
    expect(getRunCaps(db).maxConcurrentDelegations).toBe(2);
    expect(getRunCaps(db).rootJobWallMs).toBe(RUN_CAP_DEFAULTS.rootJobWallMs);
  });

  test("a bad value is refused and changes nothing", () => {
    expect(() => setSpendCaps(db, { dayUsd: -1 })).toThrow();
    expect(() => setSpendCaps(db, { dayUsd: Number.NaN })).toThrow();
    expect(() => setSpendCaps(db, { perJobUsd: 0 })).toThrow();
    expect(() => setRunCaps(db, { maxConcurrentDelegations: 0 })).toThrow();
    expect(() => setRunCaps(db, { maxSelfScheduledJobsPerBot: 1.5 })).toThrow();
    expect(getSpendCaps(db)).toEqual(SPEND_CAP_DEFAULTS);
    expect(getRunCaps(db)).toEqual(RUN_CAP_DEFAULTS);
  });

  test("a stored value that is not a number falls back to the default", () => {
    db.run("INSERT INTO policy_settings (key, value, updated_at) VALUES ('spend.day_cap_usd', 'banana', 'x')");
    expect(getSpendCaps(db).dayUsd).toBe(2);
  });
});

describe("local day", () => {
  test("midnight is read in the given zone, not UTC", () => {
    // 2026-11-16 20:00 UTC is already 04:00 on the 17th in Singapore (UTC+8).
    const now = new Date("2026-11-16T20:00:00Z");
    const sg = localDayBounds(now, "Asia/Singapore");
    expect(sg.day).toBe("2026-11-17");
    expect(sg.startISO).toBe("2026-11-16T16:00:00.000Z");
    expect(sg.endISO).toBe("2026-11-17T16:00:00.000Z");
    const utc = localDayBounds(now, "UTC");
    expect(utc.day).toBe("2026-11-16");
    expect(utc.startISO).toBe("2026-11-16T00:00:00.000Z");
  });

  test("a zone behind UTC, and a day that is 23 hours long", () => {
    const la = localDayBounds(new Date("2026-11-16T03:00:00Z"), "America/Los_Angeles");
    expect(la.day).toBe("2026-11-15");
    expect(la.startISO).toBe("2026-11-15T08:00:00.000Z");
    // US clocks go back on 2026-11-01: that local day is 25 hours; spring forward 2026-03-08 is 23.
    const spring = localDayBounds(new Date("2026-03-08T18:00:00Z"), "America/Los_Angeles");
    expect(spring.day).toBe("2026-03-08");
    expect(spring.startISO).toBe("2026-03-08T08:00:00.000Z");
    expect(spring.endISO).toBe("2026-03-09T07:00:00.000Z");
  });

  test("spend before local midnight does not count today", () => {
    const tz = "Asia/Singapore";
    const { startISO } = localDayBounds(new Date(), tz);
    spend(1.5, { agentID: "a", at: new Date(Date.parse(startISO) - 60_000) });
    spend(0.25, { agentID: "a" });
    const status = getSpendStatus(db, { timeZone: tz });
    expect(status.daySpentUsd).toBeCloseTo(0.25, 9);
  });
});

describe("checkBudget", () => {
  test("a fresh ledger has budget left", () => {
    expect(checkBudget({ agentID: "a", jobID: "j", rootJobID: "r" })).toEqual({ ok: true });
  });

  test("the per-job cap stops a root job at $0.50, counting every call in its tree", () => {
    spend(0.3, { agentID: "a", jobID: "r", rootJobID: "r" });
    spend(0.2, { agentID: "b", jobID: "child", rootJobID: "r" });
    const decision = checkBudget({ agentID: "a", jobID: "r", rootJobID: "r" });
    expect(decision).toMatchObject({ ok: false, scope: "job", capUsd: 0.5 });
    if (!decision.ok) expect(decision.spentUsd).toBeCloseTo(0.5, 9);
    // another job is unaffected
    expect(checkBudget({ agentID: "a", jobID: "other", rootJobID: "other" })).toEqual({ ok: true });
  });

  test("a job with no root is its own root", () => {
    spend(0.6, { agentID: "a", jobID: "solo" });
    expect(checkBudget({ agentID: "a", jobID: "solo" })).toMatchObject({ ok: false, scope: "job" });
  });

  test("the per-bot cap stops one bot at $1 a day while the others carry on", () => {
    for (let i = 0; i < 4; i++) spend(0.3, { agentID: "runaway", jobID: `j${i}` });
    expect(checkBudget({ agentID: "runaway", jobID: "j-new" })).toMatchObject({ ok: false, scope: "bot", capUsd: 1 });
    expect(checkBudget({ agentID: "calm", jobID: "j-calm" })).toEqual({ ok: true });
  });

  test("the day cap stops everyone at $2", () => {
    for (const bot of ["a", "b", "c"]) spend(0.7, { agentID: bot, jobID: `j-${bot}` });
    const decision = checkBudget({ agentID: "d", jobID: "j-d" });
    expect(decision).toMatchObject({ ok: false, scope: "day", capUsd: 2 });
    if (!decision.ok) expect(decision.spentUsd).toBeCloseTo(2.1, 9);
  });

  test("the cap is read live: lowering it to $0.05 stops the next call", () => {
    spend(0.06, { agentID: "a", jobID: "j" });
    expect(checkBudget({ agentID: "a", jobID: "j" })).toEqual({ ok: true });
    setSpendCaps(db, { dayUsd: 0.05 });
    expect(checkBudget({ agentID: "a", jobID: "j" })).toMatchObject({ ok: false, scope: "day", capUsd: 0.05 });
  });

  test("a null cap is no cap", () => {
    setSpendCaps(db, { dayUsd: null, perBotDayUsd: null, perJobUsd: null });
    spend(50, { agentID: "a", jobID: "j" });
    expect(checkBudget({ agentID: "a", jobID: "j" })).toEqual({ ok: true });
  });

  test("calls of unknown cost add nothing to spend, are counted in the status, and stop the scope", () => {
    spend(null, { agentID: "a", jobID: "j" });
    spend(null, { agentID: "a", jobID: "j" });
    expect(checkBudget({ agentID: "a", jobID: "j" })).toMatchObject({ ok: false, reason: "cost_unknown" });
    expect(getSpendStatus(db).unpricedCalls).toBe(2);
  });

  test("with no database registered the check fails closed", () => {
    configureBudget(null);
    expect(checkBudget({ agentID: "a" })).toMatchObject({ ok: false, reason: "budget_unreadable" });
    configureBudget(db);
  });

  test("the narrowest scope is reported first when several are over", () => {
    setSpendCaps(db, { dayUsd: 0.1, perBotDayUsd: 0.1, perJobUsd: 0.1 });
    spend(0.5, { agentID: "a", jobID: "j" });
    expect(checkBudget({ agentID: "a", jobID: "j" })).toMatchObject({ scope: "job" });
    expect(checkBudget({ agentID: "a", jobID: "other" })).toMatchObject({ scope: "bot" });
    expect(checkBudget({ agentID: "z", jobID: "other" })).toMatchObject({ scope: "day" });
  });
});

describe("Continue once", () => {
  test("a stopped root job may spend one more per-job cap, then stops again", () => {
    spend(0.5, { agentID: "a", jobID: "r" });
    expect(checkBudget({ agentID: "a", jobID: "r" })).toMatchObject({ ok: false, scope: "job" });
    expect(grantContinueOnce("r")).toBe(0.5);
    expect(checkBudget({ agentID: "a", jobID: "r" })).toEqual({ ok: true });
    spend(0.3, { agentID: "a", jobID: "r" });
    expect(checkBudget({ agentID: "a", jobID: "r" })).toEqual({ ok: true });
    spend(0.2, { agentID: "a", jobID: "r" });
    expect(checkBudget({ agentID: "a", jobID: "r" })).toMatchObject({ ok: false, scope: "job" });
  });

  test("it also lets a run that hit the day or bot cap carry on, but only that root job", () => {
    for (let i = 0; i < 4; i++) spend(0.3, { agentID: "a", jobID: `j${i}` });
    expect(checkBudget({ agentID: "a", jobID: "jx" })).toMatchObject({ ok: false, scope: "bot" });
    grantContinueOnce("jx");
    expect(checkBudget({ agentID: "a", jobID: "jx" })).toEqual({ ok: true });
    expect(checkBudget({ agentID: "a", jobID: "jy" })).toMatchObject({ ok: false });
  });

  test("the extra amount follows the per-job cap setting", () => {
    setSpendCaps(db, { perJobUsd: 0.2 });
    spend(0.2, { agentID: "a", jobID: "r2" });
    expect(checkBudget({ agentID: "a", jobID: "r2" })).toMatchObject({ ok: false, scope: "job" });
    expect(grantContinueOnce("r2")).toBe(0.2);
  });
});

describe("spend status for the frames", () => {
  test("today's spend against each cap, overall and per bot", () => {
    spend(0.4, { agentID: "a", jobID: "j1" });
    spend(0.35, { agentID: "b", jobID: "j2" });
    spend(0.25, { agentID: "a", jobID: "j3" });
    const status = getSpendStatus(db, { now: new Date(), timeZone: "UTC" });
    expect(status.caps).toEqual(SPEND_CAP_DEFAULTS);
    expect(status.daySpentUsd).toBeCloseTo(1.0, 9);
    expect(status.bots).toEqual([
      { agentID: "a", spentUsd: expect.closeTo(0.65, 9), capUsd: 1 },
      { agentID: "b", spentUsd: expect.closeTo(0.35, 9), capUsd: 1 },
    ]);
    expect(status.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Date.parse(status.resetsAt)).toBeGreaterThan(Date.now());
    expect(status.timeZone).toBe("UTC");
  });
});

describe("run caps in guardrails", () => {
  test("defaults are the owner's numbers", () => {
    expect(DEFAULT_ROOT_JOB_WALL_MS).toBe(30 * 60_000);
    expect(DEFAULT_MAX_CONCURRENT_DELEGATIONS).toBe(4);
    expect(DEFAULT_MAX_SELF_SCHEDULED_JOBS).toBe(10);
    expect(rootJobWallMs(db)).toBe(30 * 60_000);
    expect(maxConcurrentDelegations(db)).toBe(4);
    expect(maxSelfScheduledJobs(db)).toBe(10);
  });

  test("getters follow the owner's settings", () => {
    setRunCaps(db, { rootJobWallMs: 60_000, maxConcurrentDelegations: 2, maxSelfScheduledJobsPerBot: 3 });
    expect(rootJobWallMs(db)).toBe(60_000);
    expect(maxConcurrentDelegations(db)).toBe(2);
    expect(maxSelfScheduledJobs(db)).toBe(3);
  });

  test("wall time, fan-out and self-scheduled checks", () => {
    const start = 1_000_000;
    expect(wallTimeExceeded(start, start + 30 * 60_000 - 1, 30 * 60_000)).toBe(false);
    expect(wallTimeExceeded(start, start + 30 * 60_000, 30 * 60_000)).toBe(true);
    expect(canStartDelegation(3, 4)).toBe(true);
    expect(canStartDelegation(4, 4)).toBe(false);
    expect(canSelfSchedule(9, 10)).toBe(true);
    expect(canSelfSchedule(10, 10)).toBe(false);
  });
});
