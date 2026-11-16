import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SecretStore, type ClientFrame, type FrameTransport, type HealthReport } from "@agni/client";
import { AppModel } from "../src/state/app-model";
import { silentNotifications } from "../src/state/notifications";
import { AppModelProvider } from "../src/state/use-app-model";
import { RootView } from "../src/components/RootView";

// TasksView belongs to another task: the route only has to hand it the id from the address.
vi.mock("../src/components/TasksView", () => ({
  TasksView: (props: { openTaskID?: string | null }) => <main data-testid="tasks-stub" data-open-task={props.openTaskID ?? ""} />,
}));

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
  { id: "new_bot", name: "New bot", tools: [] },
];

/** A model at the given address, as if the page had just loaded there. */
function openAt(path: string): { model: AppModel; sent: ClientFrame[] } {
  window.history.replaceState({}, "", path);
  SecretStore.save("test-token");
  const model = new AppModel({ makeTransport: idleTransport, healthFetch: async () => health, notifier: silentNotifications, healthPollMs: 0 });
  model.start();
  const sent: ClientFrame[] = [];
  const inner = model as unknown as { connection: unknown; connectionState: unknown };
  inner.connection = { send: async (frame: ClientFrame) => void sent.push(frame), retryNow: () => undefined };
  inner.connectionState = { kind: "ready", lastSeq: 0 };
  return { model, sent };
}

function frame(model: AppModel, value: unknown): void {
  act(() => (model as unknown as { handleFrame: (value: unknown) => void }).handleFrame(value));
}

function show(model: AppModel) {
  return render(<AppModelProvider model={model}><RootView /></AppModelProvider>);
}

const rosterFrame = { type: "agents.update", seq: 1, agents: roster, mentions: roster };

beforeEach(() => {
  localStorage.clear();
  SecretStore.memoryToken = null;
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  SecretStore.memoryToken = null;
  window.history.replaceState({}, "", "/");
  vi.restoreAllMocks();
});

