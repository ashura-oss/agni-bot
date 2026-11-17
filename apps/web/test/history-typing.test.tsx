import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SecretStore, type ClientFrame, type FrameTransport, type HealthReport } from "@agni/client";
import { AppModel } from "../src/state/app-model";
import { silentNotifications } from "../src/state/notifications";
import { AppModelProvider } from "../src/state/use-app-model";
import { RootView } from "../src/components/RootView";

// History behaviour, not just addresses: what Back does after a task closes, after a bot is picked
// from Settings, and how many typing frames a burst of keystrokes sends.

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

const roster = [
  { id: "ea", name: "Friday", tools: [] },
  { id: "scout", name: "Scout", tools: [] },
];
const taskRow = (id: string, title: string) => ({
  id, title, status: "open", priority: "normal", listID: "lst_inbox",
  dueAt: new Date().toISOString(), snoozedUntil: null,
  createdAt: "2026-11-01T09:00:00.000Z", updatedAt: "2026-11-01T09:00:00.000Z",
});

/**
 * A model at `path`, with an earlier history entry `before` behind it, as if the owner had come from
 * there. `before: null` means the page was opened straight at `path`.
 */
function openAt(path: string, before: string | null = "/agent/ea"): { model: AppModel; sent: ClientFrame[] } {
  if (before) {
    window.history.replaceState({}, "", before);
    window.history.pushState({}, "", path);
  } else {
    window.history.replaceState({}, "", path);
  }
  SecretStore.save("test-token");
  const model = new AppModel({ makeTransport: idleTransport, healthFetch: async () => health, notifier: silentNotifications, healthPollMs: 0 });
  model.start();
  const sent: ClientFrame[] = [];
  const inner = model as unknown as { connection: unknown; connectionState: unknown };
  inner.connection = { send: async (frame: ClientFrame) => void sent.push(frame), retryNow: () => undefined };
  inner.connectionState = { kind: "ready", lastSeq: 0 };
  return { model, sent };
}

function show(model: AppModel) {
  return render(<AppModelProvider model={model}><RootView /></AppModelProvider>);
}

function frame(model: AppModel, value: unknown): void {
  act(() => (model as unknown as { handleFrame: (value: unknown) => void }).handleFrame(value));
}

const rosterFrame = { type: "agents.update", seq: 1, agents: roster, mentions: roster };
const listFrame = (...tasks: ReturnType<typeof taskRow>[]) => ({ type: "task.list.ok", seq: 2, tasks, lists: [] });
const sheet = (title: string) => screen.queryByRole("region", { name: `Details for ${title}` });
const path = () => window.location.pathname;

beforeEach(() => {
  localStorage.clear();
  SecretStore.memoryToken = null;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
  SecretStore.memoryToken = null;
  window.history.replaceState({}, "", "/");
  vi.restoreAllMocks();
});

/** Close a task a given way, from a task the owner opened inside the app. */
const closers: Record<string, () => void> = {
  "the close button": () => fireEvent.click(screen.getByRole("button", { name: "Close details" })),
  "Save changes": () => fireEvent.click(screen.getByRole("button", { name: "Save changes" })),
  "Activity": () => fireEvent.click(within(sheet("Write the report")!).getByRole("button", { name: "Activity" })),
  "Add subtask": () => fireEvent.click(within(sheet("Write the report")!).getByRole("button", { name: "Add subtask" })),
};

