import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SecretStore, type ClientFrame, type FrameTransport, type HealthReport, type JobInfo } from "@agni/client";
import { AppModel, agentForRoute, agentPath } from "../src/state/app-model";
import { silentNotifications, type NotificationBridge } from "../src/state/notifications";
import { AppModelProvider } from "../src/state/use-app-model";
import { RootView } from "../src/components/RootView";
import { InspectorView } from "../src/components/InspectorView";
import { AgentProfileView } from "../src/components/AgentProfileView";
import { SettingsView } from "../src/components/SettingsView";
import { MessageRowView } from "../src/components/MessageRowView";

const health: HealthReport = {
  ok: true,
  v: 2,
  serverTime: new Date().toISOString(),
  uptimeMs: 90_000,
  seq: 1,
  providers: [],
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

interface Rig {
  model: AppModel;
  sent: ClientFrame[];
  notified: Array<{ title: string; body: string }>;
}

function rig(options: { ready?: boolean; providers?: HealthReport["providers"] } = {}): Rig {
  SecretStore.save("test-token");
  const notified: Rig["notified"] = [];
  const notifier: NotificationBridge = {
    ...silentNotifications,
    post: (title, body) => void notified.push({ title, body }),
  };
  const model = new AppModel({ makeTransport: idleTransport, healthFetch: async () => ({ ...health, providers: options.providers ?? [] }), notifier, healthPollMs: 0 });
  model.start();
  const sent: ClientFrame[] = [];
  const inner = model as unknown as { connection: unknown; connectionState: unknown };
  inner.connection = { send: async (frame: ClientFrame) => void sent.push(frame), retryNow: () => undefined };
  inner.connectionState = options.ready === false ? { kind: "waiting", attempt: 3, seconds: 4, reason: "gone" } : { kind: "ready", lastSeq: 0 };
  return { model, sent, notified };
}

function frame(model: AppModel, value: unknown): void {
  act(() => (model as unknown as { handleFrame: (value: unknown) => void }).handleFrame(value));
}

function renderWith(model: AppModel, view: React.ReactElement) {
  return render(<AppModelProvider model={model}>{view}</AppModelProvider>);
}

/** The open chat is bound to the conversation the turn frames name, as it is once the daemon answers. */
function bind(model: AppModel): void {
  frame(model, { type: "conversation.ok", seq: 1, conversationID: "cnv_1", agentID: "ea", sessionID: "thr_1" });
}

const roster = [
  { id: "ea", name: "Friday", tools: [] },
  { id: "new_bot", name: "New bot", role: "unnamed", tools: [] },
  { id: "new_bot_2", name: "New bot 2", tools: [] },
];

beforeEach(() => {
  localStorage.clear();
  SecretStore.memoryToken = null;
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  SecretStore.memoryToken = null;
  vi.restoreAllMocks();
});

describe("approval cards", () => {
  const request = { type: "approval.request", seq: 1, requestID: "apr_1", action: "shell: ls", preview: "", buttons: ["once", "reject"] };

  it("name the bot that is running, never the product (S1-40)", () => {
    const { model, notified } = rig();
    frame(model, { type: "agents.update", seq: 1, agents: roster, mentions: roster });
    bind(model);
    frame(model, { type: "turn.start", seq: 2, turnID: "trn_1", threadID: "thr_1", agentID: "ea", conversationID: "cnv_1" });
    frame(model, request);
    renderWith(model, <RootView />);

    expect(screen.getByText("Friday wants to run something")).toBeInTheDocument();
    expect(screen.queryByText(/Agni wants/)).not.toBeInTheDocument();
    expect(notified[0]?.title).toBe("Friday needs your approval");
  });

  it("use neutral wording when no bot is known (S1-40)", () => {
    const { model, notified } = rig();
    frame(model, request);
    renderWith(model, <RootView />);

    expect(screen.getByText("A bot wants to run something")).toBeInTheDocument();
    expect(notified[0]?.title).toBe("Approval needed");
  });

  it("disappear when the daemon closes them, and a late click sends nothing (S1 approval.closed)", () => {
    const { model, sent } = rig();
    frame(model, request);
    renderWith(model, <RootView />);
    const approve = screen.getByRole("button", { name: /once/i });
    const approval = model.getSnapshot().conversation.approvals[0]!;

    frame(model, { type: "approval.closed", seq: 2, requestID: "apr_1", kind: "approval", reason: "decided" });
    expect(screen.queryByText("A bot wants to run something")).not.toBeInTheDocument();
    expect(model.getSnapshot().conversation.openApprovals).toHaveLength(0);

    // A click that was already on its way, or a held reference to the old card: nothing is sent.
    fireEvent.click(approve);
    model.answer(approval, "once");
    expect(sent.filter((item) => item.type === "approve.reply")).toHaveLength(0);
  });

  it("drop an answer that was waiting to be re-sent once the card is closed", async () => {
    const { model, sent } = rig();
    frame(model, request);
    const inner = model as unknown as { unsent: Map<string, unknown>; connectionState: unknown };
    inner.connectionState = { kind: "waiting", attempt: 1, seconds: 1, reason: "x" };
    model.answer(model.getSnapshot().conversation.approvals[0]!, "once");
    expect(inner.unsent.has("apr_1")).toBe(true);

    frame(model, { type: "approval.closed", seq: 2, requestID: "apr_1", kind: "approval", reason: "expired" });
    expect(inner.unsent.has("apr_1")).toBe(false);
    expect(sent.filter((item) => item.type === "approve.reply")).toHaveLength(0);
  });
});

describe("bot addresses", () => {
  it("route by the stable id, so a rename or a second 'New bot' cannot collide (S1-40)", () => {
    const [friday, first, second] = roster as never as Parameters<typeof agentPath>[0][];
    expect(agentPath(first!)).toBe("/agent/new_bot");
    expect(agentPath(second!)).toBe("/agent/new_bot_2");
    expect(agentPath(friday!)).toBe("/agent/ea");

    const renamed = { ...first!, name: "Scout" };
    expect(agentPath(renamed)).toBe("/agent/new_bot");
    const list = [friday!, renamed, second!];
    expect(agentForRoute("new_bot", list)?.name).toBe("Scout");
    expect(agentForRoute("new_bot_2", list)?.name).toBe("New bot 2");
  });

  it("still open an old name-based link when exactly one bot has that name", () => {
    const list = roster as never as Parameters<typeof agentForRoute>[1];
    expect(agentForRoute("new-bot", list)?.id).toBe("new_bot");
    // Two bots named alike: an ambiguous old link opens nothing rather than the wrong bot.
    const twins = [...list, { id: "other", name: "New Bot", tools: [] }] as never as Parameters<typeof agentForRoute>[1];
    expect(agentForRoute("new-bot", twins)).toBeNull();
  });
});

describe("the tab title", () => {
  it("is the product name until the roster is known, not a placeholder bot's name (S1-40)", () => {
    const { model } = rig();
    expect(document.title).toBe("Agni");
    frame(model, { type: "agents.update", seq: 1, agents: [{ id: "ea", name: "Friday", tools: [] }], mentions: [{ id: "ea", name: "Friday", tools: [] }] });
    expect(document.title).toBe("Friday");
  });
});

describe("the header and the lost connection", () => {
  it("says so under the header and stops saying 'Writing…' while disconnected (S1-40)", () => {
    const { model } = rig({ ready: false });
    frame(model, { type: "agents.update", seq: 1, agents: roster, mentions: roster });
    bind(model);
    frame(model, { type: "turn.start", seq: 2, turnID: "trn_1", threadID: "thr_1", agentID: "ea", conversationID: "cnv_1" });
    expect(model.getSnapshot().conversation.isStreaming).toBe(true);
    renderWith(model, <RootView />);

    expect(screen.queryByText("Writing…")).not.toBeInTheDocument();
    const banner = document.querySelector(".connection-banner")!;
    expect(banner).toHaveTextContent(/Connection lost/);
    // The band is not a live region; a hidden one announces the loss once.
    expect(banner.closest("[aria-live]")).toBeNull();
    expect(document.querySelector(".visually-hidden[aria-live]")).toHaveTextContent("Connection lost. Reconnecting.");
    expect(banner).toHaveTextContent(/attempt 3/);
    expect(screen.getByRole("button", { name: "Retry now" })).toBeInTheDocument();
  });

  it("shows 'Writing…' and no banner while connected", () => {
    const { model } = rig();
    frame(model, { type: "agents.update", seq: 1, agents: roster, mentions: roster });
    bind(model);
    frame(model, { type: "turn.start", seq: 2, turnID: "trn_1", threadID: "thr_1", agentID: "ea", conversationID: "cnv_1" });
    renderWith(model, <RootView />);
    expect(screen.getByText("Writing…")).toBeInTheDocument();
    expect(screen.queryByText(/Connection lost/)).not.toBeInTheDocument();
  });
});

function setConnection(model: AppModel, state: unknown): void {
  (model as unknown as { connectionState: unknown }).connectionState = state;
  act(() => (model as unknown as { publish: () => void }).publish());
}

describe("the connection banner (review)", () => {
  afterEach(() => vi.useRealTimers());

  it("stays out of the way of a normal first connect, and appears only if it drags on", () => {
    vi.useFakeTimers();
    const { model } = rig({ ready: false });
    setConnection(model, { kind: "connecting" });
    renderWith(model, <RootView />);
    expect(document.querySelector(".connection-banner")).toBeNull();

    setConnection(model, { kind: "handshaking" });
    act(() => void vi.advanceTimersByTime(1500));
    expect(document.querySelector(".connection-banner")).toBeNull();

    act(() => void vi.advanceTimersByTime(1000));
    expect(document.querySelector(".connection-banner")).toHaveTextContent(/Connecting/);

    setConnection(model, { kind: "ready", lastSeq: 1 });
    expect(document.querySelector(".connection-banner")).toBeNull();
    expect(document.querySelector(".visually-hidden[aria-live]")?.textContent).toBe("");
  });

  it("announces the loss and the return, not each step in between", () => {
    const { model } = rig();
    renderWith(model, <RootView />);
    const live = () => document.querySelector(".visually-hidden[aria-live]")?.textContent;
    expect(live()).toBe("");

    setConnection(model, { kind: "waiting", attempt: 1, seconds: 1, reason: "x" });
    expect(live()).toBe("Connection lost. Reconnecting.");
    for (const state of [
      { kind: "connecting" },
      { kind: "handshaking" },
      { kind: "waiting", attempt: 2, seconds: 2, reason: "x" },
    ]) {
      setConnection(model, state);
      expect(live()).toBe("Connection lost. Reconnecting.");
      // Still shown through every sub-state of the episode, never as a live region.
      expect(document.querySelector(".connection-banner")).not.toBeNull();
    }

    setConnection(model, { kind: "ready", lastSeq: 2 });
    expect(live()).toBe("Connected again.");
    expect(document.querySelector(".connection-banner")).toBeNull();
  });
});

describe("the sidebar", () => {
  it("shows previews as plain text and an avatar that is not the device's initials (S1-40)", () => {
    const { model } = rig();
    frame(model, { type: "agents.update", seq: 1, agents: roster, mentions: roster });
    frame(model, {
      type: "thread.list.ok",
      seq: 2,
      threads: [{ id: "thr_1", agentID: "ea", title: "t", updatedAt: "2026-11-16T10:00:00.000Z", preview: "**Done.** Saved the `report` to [Drive](https://x.test)." }],
    });
    const { container } = renderWith(model, <RootView />);

    expect(screen.getByText("Done. Saved the report to Drive.")).toBeInTheDocument();
    expect(container.textContent).not.toContain("**");
    expect(container.querySelector(".sidebar-owner-avatar")?.textContent).not.toBe("TP");
  });
});

describe("the routines panel", () => {
  function job(partial: Partial<JobInfo> & { id: string; kind: string }): JobInfo {
    return { state: "queued", runAt: "2026-11-17T09:00:00.000Z", enabled: true, attempts: 0, ...partial };
  }

  it("lists only the owner's jobs and no longer labels everything 'Scheduled once' (S1-40)", () => {
    const { model } = rig();
    frame(model, {
      type: "job.list.ok",
      seq: 1,
      jobs: [
        job({ id: "j1", kind: "tagger", title: "tag" }),
        job({ id: "j2", kind: "db.backup", title: "/home/me/.agni/data/backups" }),
        job({ id: "j3", kind: "memory.embed" }),
        job({ id: "j4", kind: "harness.review" }),
        job({ id: "j5", kind: "turn", title: "Stretch reminder", everyMs: 3_600_000 }),
        job({ id: "j6", kind: "turn", title: "Water the plants" }),
      ],
    });
    const { container } = renderWith(model, <InspectorView />);

    expect(screen.getByText("Stretch reminder")).toBeInTheDocument();
    expect(screen.getByText("Water the plants")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/db\.backup|tagger|memory\.embed|harness\.review|backups/);
    expect(container.textContent).not.toMatch(/Scheduled once/);
    expect(container.textContent).not.toMatch(/\bOnce\b/);
  });

  it("keeps 'Run now' off while the routine runs (S1-24)", () => {
    const { model, sent } = rig();
    frame(model, { type: "job.list.ok", seq: 1, jobs: [job({ id: "j1", kind: "turn", title: "Brief", state: "running" })] });
    renderWith(model, <InspectorView />);
    const button = screen.getByRole("button", { name: /Run Brief now/ });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(sent.filter((item) => item.type === "job.set")).toHaveLength(0);
  });

  it("turns 'Run now' off from the click until the daemon reports the job again (S1-24)", () => {
    const { model, sent } = rig();
    frame(model, { type: "job.list.ok", seq: 1, jobs: [job({ id: "j1", kind: "turn", title: "Brief" })] });
    renderWith(model, <InspectorView />);
    const button = screen.getByRole("button", { name: /Run Brief now/ });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(sent.filter((item) => item.type === "job.set")).toHaveLength(1);
    expect(button).toBeDisabled();

    frame(model, { type: "job.list.ok", seq: 2, jobs: [job({ id: "j1", kind: "turn", title: "Brief", state: "running" })] });
    frame(model, { type: "job.list.ok", seq: 3, jobs: [job({ id: "j1", kind: "turn", title: "Brief", state: "queued", attempts: 1, lastResult: "done" })] });
    expect(screen.getByRole("button", { name: /Run Brief now/ })).toBeEnabled();
  });
});

describe("the bot profile", () => {
  it("shows a placeholder, not the word 'unnamed', in the Tag field (S1-40)", () => {
    const { model } = rig();
    frame(model, { type: "agents.update", seq: 1, agents: roster, mentions: roster });
    model.selectAgent(roster[1]! as never);
    renderWith(model, <AgentProfileView />);
    const tag = screen.getByLabelText("Tag") as HTMLInputElement;
    expect(tag.value).toBe("");
    expect(tag.placeholder).toBe("What is it for?");
  });

  it("refuses an empty or over-long name out loud instead of ignoring it (S1-40)", () => {
    const { model, sent } = rig();
    frame(model, { type: "agents.update", seq: 1, agents: roster, mentions: roster });
    renderWith(model, <AgentProfileView />);
    const name = screen.getByLabelText("Name") as HTMLInputElement;

    fireEvent.change(name, { target: { value: "   " } });
    fireEvent.blur(name);
    expect(screen.getByRole("alert")).toHaveTextContent("A name can't be empty.");
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();

    fireEvent.change(name, { target: { value: "x".repeat(70) } });
    expect(name.value).toHaveLength(70);
    fireEvent.blur(name);
    expect(screen.getByRole("alert")).toHaveTextContent(/up to 64 characters/);
    expect(sent.filter((item) => item.type === "agent.rename")).toHaveLength(0);

    fireEvent.change(name, { target: { value: "Scout" } });
    fireEvent.blur(name);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(sent.filter((item) => item.type === "agent.rename")).toHaveLength(1);
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });
});

describe("new bots", () => {
  it("are created without the placeholder role 'unnamed' (S1-40)", () => {
    const { model, sent } = rig();
    model.startNewAgent();
    const create = sent.find((item) => item.type === "agent.create");
    expect(create).toBeDefined();
    expect(create && "role" in create ? create.role : undefined).toBeUndefined();
  });
});

describe("overlays", () => {
  it("close one layer at a time on Escape, and give focus back (S1-40)", async () => {
    const { model } = rig({
      providers: [{ id: "openrouter", label: "OpenRouter (:free)", model: "qwen/qwen3-max", tiers: [], available: true, cooldownRemainingMs: 0 }],
    });
    act(() => model.openSettings());
    renderWith(model, <SettingsView />);
    fireEvent.click(screen.getByRole("button", { name: "Models & providers" }));
    const choose = await screen.findByRole("button", { name: /Choose model for OpenRouter$/ });
    choose.focus();
    fireEvent.click(choose);
    expect(await screen.findByRole("dialog", { name: "Choose a model" })).toBeInTheDocument();

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Choose a model" })).not.toBeInTheDocument();
    // Settings is still open, and focus is back on the control that opened the dialog.
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    expect(model.getSnapshot().isSettingsPresented).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Choose model for OpenRouter$/ }));

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(model.getSnapshot().isSettingsPresented).toBe(false);
  });

  it("describe where model choices are saved with the real location (S1-40)", async () => {
    const { model } = rig();
    act(() => model.openSettings());
    renderWith(model, <SettingsView />);
    fireEvent.click(screen.getByRole("button", { name: "Models & providers" }));
    expect(document.body.textContent).not.toContain("data/providers.json");
    expect(document.body.textContent).toMatch(/AGNI_HOME/);
  });
});

