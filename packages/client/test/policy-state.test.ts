/**
 * S2-6: what the app keeps of the policy frames: pause state, today's spend against the caps, and
 * the runs a spend cap stopped. Pure, so the wording and the rules are tested without a screen.
 */
import { describe, expect, test } from "vitest";
import { PolicyState, money, spendLine, stopTitle, type IncomingFrame } from "../src";

function wire(object: Record<string, unknown>): IncomingFrame {
  return object as unknown as IncomingFrame;
}

const pauseFrame = (paused: boolean, bots = [{ agentID: "ea", name: "Ava", enabled: true, runningTurns: 0, scheduledJobs: 0 }]) =>
  wire({ type: "policy.pause.ok", seq: 5, paused, stopped: 0, bots });

const statusFrame = (extra: Record<string, unknown> = {}) =>
  wire({
    type: "spend.status.ok",
    seq: 6,
    day: "2026-11-17",
    resetsAt: "2026-11-18T00:00:00.000Z",
    timeZone: "UTC",
    caps: { dayUsd: 2, perBotDayUsd: 1, perJobUsd: 0.5 },
    daySpentUsd: 0.42,
    bots: [{ agentID: "ea", spentUsd: 0.3, capUsd: 1 }],
    unpricedCalls: 0,
    ...extra,
  });

const stoppedFrame = (extra: Record<string, unknown> = {}) =>
  wire({
    type: "spend.stopped",
    seq: 7,
    runKey: "run_1",
    agentId: "ea",
    scope: "job",
    reason: "over_cap",
    spentUsd: 0.5,
    capUsd: 0.5,
    message: "Ava stopped: this task reached its limit.\nThis task cost $0.50 of $0.50.\nWork done so far is kept.",
    ...extra,
  });

describe("money", () => {
  test("two decimals, and a word for less than a cent", () => {
    expect(money(0.42)).toBe("$0.42");
    expect(money(2)).toBe("$2.00");
    expect(money(0)).toBe("$0.00");
    expect(money(0.004)).toBe("under $0.01");
    expect(money(1234.5)).toBe("$1,234.50");
  });
});

describe("pause state", () => {
  test("nothing is known until the daemon says", () => {
    expect(new PolicyState().pause).toBeNull();
  });

  test("policy.pause.ok sets it, with every bot and what turning it off would stop", () => {
    const policy = new PolicyState();
    expect(policy.apply(pauseFrame(true, [{ agentID: "ea", name: "Ava", enabled: false, runningTurns: 2, scheduledJobs: 3 }]))).toBe(true);
    expect(policy.pause?.paused).toBe(true);
    expect(policy.pause?.bots[0]).toMatchObject({ agentID: "ea", enabled: false, runningTurns: 2, scheduledJobs: 3 });
    expect(policy.isOff("ea")).toBe(true);
    expect(policy.isOff("other")).toBe(false);
  });

  test("a flip is announced in words; the first state is not an event", () => {
    const policy = new PolicyState();
    policy.apply(pauseFrame(false));
    expect(policy.announcement).toBe("");
    policy.apply(pauseFrame(true));
    expect(policy.announcement).toBe("All bots paused.");
    policy.apply(pauseFrame(false));
    expect(policy.announcement).toBe("Bots resumed.");
  });

  test("a bot turned off or on is announced by name", () => {
    const policy = new PolicyState();
    policy.apply(pauseFrame(false));
    policy.apply(pauseFrame(false, [{ agentID: "ea", name: "Ava", enabled: false, runningTurns: 0, scheduledJobs: 0 }]));
    expect(policy.announcement).toBe("Ava is off.");
    policy.apply(pauseFrame(false));
    expect(policy.announcement).toBe("Ava is on.");
  });

  test("a frame it does not own is left alone", () => {
    expect(new PolicyState().apply(wire({ type: "turn.start", seq: 1, turnID: "t", threadID: "x", agentID: "ea" }))).toBe(false);
  });
});