describe("closing a task", () => {
  for (const [name, close] of Object.entries(closers)) {
    it(`steps back over the task's history entry when it was opened in the app (${name})`, async () => {
      const { model } = openAt("/tasks");
      show(model);
      frame(model, rosterFrame);
      frame(model, listFrame(taskRow("tsk_1", "Write the report")));
      const length = window.history.length;
      fireEvent.click(screen.getByRole("button", { name: "Write the report" }));
      expect(path()).toBe("/task/tsk_1");
      expect(window.history.length).toBe(length + 1);

      close();
      await waitFor(() => expect(path()).toBe("/tasks"));
      expect(sheet("Write the report")).not.toBeInTheDocument();

      // Back leaves the Tasks screen. It must not reopen the task that was just closed.
      act(() => window.history.back());
      await waitFor(() => expect(path()).toBe("/agent/ea"));
      expect(sheet("Write the report")).not.toBeInTheDocument();
    });

    it(`replaces the entry when the task came from a link (${name})`, async () => {
      const { model } = openAt("/task/tsk_1");
      show(model);
      frame(model, rosterFrame);
      frame(model, listFrame(taskRow("tsk_1", "Write the report")));
      expect(sheet("Write the report")).toBeInTheDocument();
      const length = window.history.length;

      close();
      await waitFor(() => expect(path()).toBe("/tasks"));
      // Nothing was added: the address moved in place.
      expect(window.history.length).toBe(length);
    });
  }

  it("a task opened in the app, closed, and opened again still behaves the same", async () => {
    const { model } = openAt("/tasks");
    show(model);
    frame(model, rosterFrame);
    frame(model, listFrame(taskRow("tsk_1", "Write the report")));
    fireEvent.click(screen.getByRole("button", { name: "Write the report" }));
    fireEvent.click(screen.getByRole("button", { name: "Close details" }));
    await waitFor(() => expect(path()).toBe("/tasks"));
    fireEvent.click(screen.getByRole("button", { name: "Write the report" }));
    expect(path()).toBe("/task/tsk_1");
    fireEvent.click(screen.getByRole("button", { name: "Close details" }));
    await waitFor(() => expect(path()).toBe("/tasks"));
    act(() => window.history.back());
    await waitFor(() => expect(path()).toBe("/agent/ea"));
  });

  it("Forward after closing reopens the task", async () => {
    const { model } = openAt("/tasks");
    show(model);
    frame(model, rosterFrame);
    frame(model, listFrame(taskRow("tsk_1", "Write the report")));
    fireEvent.click(screen.getByRole("button", { name: "Write the report" }));
    fireEvent.click(screen.getByRole("button", { name: "Close details" }));
    await waitFor(() => expect(path()).toBe("/tasks"));
    act(() => window.history.forward());
    await waitFor(() => expect(path()).toBe("/task/tsk_1"));
    await waitFor(() => expect(sheet("Write the report")).toBeInTheDocument());
  });
});

describe("a task link keeps the list the owner was on", () => {
  it("does not reset the Inbox list to Today", () => {
    const { model } = openAt("/tasks/inbox");
    show(model);
    frame(model, rosterFrame);
    frame(model, listFrame(taskRow("tsk_1", "Write the report")));
    expect(model.getSnapshot().taskView.kind).toBe("inbox");
    fireEvent.click(screen.getByRole("button", { name: "Write the report" }));
    expect(path()).toBe("/task/tsk_1");
    expect(model.getSnapshot().taskView.kind).toBe("inbox");
    expect(screen.getByRole("heading", { level: 1, name: "Inbox" })).toBeInTheDocument();
  });

  it("keeps the list when Back and Forward move onto and off a task", async () => {
    const { model } = openAt("/tasks/inbox");
    show(model);
    frame(model, rosterFrame);
    frame(model, listFrame(taskRow("tsk_1", "Write the report")));
    fireEvent.click(screen.getByRole("button", { name: "Write the report" }));
    act(() => window.history.back());
    await waitFor(() => expect(path()).toBe("/tasks/inbox"));
    act(() => window.history.forward());
    await waitFor(() => expect(path()).toBe("/task/tsk_1"));
    expect(model.getSnapshot().taskView.kind).toBe("inbox");
  });
});