describe("deep links", () => {
  it("open the bot an address names once the roster arrives", () => {
    const { model } = openAt("/agent/scout");
    show(model);
    frame(model, rosterFrame);
    expect(model.getSnapshot().conversation.agentID).toBe("scout");
    expect(window.location.pathname).toBe("/agent/scout");
    expect(model.getSnapshot().notFound).toBeNull();
  });

  it("show a not-found state for an unknown bot, and keep the address", () => {
    const { model } = openAt("/agent/ghost");
    show(model);
    // Until the roster is known the bot might still exist: no verdict yet.
    expect(screen.queryByRole("heading", { name: /not found/i })).not.toBeInTheDocument();
    frame(model, rosterFrame);
    expect(screen.getByRole("heading", { name: /not found/i })).toBeInTheDocument();
    expect(screen.getByText(/\/agent\/ghost/)).toBeInTheDocument();
    expect(window.location.pathname).toBe("/agent/ghost");
  });

  it("leave the not-found state when a bot is picked from the roster", () => {
    const { model } = openAt("/agent/ghost");
    show(model);
    frame(model, rosterFrame);
    fireEvent.click(screen.getByRole("button", { name: "Open Scout chat" }));
    expect(screen.queryByRole("heading", { name: /not found/i })).not.toBeInTheDocument();
    expect(window.location.pathname).toBe("/agent/scout");
  });

  it("show a page that does not exist as not found, keeping its address", () => {
    const { model } = openAt("/nowhere/at/all");
    show(model);
    expect(screen.getByRole("heading", { name: /not found/i })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/nowhere/at/all");
  });

  it("open a group by its id, and call an unknown group not found", () => {
    const { model, sent } = openAt("/group/grp_1");
    show(model);
    model.refreshGroups();
    expect(sent.some((item) => item.type === "channel.list")).toBe(true);
    frame(model, { type: "channel.list.ok", seq: 2, channels: [{ id: "grp_1", name: "Launch crew", type: "group", agentIds: ["ea", "scout"], createdAt: "2026-11-16T10:00:00.000Z" }] });
    expect(screen.getByRole("heading", { name: "Launch crew" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/group/grp_1");
    expect(document.title).toBe("Launch crew");
    // The group page is not a bot's chat: no bot row claims to be open.
    for (const row of screen.getAllByRole("button", { name: "Open New Bot chat" })) expect(row).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("button", { name: "Open Launch crew group" })).toHaveAttribute("aria-current", "page");

    act(() => window.history.pushState({}, "", "/group/other"));
    act(() => void window.dispatchEvent(new PopStateEvent("popstate")));
    expect(screen.getByRole("heading", { name: /not found/i })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/group/other");
  });

  it("hand a task's id to the Tasks screen, and call an unknown task not found", () => {
    const { model } = openAt("/task/tsk_1");
    show(model);
    expect(screen.getByTestId("tasks-stub")).toHaveAttribute("data-open-task", "tsk_1");
    frame(model, { type: "task.list.ok", seq: 2, tasks: [{ id: "tsk_1", title: "Write it" }] });
    expect(screen.getByTestId("tasks-stub")).toHaveAttribute("data-open-task", "tsk_1");

    act(() => window.history.pushState({}, "", "/task/ghost"));
    act(() => void window.dispatchEvent(new PopStateEvent("popstate")));
    expect(screen.queryByTestId("tasks-stub")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /not found/i })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/task/ghost");
  });

  it("open Settings at the section the address names", () => {
    const { model } = openAt("/settings/appearance");
    show(model);
    frame(model, rosterFrame);
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Appearance" })).toBeInTheDocument();
  });

  it("call an unknown Settings section not found, without opening Settings", () => {
    const { model } = openAt("/settings/bogus");
    show(model);
    expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /not found/i })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/settings/bogus");
  });

  it("do not show Settings over the pairing screen", () => {
    window.history.replaceState({}, "", "/settings/models");
    const model = new AppModel({ makeTransport: idleTransport, healthFetch: async () => health, notifier: silentNotifications, healthPollMs: 0 });
    model.start();
    show(model);
    expect(model.getSnapshot().screen).toBe("pairing");
    expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
  });
});

describe("the address follows the screen", () => {
  it("changes with the open bot, and back and forward return to it", async () => {
    const { model } = openAt("/agent/ea");
    show(model);
    frame(model, rosterFrame);
    act(() => model.selectAgent(roster[1]! as never));
    expect(window.location.pathname).toBe("/agent/scout");
    act(() => model.selectAgent(roster[2]! as never));
    expect(window.location.pathname).toBe("/agent/new_bot");

    act(() => window.history.back());
    await waitFor(() => expect(model.getSnapshot().conversation.agentID).toBe("scout"));
    expect(window.location.pathname).toBe("/agent/scout");
    act(() => window.history.forward());
    await waitFor(() => expect(model.getSnapshot().conversation.agentID).toBe("new_bot"));
  });

  it("puts Settings in the address, changes section in place, and Back closes it", async () => {
    const { model } = openAt("/agent/ea");
    show(model);
    frame(model, rosterFrame);
    act(() => model.openSettings());
    expect(window.location.pathname).toBe("/settings");
    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    expect(window.location.pathname).toBe("/settings/appearance");
    expect(screen.getByRole("heading", { level: 1, name: "Appearance" })).toBeInTheDocument();

    // One history entry for the whole of Settings: Back leaves it.
    act(() => window.history.back());
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument());
    expect(window.location.pathname).toBe("/agent/ea");
  });

  it("returns to the open bot when Settings, opened by a link, is closed", () => {
    const { model } = openAt("/settings/models");
    show(model);
    frame(model, rosterFrame);
    fireEvent.click(screen.getByRole("button", { name: /back to chat/i }));
    expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
    expect(window.location.pathname).toBe("/agent/ea");
  });

  it("puts the task views and the open task in the address", async () => {
    const { model } = openAt("/agent/ea");
    show(model);
    act(() => model.toggleTasks());
    expect(window.location.pathname).toBe("/tasks");
    act(() => model.openTaskRoute("tsk_1"));
    expect(window.location.pathname).toBe("/task/tsk_1");
    // Closing a task opened in the app steps back over its history entry, which settles a tick later.
    act(() => model.openTaskRoute(null));
    await waitFor(() => expect(window.location.pathname).toBe("/tasks"));
  });
});