describe("message rows", () => {
  function row(partial: Record<string, unknown>) {
    const { model } = rig();
    const message = {
      id: "m1", role: "assistant", text: "", createdAt: new Date(), turnID: "trn_1", agentID: "ea", sessionID: null,
      state: { kind: "complete" }, usage: null, tools: [], isLocalEcho: false, senderName: null, senderColor: null,
      toAgentId: null, uiHint: null, taskId: null, questionId: null, isBackground: false, isContinuation: false,
      ...partial,
    } as never;
    return renderWith(model, <MessageRowView message={message} agent={undefined} isSelected={false} onToggleSelect={() => undefined} />);
  }

  it("shows a provider failure once, readably, with the raw text folded away (S1-40)", () => {
    const raw = 'This turn failed: all providers failed — custom#1: HTTP 429: {"error":"x"} | custom#2: HTTP 429: {"error":"x"}';
    const { container } = row({ text: raw, state: { kind: "failed", reason: raw.replace("This turn failed: ", "") } });
    expect(screen.getByText("Couldn't get an answer: every model provider failed (rate limited).")).toBeInTheDocument();
    expect(container.textContent).not.toContain("Response didn't finish");
    // The raw error appears once (inside the folded details), not in the body and again in a footer.
    expect(container.textContent?.match(/HTTP 429/g)?.length).toBe(2);
    expect(container.querySelectorAll("details")).toHaveLength(1);
  });

  it("says nothing for a background job that only ran tools, but still warns for the owner's own empty reply (S1-23)", () => {
    const quiet = row({ isBackground: true });
    expect(quiet.container.textContent).not.toMatch(/produced no reply/);
    cleanup();
    const own = row({ isBackground: false });
    expect(own.container.textContent).toMatch(/produced no reply/);
  });

  it("tells the owner when a background job failed or timed out (review)", () => {
    const failed = row({ isBackground: true, state: { kind: "stopped", reason: "timeout" } });
    expect(failed.container.textContent).toMatch(/background job didn't finish/);
    cleanup();
    const errored = row({ isBackground: true, state: { kind: "failed", reason: "model unreachable" } });
    expect(errored.container.textContent).toMatch(/background job didn't finish: model unreachable\./);
  });

  it("marks a reply picked up mid-stream so it does not read as a whole sentence (S1-40)", () => {
    const { container } = row({ text: "of the sentence", state: { kind: "streaming" }, isContinuation: true });
    expect(container.querySelector(".assistant-bubble.continued")).not.toBeNull();
  });
});