describe("picking a bot while Settings is open", () => {
  it("replaces the Settings entry, so Back does not reopen Settings", async () => {
    const { model } = openAt("/agent/ea", "/");
    show(model);
    frame(model, rosterFrame);
    act(() => model.openSettings());
    expect(path()).toBe("/settings");
    const length = window.history.length;

    const scout = model.getSnapshot().agents.find((agent) => agent.id === "scout")!;
    act(() => model.selectAgent(scout));
    expect(path()).toBe("/agent/scout");
    expect(model.getSnapshot().isSettingsPresented).toBe(false);
    expect(window.history.length).toBe(length);

    act(() => window.history.back());
    await waitFor(() => expect(path()).toBe("/agent/ea"));
    expect(model.getSnapshot().isSettingsPresented).toBe(false);
  });

  it("leaves a plain bot pick (no Settings) as a new entry", () => {
    const { model } = openAt("/agent/ea", "/");
    show(model);
    frame(model, rosterFrame);
    const length = window.history.length;
    const scout = model.getSnapshot().agents.find((agent) => agent.id === "scout")!;
    act(() => model.selectAgent(scout));
    expect(path()).toBe("/agent/scout");
    expect(window.history.length).toBe(length + 1);
  });
});

describe("typing frames", () => {
  const typing = (sent: ClientFrame[]) =>
    sent.filter((item) => item.type === "user.typing") as Array<Extract<ClientFrame, { type: "user.typing" }>>;

  function typingModel() {
    vi.useFakeTimers();
    const { model, sent } = openAt("/agent/ea", null);
    frame(model, rosterFrame);
    return { model, sent };
  }

  it("sends true when typing starts, and false once after a second of quiet", () => {
    const { model, sent } = typingModel();
    model.updateTypingState(true);
    model.updateTypingState(true);
    model.updateTypingState(true);
    expect(typing(sent).map((item) => item.isTyping)).toEqual([true]);
    vi.advanceTimersByTime(1000);
    expect(typing(sent).map((item) => item.isTyping)).toEqual([true, false]);
    // Clearing the field, then sending, after the idle timer already said false: no second false.
    model.updateTypingState(false);
    model.updateTypingState(false);
    expect(typing(sent).map((item) => item.isTyping)).toEqual([true, false]);
  });

  it("sends false at once when the field is cleared, and only once", () => {
    const { model, sent } = typingModel();
    model.updateTypingState(true);
    model.updateTypingState(false);
    model.updateTypingState(false);
    vi.advanceTimersByTime(5000);
    expect(typing(sent).map((item) => item.isTyping)).toEqual([true, false]);
  });

  it("sends true again after a pause", () => {
    const { model, sent } = typingModel();
    model.updateTypingState(true);
    vi.advanceTimersByTime(1500);
    model.updateTypingState(true);
    expect(typing(sent).map((item) => item.isTyping)).toEqual([true, false, true]);
  });

  it("sends false to the channel it said true to, if the bot changed meanwhile", () => {
    const { model, sent } = typingModel();
    model.updateTypingState(true);
    const scout = model.getSnapshot().agents.find((agent) => agent.id === "scout")!;
    act(() => model.selectAgent(scout));
    model.updateTypingState(false);
    expect(typing(sent).map((item) => [item.channelId, item.isTyping])).toEqual([["main", true], ["main", false]]);
  });

  it("sends nothing when the typing indicator is off", () => {
    const { model, sent } = typingModel();
    model.setPreference("typingIndicator", false);
    model.updateTypingState(true);
    model.updateTypingState(false);
    vi.advanceTimersByTime(2000);
    expect(typing(sent)).toEqual([]);
  });

  it("30 keystrokes a second for 20 seconds send at most about 8 frames", () => {
    const { model, sent } = typingModel();
    for (let tick = 0; tick < 20 * 30; tick += 1) {
      model.updateTypingState(true);
      vi.advanceTimersByTime(1000 / 30);
    }
    vi.advanceTimersByTime(2000);
    const frames = typing(sent);
    expect(frames.length).toBeLessThanOrEqual(9);
    expect(frames.length).toBeGreaterThanOrEqual(2);
    expect(frames[0]?.isTyping).toBe(true);
    expect(frames.at(-1)?.isTyping).toBe(false);
    // No more than one true every 3 seconds.
    expect(frames.filter((item) => item.isTyping).length).toBeLessThanOrEqual(8);
  });
});