describe("spend line", () => {
  test("shows today against the daily cap", () => {
    const policy = new PolicyState();
    policy.apply(statusFrame());
    const line = spendLine(policy.spend);
    expect(line.text).toBe("Today $0.42 of $2.00");
    expect(line.level).toBe("ok");
    expect(line.label).toBe("Spent $0.42 of $2.00 today. Open spending settings.");
  });

  test("warns from 80 percent, with words as well as colour", () => {
    const policy = new PolicyState();
    policy.apply(statusFrame({ daySpentUsd: 1.6 }));
    const line = spendLine(policy.spend);
    expect(line.level).toBe("warn");
    expect(line.hint).toBe("Close to today's limit.");
  });

  test("at the cap it says the limit is reached", () => {
    const policy = new PolicyState();
    policy.apply(statusFrame({ daySpentUsd: 2 }));
    const line = spendLine(policy.spend);
    expect(line.level).toBe("full");
    expect(line.text).toBe("Today $2.00 of $2.00. Limit reached.");
  });

  test("no data yet today is zero, not unknown", () => {
    const policy = new PolicyState();
    policy.apply(statusFrame({ daySpentUsd: 0, bots: [] }));
    expect(spendLine(policy.spend).text).toBe("Today $0.00 of $2.00");
  });

  test("with no daily cap it shows the spend alone", () => {
    const policy = new PolicyState();
    policy.apply(statusFrame({ caps: { dayUsd: null, perBotDayUsd: null, perJobUsd: null } }));
    expect(spendLine(policy.spend).text).toBe("Today $0.42");
  });

  test("a status that never came is unknown, never $0.00", () => {
    const line = spendLine(null);
    expect(line.text).toBe("Today: spending unknown");
    expect(line.level).toBe("unknown");
    expect(line.hint).toBe("Could not load today's spending.");
  });

  test("calls that had no price are said, not hidden", () => {
    const policy = new PolicyState();
    policy.apply(statusFrame({ unpricedCalls: 3 }));
    expect(spendLine(policy.spend).hint).toMatch(/3 calls? had no price/);
  });
});

describe("a run a spend cap stopped", () => {
  test("is kept with its reason and the run key to continue it", () => {
    const policy = new PolicyState();
    expect(policy.apply(stoppedFrame())).toBe(true);
    expect(policy.stops).toHaveLength(1);
    expect(policy.stops[0]).toMatchObject({ runKey: "run_1", agentID: "ea", scope: "job", reason: "over_cap", continued: null });
  });

  test("the same run stopping again is one notice, not two", () => {
    const policy = new PolicyState();
    policy.apply(stoppedFrame());
    policy.apply(stoppedFrame({ spentUsd: 1, message: "again" }));
    expect(policy.stops).toHaveLength(1);
    expect(policy.stops[0]!.message).toBe("again");
    expect(policy.stops[0]!.continued).toBeNull();
  });

  test("two runs are two notices", () => {
    const policy = new PolicyState();
    policy.apply(stoppedFrame());
    policy.apply(stoppedFrame({ runKey: "run_2", agentId: "other", scope: "bot" }));
    expect(policy.stops.map((stop) => stop.runKey)).toEqual(["run_1", "run_2"]);
  });

  test("spend.continue.ok says how much more the run may spend, for that run only", () => {
    const policy = new PolicyState();
    policy.apply(stoppedFrame());
    policy.apply(stoppedFrame({ runKey: "run_2" }));
    policy.apply(wire({ type: "spend.continue.ok", seq: 8, runKey: "run_1", grantedUsd: 0.5 }));
    expect(policy.stops.find((stop) => stop.runKey === "run_1")!.continued).toEqual({ grantedUsd: 0.5 });
    expect(policy.stops.find((stop) => stop.runKey === "run_2")!.continued).toBeNull();
  });

  test("a continue for a run this app does not hold changes nothing", () => {
    const policy = new PolicyState();
    expect(() => policy.apply(wire({ type: "spend.continue.ok", seq: 8, runKey: "nope", grantedUsd: 1 }))).not.toThrow();
    expect(policy.stops).toHaveLength(0);
  });

  test("a continue the daemon could not do marks the notice, so it can say to send the message again", () => {
    const policy = new PolicyState();
    policy.apply(stoppedFrame());
    policy.continueRefused("run_1");
    expect(policy.stops[0]!.refused).toBe(true);
  });

  test("a new turn of that bot clears its notices; another bot's stay", () => {
    const policy = new PolicyState();
    policy.apply(stoppedFrame());
    policy.apply(stoppedFrame({ runKey: "run_2", agentId: "other" }));
    policy.clearStopsOf("ea");
    expect(policy.stops.map((stop) => stop.runKey)).toEqual(["run_2"]);
  });

  test("titles name the limit that stopped it, and the button says for whom", () => {
    expect(stopTitle({ scope: "day", reason: "over_cap" }, "Ava")).toEqual({ headline: "Ava stopped: today's spending limit is used up.", raise: "Raise today's limit" });
    expect(stopTitle({ scope: "bot", reason: "over_cap" }, "Ava")).toEqual({ headline: "Ava stopped: Ava's daily limit is used up.", raise: "Raise Ava's limit" });
    expect(stopTitle({ scope: "job", reason: "over_cap" }, "Ava")).toEqual({ headline: "Ava stopped: this task reached its limit.", raise: "Raise the task limit" });
    expect(stopTitle({ scope: "job", reason: "cost_unknown" }, null).headline).toMatch(/^A bot stopped: .*could not be priced/);
    expect(stopTitle({ scope: "day", reason: "budget_unreadable" }, "Ava").headline).toMatch(/could not be read/);
  });
});
