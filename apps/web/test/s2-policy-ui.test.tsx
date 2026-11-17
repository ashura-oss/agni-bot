/**
 * S2-6: pause and off, today's spend, the budget stop and its Continue, the Spending settings, and
 * the stop marker after a reload. Frames go in the way the daemon sends them; what the owner sees
 * and what the app sends back are checked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { SecretStore, type ClientFrame, type FrameTransport, type HealthReport } from "@agni/client";
import { AppModel } from "../src/state/app-model";
import { silentNotifications } from "../src/state/notifications";
import { AppModelProvider } from "../src/state/use-app-model";
import { RootView } from "../src/components/RootView";

const health: HealthReport = {
  ok: true, v: 2, serverTime: new Date().toISOString(), uptimeMs: 90_000, seq: 1, providers: [],
  usageToday: { turns: 0, inputTokens: 0, outputTokens: 0 },
};

function idleTransport(): FrameTransport {
  return {
    open: () => new Promise<void>(() => undefined),
    send: async () => undefined,
    receive: () => new Promise<string>(() => undefined),
    close: async () => undefined,
  };
}

function rig() {
  SecretStore.save("test-token");
  const model = new AppModel({ makeTransport: idleTransport, healthFetch: async () => health, notifier: silentNotifications, healthPollMs: 0 });
  model.start();
  const sent: ClientFrame[] = [];
  const inner = model as unknown as { connection: unknown; connectionState: unknown };
  inner.connection = { send: async (value: ClientFrame) => void sent.push(value), retryNow: () => undefined };
  inner.connectionState = { kind: "ready", lastSeq: 0 };
  return { model, sent };
}

function frame(model: AppModel, value: unknown): void {
  act(() => (model as unknown as { handleFrame: (value: unknown) => void }).handleFrame(value));
}

function renderWith(model: AppModel) {
  return render(
    <AppModelProvider model={model}>
      <RootView />
    </AppModelProvider>,
  );
}

function settle(): Promise<void> {
  return act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const roster = [
  { id: "ea", name: "Ava", tools: [] },
  { id: "scout", name: "Scout", tools: [] },
];

const pauseOk = (paused: boolean, bots?: unknown[]) => ({
  type: "policy.pause.ok",
  seq: 20,
  paused,
  stopped: 0,
  bots: bots ?? [
    { agentID: "ea", name: "Ava", enabled: true, runningTurns: 0, scheduledJobs: 0 },
    { agentID: "scout", name: "Scout", enabled: true, runningTurns: 0, scheduledJobs: 0 },
  ],
});

const spendOk = (extra: Record<string, unknown> = {}) => ({
  type: "spend.status.ok",
  seq: 21,
  day: "2026-11-17",
  resetsAt: "2026-11-18T00:00:00.000Z",
  timeZone: "UTC",
  caps: { dayUsd: 2, perBotDayUsd: 1, perJobUsd: 0.5 },
  daySpentUsd: 0.42,
  bots: [{ agentID: "ea", spentUsd: 0.3, capUsd: 1 }, { agentID: "scout", spentUsd: 0.12, capUsd: 1 }],
  unpricedCalls: 0,
  ...extra,
});

const stopped = (extra: Record<string, unknown> = {}) => ({
  type: "spend.stopped",
  seq: 22,
  runKey: "run_1",
  agentId: "ea",
  scope: "job",
  reason: "over_cap",
  spentUsd: 0.5,
  capUsd: 0.5,
  message: "Ava stopped: this task reached its limit.\nThis task cost $0.50 of $0.50.\nWork done so far is kept.",
  ...extra,
});

beforeEach(() => {
  localStorage.clear();
  SecretStore.memoryToken = null;
  window.history.replaceState({}, "", "/agent/ea");
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  SecretStore.memoryToken = null;
  window.history.replaceState({}, "", "/");
  vi.restoreAllMocks();
});

describe("what the app asks for and keeps", () => {
  it("reads the pause state and today's spend when the connection is ready", async () => {
    const { model, sent } = rig();
    const inner = model as unknown as { handle: (event: unknown) => void };
    act(() => inner.handle({ type: "state", state: { kind: "ready", lastSeq: 0 } }));
    await settle();
    expect(sent).toContainEqual({ type: "policy.pause" });
    expect(sent).toContainEqual({ type: "spend.status" });
  });

  it("asks for today's spend again when a turn ends", async () => {
    const { model, sent } = rig();
    frame(model, { type: "turn.end", seq: 30, turnID: "trn_1", threadID: "thr_1", stopReason: "end" });
    await settle();
    expect(sent).toContainEqual({ type: "spend.status" });
  });

  it("keeps the policy frames in the snapshot", () => {
    const { model } = rig();
    frame(model, pauseOk(true));
    frame(model, spendOk());
    expect(model.getSnapshot().policy.pause?.paused).toBe(true);
    expect(model.getSnapshot().policy.spend?.daySpentUsd).toBe(0.42);
  });

  it("pause, resume, turn off and turn on send the frames the daemon expects", async () => {
    const { model, sent } = rig();
    act(() => model.setAllPaused(true));
    act(() => model.setAllPaused(false));
    act(() => model.setBotEnabled("ea", false));
    act(() => model.setBotEnabled("ea", true));
    await settle();
    expect(sent).toEqual([
      { type: "policy.pause", paused: true },
      { type: "policy.pause", paused: false },
      { type: "agent.enabled.set", agentID: "ea", enabled: false },
      { type: "agent.enabled.set", agentID: "ea", enabled: true },
    ]);
  });

  it("a send that cannot go out says so instead of pretending the bots are paused", async () => {
    const { model } = rig();
    (model as unknown as { connectionState: unknown }).connectionState = { kind: "waiting", attempt: 1, seconds: 1, reason: "gone" };
    act(() => model.setAllPaused(true));
    expect(model.getSnapshot().toast?.kind).toBe("failure");
    expect(model.getSnapshot().policy.pause).toBeNull();
  });

  it("Continue sends the run key; the daemon's answer says how much more it may spend", async () => {
    const { model, sent } = rig();
    frame(model, stopped());
    act(() => model.continueSpend("run_1"));
    await settle();
    expect(sent).toContainEqual({ type: "spend.continue", runKey: "run_1" });
    frame(model, { type: "spend.continue.ok", seq: 23, runKey: "run_1", grantedUsd: 0.5 });
    expect(model.getSnapshot().policy.stops[0]!.continued).toEqual({ grantedUsd: 0.5 });
  });

  it("a Continue the daemon cannot do (not_found) marks the notice, with no 'already gone' toast", async () => {
    const { model } = rig();
    frame(model, stopped());
    act(() => model.continueSpend("run_1"));
    await settle();
    frame(model, { type: "error", seq: 24, code: "not_found", message: "no stopped run run_1" });
    expect(model.getSnapshot().policy.stops[0]!.refused).toBe(true);
    expect(model.getSnapshot().toast?.title).not.toBe("Already gone");
  });

  it("a new turn of the bot clears its stop notice", () => {
    const { model } = rig();
    frame(model, stopped());
    frame(model, { type: "turn.start", seq: 25, turnID: "trn_9", threadID: "thr_1", agentID: "ea" });
    expect(model.getSnapshot().policy.stops).toHaveLength(0);
  });

  it("saves the caps with spend.caps.set", async () => {
    const { model, sent } = rig();
    act(() => model.saveSpendCaps({ dayUsd: 3, perBotDayUsd: 1.5, perJobUsd: 0.75 }));
    await settle();
    expect(sent).toContainEqual({ type: "spend.caps.set", dayUsd: 3, perBotDayUsd: 1.5, perJobUsd: 0.75 });
  });

  it("a refused cap (bad_cap) is kept for the form to show, and cleared by the next status", () => {
    const { model } = rig();
    frame(model, { type: "error", seq: 26, code: "bad_cap", message: "Each bot's limit cannot be more than the daily limit." });
    expect(model.getSnapshot().policy.capsError).toMatch(/cannot be more than the daily limit/);
    frame(model, spendOk());
    expect(model.getSnapshot().policy.capsError).toBeNull();
  });

  it("a message to a bot that is off comes back to the composer", async () => {
    const { model } = rig();
    frame(model, { type: "agents.update", seq: 1, agents: roster, mentions: roster });
    act(() => void model.send("hello there"));
    frame(model, { type: "error", seq: 27, code: "agent_off", message: "Ava is off. Turn Ava on to get a reply." });
    expect(model.getSnapshot().rejectedDraft?.text).toBe("hello there");
    expect(model.getSnapshot().conversation.messages.some((message) => message.isLocalEcho)).toBe(false);
  });
});

describe("the header", () => {
  it("shows today's spend against the cap, with its own name for a screen reader", () => {
    const { model } = rig();
    frame(model, { type: "agents.update", seq: 1, agents: roster, mentions: roster });
    frame(model, spendOk());
    renderWith(model);
    const chip = screen.getByRole("button", { name: "Spent $0.42 of $2.00 today. Open spending settings." });
    expect(chip).toHaveTextContent("Today $0.42 of $2.00");
  });

  it("says 'spending unknown', never $0.00, before the daemon has answered", () => {
    const { model } = rig();
    frame(model, { type: "agents.update", seq: 1, agents: roster, mentions: roster });
    renderWith(model);
    expect(screen.getByText("Today: spending unknown")).toBeInTheDocument();
    expect(screen.queryByText(/\$0\.00/)).not.toBeInTheDocument();
  });

  it("marks 80 percent with words", () => {
    const { model } = rig();
    frame(model, { type: "agents.update", seq: 1, agents: roster, mentions: roster });
    frame(model, spendOk({ daySpentUsd: 1.7 }));
    renderWith(model);
    const chip = screen.getByRole("button", { name: /Spent \$1\.70 of \$2\.00 today/ });
    expect(chip).toHaveAttribute("data-level", "warn");
    expect(chip.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(chip.getAttribute("aria-describedby")!)?.textContent).toMatch(/Close to today's limit/);
  });

  it("clicking it opens Settings on Spending", () => {
    const { model } = rig();
    frame(model, { type: "agents.update", seq: 1, agents: roster, mentions: roster });
    frame(model, spendOk());
    renderWith(model);
    fireEvent.click(screen.getByRole("button", { name: /Open spending settings/ }));
    expect(model.getSnapshot().isSettingsPresented).toBe(true);
    expect(model.getSnapshot().settingsSection).toBe("spending");
  });
});

describe("pause all", () => {
  it("one click pauses, with no confirmation; the banner and the button then say resume", async () => {
    const { model, sent } = rig();
    frame(model, { type: "agents.update", seq: 1, agents: roster, mentions: roster });
    // The daemon's first answer is the starting point; only a change after it is announced.
    frame(model, pauseOk(false));
    renderWith(model);
    fireEvent.click(screen.getByRole("button", { name: "Pause all bots" }));
    await settle();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(sent).toContainEqual({ type: "policy.pause", paused: true });

    frame(model, pauseOk(true));
    expect(screen.getByText("All bots are paused. Nothing new will start.")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Resume all bots" }).length).toBeGreaterThanOrEqual(2);
    // Said to a screen reader, politely.
    expect(screen.getByText("All bots paused.", { selector: "[role=status]" })).toBeInTheDocument();
  });

  it("resuming sends paused:false and the banner goes", async () => {
    const { model, sent } = rig();
    frame(model, { type: "agents.update", seq: 1, agents: roster, mentions: roster });
    frame(model, pauseOk(true));
    renderWith(model);
    fireEvent.click(screen.getAllByRole("button", { name: "Resume all bots" })[0]!);
    await settle();
    expect(sent).toContainEqual({ type: "policy.pause", paused: false });
    frame(model, pauseOk(false));
    expect(screen.queryByText("All bots are paused. Nothing new will start.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause all bots" })).toBeInTheDocument();
  });

  it("the composer says the message will wait", () => {
    const { model } = rig();
    frame(model, { type: "agents.update", seq: 1, agents: roster, mentions: roster });
    frame(model, pauseOk(true));
    renderWith(model);
    expect(screen.getByPlaceholderText("Bots are paused. Your message will wait until you resume.")).toBeInTheDocument();
  });
});

describe("one bot off", () => {
  function openProfile(model: AppModel) {
    act(() => model.openAgentProfile());
  }

  it("the profile has a switch named for the bot; turning it off with nothing running is one click", async () => {
    const { model, sent } = rig();
    frame(model, { type: "agents.update", seq: 1, agents: roster, mentions: roster });
    frame(model, pauseOk(false));
    renderWith(model);
    openProfile(model);
    const power = screen.getByRole("switch", { name: "Ava" });
    expect(power).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Ava is on")).toBeInTheDocument();
    fireEvent.click(power);
    await settle();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(sent).toContainEqual({ type: "agent.enabled.set", agentID: "ea", enabled: false });
  });

  it("with work running or scheduled it asks first, naming what stops, and starts on 'Keep Ava on'", async () => {
    const { model, sent } = rig();
    frame(model, { type: "agents.update", seq: 1, agents: roster, mentions: roster });
    frame(model, pauseOk(false, [{ agentID: "ea", name: "Ava", enabled: true, runningTurns: 2, scheduledJobs: 3 }]));
    renderWith(model);
    openProfile(model);
    fireEvent.click(screen.getByRole("switch", { name: "Ava" }));
    await settle();
    const dialog = screen.getByRole("dialog", { name: "Turn off Ava?" });
    expect(within(dialog).getByText("Ava's 2 running tasks will stop.")).toBeInTheDocument();
    expect(within(dialog).getByText("Ava's 3 scheduled jobs will not run until you turn Ava back on.")).toBeInTheDocument();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Keep Ava on" }));
    expect(sent.filter((item) => item.type === "agent.enabled.set")).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole("button", { name: "Turn off Ava" }));
    await settle();
    expect(sent).toContainEqual({ type: "agent.enabled.set", agentID: "ea", enabled: false });
    expect(screen.queryByRole("dialog", { name: "Turn off Ava?" })).not.toBeInTheDocument();
  });

  it("a line with a count of 0 is left out, and Escape keeps the bot on", async () => {
    const { model, sent } = rig();
    frame(model, { type: "agents.update", seq: 1, agents: roster, mentions: roster });
    frame(model, pauseOk(false, [{ agentID: "ea", name: "Ava", enabled: true, runningTurns: 1, scheduledJobs: 0 }]));
    renderWith(model);
    openProfile(model);
    fireEvent.click(screen.getByRole("switch", { name: "Ava" }));
    await settle();
    const dialog = screen.getByRole("dialog", { name: "Turn off Ava?" });
    expect(within(dialog).getByText("Ava's running task will stop.")).toBeInTheDocument();
    expect(within(dialog).queryByText(/scheduled/)).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Turn off Ava?" })).not.toBeInTheDocument();
    expect(sent.filter((item) => item.type === "agent.enabled.set")).toHaveLength(0);
  });

  it("an off bot reads Off in the roster, in text", () => {
    const { model } = rig();
    frame(model, { type: "agents.update", seq: 1, agents: roster, mentions: roster });
    frame(model, pauseOk(false, [
      { agentID: "ea", name: "Ava", enabled: false, runningTurns: 0, scheduledJobs: 0 },
      { agentID: "scout", name: "Scout", enabled: true, runningTurns: 0, scheduledJobs: 0 },
    ]));
    renderWith(model);
    const row = screen.getByRole("button", { name: "Open Ava chat" });
    expect(within(row).getByText("Off")).toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: "Open Scout chat" })).queryByText("Off")).not.toBeInTheDocument();
  });

  it("the composer says the bot is off, disables Send with the reason, and offers Turn on", async () => {
    const { model, sent } = rig();
    frame(model, { type: "agents.update", seq: 1, agents: roster, mentions: roster });
    frame(model, pauseOk(false, [{ agentID: "ea", name: "Ava", enabled: false, runningTurns: 0, scheduledJobs: 0 }]));
    renderWith(model);
    const box = screen.getByPlaceholderText("Ava is off. Turn Ava on to get a reply.");
    fireEvent.change(box, { target: { value: "hello" } });
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeDisabled();
    expect(send.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(send.getAttribute("aria-describedby")!)?.textContent).toMatch(/Ava is off/);
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    await settle();
    expect(sent).toContainEqual({ type: "agent.enabled.set", agentID: "ea", enabled: true });
  });
});

describe("a run a spend cap stopped", () => {
  it("shows the daemon's headline in the bot's thread with Raise and Continue once", () => {
    const { model } = rig();
    frame(model, { type: "agents.update", seq: 1, agents: roster, mentions: roster });
    frame(model, stopped());
    renderWith(model);
    // The rest of the notice is the message the daemon writes into the thread; the card repeats only the first line.
    expect(within(screen.getByRole("group", { name: /Ava stopped/ })).getByText("Ava stopped: this task reached its limit.")).toBeInTheDocument();
    expect(screen.queryByText(/This task cost/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Raise the task limit" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue once" })).toBeInTheDocument();
  });

  it("is not shown in another bot's thread", () => {
    const { model } = rig();
    frame(model, { type: "agents.update", seq: 1, agents: roster, mentions: roster });
    frame(model, stopped({ agentId: "scout" }));
    renderWith(model);
    expect(screen.queryByText(/This task cost/)).not.toBeInTheDocument();
  });

  it("the button per scope names who it is for", () => {
    const { model } = rig();
    frame(model, { type: "agents.update", seq: 1, agents: roster, mentions: roster });
    frame(model, stopped({ scope: "bot", message: "Ava stopped: Ava's daily limit is used up." }));
    renderWith(model);
    expect(screen.getByRole("button", { name: "Raise Ava's limit" })).toBeInTheDocument();
  });

  it("Continue once sends that run's key; afterwards it says what was allowed and to send a message", async () => {
    const { model, sent } = rig();
    frame(model, { type: "agents.update", seq: 1, agents: roster, mentions: roster });
    frame(model, stopped());
    renderWith(model);
    fireEvent.click(screen.getByRole("button", { name: "Continue once" }));
    await settle();
    expect(sent).toContainEqual({ type: "spend.continue", runKey: "run_1" });
    frame(model, { type: "spend.continue.ok", seq: 23, runKey: "run_1", grantedUsd: 0.5 });
    expect(screen.getByText(/This run may spend up to \$0\.50 more\. Send a message to carry on\./)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue once" })).not.toBeInTheDocument();
  });

  it("says so when the daemon could not continue the run", async () => {
    const { model } = rig();
    frame(model, { type: "agents.update", seq: 1, agents: roster, mentions: roster });
    frame(model, stopped());
    renderWith(model);
    fireEvent.click(screen.getByRole("button", { name: "Continue once" }));
    await settle();
    frame(model, { type: "error", seq: 24, code: "not_found", message: "no stopped run" });
    expect(screen.getByText(/can no longer be continued/i)).toBeInTheDocument();
  });

  it("Raise opens Settings on Spending", () => {
    const { model } = rig();
    frame(model, { type: "agents.update", seq: 1, agents: roster, mentions: roster });
    frame(model, stopped());
    renderWith(model);
    fireEvent.click(screen.getByRole("button", { name: "Raise the task limit" }));
    expect(model.getSnapshot().settingsSection).toBe("spending");
  });

  it("a notice that came from a daemon line with markup is drawn as text", () => {
    const { model } = rig();
    frame(model, { type: "agents.update", seq: 1, agents: roster, mentions: roster });
    frame(model, stopped({ message: "Ava stopped: <b>bold</b> ‮evil" }));
    renderWith(model);
    expect(within(screen.getByRole("group", { name: /Ava stopped/ })).getByText(/<b>bold<\/b>/)).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain("‮");
  });
});

describe("Settings, Spending", () => {
  function open(model: AppModel) {
    frame(model, { type: "agents.update", seq: 1, agents: roster, mentions: roster });
    frame(model, spendOk());
    act(() => model.openSettings("spending"));
  }

  it("lists today's spend, each bot that spent, and the three limits", () => {
    const { model } = rig();
    open(model);
    renderWith(model);
    expect(screen.getByRole("heading", { name: "Spending" })).toBeInTheDocument();
    expect(screen.getByText("Today: $0.42 of $2.00")).toBeInTheDocument();
    const settings = within(screen.getByRole("dialog", { name: "Settings" }));
    expect(settings.getByText("Ava")).toBeInTheDocument();
    expect(settings.getByText("$0.30 of $1.00")).toBeInTheDocument();
    expect((screen.getByLabelText("Daily limit, all bots") as HTMLInputElement).value).toBe("2.00");
    expect((screen.getByLabelText("Daily limit, each bot") as HTMLInputElement).value).toBe("1.00");
    expect((screen.getByLabelText("Limit per task") as HTMLInputElement).value).toBe("0.50");
  });

  it("with no spend yet it says so", () => {
    const { model } = rig();
    frame(model, { type: "agents.update", seq: 1, agents: roster, mentions: roster });
    frame(model, spendOk({ daySpentUsd: 0, bots: [] }));
    act(() => model.openSettings("spending"));
    renderWith(model);
    expect(screen.getByText("No spending yet today.")).toBeInTheDocument();
  });

  it("refuses a bad amount under the field and sends nothing", async () => {
    const { model, sent } = rig();
    open(model);
    renderWith(model);
    const field = screen.getByLabelText("Daily limit, all bots");
    fireEvent.change(field, { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Save limits" }));
    await settle();
    expect(screen.getByText("Enter an amount, like 2.00.")).toBeInTheDocument();
    expect(field).toHaveAttribute("aria-invalid", "true");
    fireEvent.change(field, { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Save limits" }));
    expect(screen.getByText("Must be more than $0.00.")).toBeInTheDocument();
    expect(sent.filter((item) => item.type === "spend.caps.set")).toHaveLength(0);
  });

  it("refuses a per-bot limit above the daily limit", () => {
    const { model, sent } = rig();
    open(model);
    renderWith(model);
    fireEvent.change(screen.getByLabelText("Daily limit, each bot"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save limits" }));
    expect(screen.getByText("Each bot's limit cannot be more than the daily limit.")).toBeInTheDocument();
    expect(sent.filter((item) => item.type === "spend.caps.set")).toHaveLength(0);
  });

  it("saves the three limits, and says saved once the daemon's status shows them", async () => {
    const { model, sent } = rig();
    open(model);
    renderWith(model);
    fireEvent.change(screen.getByLabelText("Daily limit, all bots"), { target: { value: "$3" } });
    fireEvent.change(screen.getByLabelText("Limit per task"), { target: { value: "0.75" } });
    fireEvent.click(screen.getByRole("button", { name: "Save limits" }));
    await settle();
    expect(sent).toContainEqual({ type: "spend.caps.set", dayUsd: 3, perBotDayUsd: 1, perJobUsd: 0.75 });
    expect(screen.queryByText("Limits saved.")).not.toBeInTheDocument();
    frame(model, spendOk({ caps: { dayUsd: 3, perBotDayUsd: 1, perJobUsd: 0.75 } }));
    expect(screen.getByText("Limits saved.")).toBeInTheDocument();
  });

  it("shows the daemon's refusal of a cap", async () => {
    const { model } = rig();
    open(model);
    renderWith(model);
    fireEvent.click(screen.getByRole("button", { name: "Save limits" }));
    await settle();
    frame(model, { type: "error", seq: 30, code: "bad_cap", message: "The per-bot limit cannot be more than the daily limit." });
    expect(screen.getByRole("alert").textContent).toMatch(/cannot be more than the daily limit/);
  });
});

describe("the stop marker after a reload (item 5)", () => {
  it("history that names a stop on the owner's row draws 'No reply — stopped.' with no local memory", () => {
    const { model } = rig();
    frame(model, { type: "agents.update", seq: 1, agents: roster, mentions: roster });
    frame(model, { type: "conversation.ok", seq: 2, conversationID: "cnv_1", agentID: "ea", sessionID: "thr_1" });
    frame(model, {
      type: "conversation.history.ok", seq: 3, conversationID: "cnv_1",
      messages: [{ id: "m1", role: "user", text: "big job", createdAt: "2026-11-17T10:00:00.000Z", turnID: "trn_1", stopReason: "cancelled" }],
    });
    localStorage.clear();
    renderWith(model);
    expect(screen.getByText("No reply — stopped.")).toBeInTheDocument();
  });

  it("a browser that also remembers the stop does not draw it twice", () => {
    const { model } = rig();
    localStorage.setItem("dev.agni.stops", JSON.stringify({ trn_1: "cancelled" }));
    frame(model, { type: "agents.update", seq: 1, agents: roster, mentions: roster });
    frame(model, { type: "conversation.ok", seq: 2, conversationID: "cnv_1", agentID: "ea", sessionID: "thr_1" });
    frame(model, {
      type: "conversation.history.ok", seq: 3, conversationID: "cnv_1",
      messages: [{ id: "m1", role: "user", text: "big job", createdAt: "2026-11-17T10:00:00.000Z", turnID: "trn_1", stopReason: "cancelled" }],
    });
    renderWith(model);
    expect(screen.getAllByText("No reply — stopped.")).toHaveLength(1);
  });

  it("a budget stop reads 'No reply — out of budget.'", () => {
    const { model } = rig();
    frame(model, { type: "agents.update", seq: 1, agents: roster, mentions: roster });
    frame(model, { type: "conversation.ok", seq: 2, conversationID: "cnv_1", agentID: "ea", sessionID: "thr_1" });
    frame(model, {
      type: "conversation.history.ok", seq: 3, conversationID: "cnv_1",
      messages: [{ id: "m1", role: "user", text: "big job", createdAt: "2026-11-17T10:00:00.000Z", turnID: "trn_1", stopReason: "budget" }],
    });
    renderWith(model);
    expect(screen.getByText("No reply — out of budget.")).toBeInTheDocument();
  });
});
