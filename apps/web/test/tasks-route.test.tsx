import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SecretStore, type ClientFrame, type FrameTransport, type HealthReport } from "@agni/client";
import { AppModel } from "../src/state/app-model";
import { silentNotifications } from "../src/state/notifications";
import { AppModelProvider } from "../src/state/use-app-model";
import { RootView } from "../src/components/RootView";

// The Tasks screen and the address: `/task/<id>` opens one task, closing it goes back to `/tasks`,
// and Back and Forward move between the two. Everything here runs the real RootView and AppModel.

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

function openAt(path: string): { model: AppModel; sent: ClientFrame[] } {
  window.history.replaceState({}, "", path);
  SecretStore.save("test-token");
  const model = new AppModel({ makeTransport: idleTransport, healthFetch: async () => health, notifier: silentNotifications, healthPollMs: 0 });
  model.start();
  const sent: ClientFrame[] = [];
  const inner = model as unknown as { connection: unknown; connectionState: unknown };
  inner.connection = { send: async (frame: ClientFrame) => void sent.push(frame), retryNow: () => undefined };
  inner.connectionState = { kind: "ready", lastSeq: 0 };
  render(<AppModelProvider model={model}><RootView /></AppModelProvider>);
  return { model, sent };
}

function frame(model: AppModel, value: unknown): void {
  act(() => (model as unknown as { handleFrame: (value: unknown) => void }).handleFrame(value));
}

const rosterFrame = { type: "agents.update", seq: 1, agents: roster, mentions: roster };
const listFrame = (...tasks: ReturnType<typeof taskRow>[]) => ({ type: "task.list.ok", seq: 2, tasks, lists: [] });
const sheet = (title: string) => screen.queryByRole("region", { name: `Details for ${title}` });

beforeEach(() => {
  localStorage.clear();
  SecretStore.memoryToken = null;
  // The Tasks screen refreshes on a timer; nothing here needs it.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
  SecretStore.memoryToken = null;
  window.history.replaceState({}, "", "/");
  vi.restoreAllMocks();
});

describe("Tasks screen: open task from the address", () => {
  it("opens the detail of the task the address names, once the list has it", () => {
    const { model } = openAt("/task/tsk_1");
    frame(model, rosterFrame);
    expect(sheet("Write the report")).not.toBeInTheDocument();
    frame(model, listFrame(taskRow("tsk_1", "Write the report"), taskRow("tsk_2", "Other")));
    expect(sheet("Write the report")).toBeInTheDocument();
    expect(sheet("Other")).not.toBeInTheDocument();
    expect(window.location.pathname).toBe("/task/tsk_1");
  });

  it("shows the not-found page for a task that does not exist, and no sheet", () => {
    const { model } = openAt("/task/ghost");
    frame(model, rosterFrame);
    frame(model, listFrame(taskRow("tsk_1", "Write the report")));
    expect(screen.getByRole("heading", { name: "Task not found" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /^Details for/ })).not.toBeInTheDocument();
    expect(window.location.pathname).toBe("/task/ghost");
  });

  it("puts /task/<id> in the address when a detail opens and /tasks back when it closes", () => {
    const { model } = openAt("/tasks");
    frame(model, rosterFrame);
    frame(model, listFrame(taskRow("tsk_1", "Write the report")));
    const route = vi.spyOn(model, "openTaskRoute");
    fireEvent.click(screen.getByRole("button", { name: "Write the report" }));
    expect(route).toHaveBeenLastCalledWith("tsk_1");
    expect(window.location.pathname).toBe("/task/tsk_1");
    expect(sheet("Write the report")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close details" }));
    expect(route).toHaveBeenLastCalledWith(null);
    expect(window.location.pathname).toBe("/tasks");
    expect(sheet("Write the report")).not.toBeInTheDocument();
  });

  it("closes the detail and goes back to /tasks when Escape is pressed in it", () => {
    const { model } = openAt("/task/tsk_1");
    frame(model, rosterFrame);
    frame(model, listFrame(taskRow("tsk_1", "Write the report")));
    fireEvent.keyDown(screen.getByDisplayValue("Write the report"), { key: "Escape" });
    expect(sheet("Write the report")).not.toBeInTheDocument();
    expect(window.location.pathname).toBe("/tasks");
    // Still on the Tasks screen: Escape closed the sheet, not the screen.
    expect(screen.getByRole("heading", { level: 1, name: "Today" })).toBeInTheDocument();
  });

  it("follows Back and Forward: Back closes the task, Forward opens it again", async () => {
    const { model } = openAt("/tasks");
    frame(model, rosterFrame);
    frame(model, listFrame(taskRow("tsk_1", "Write the report")));
    fireEvent.click(screen.getByRole("button", { name: "Write the report" }));
    expect(sheet("Write the report")).toBeInTheDocument();

    act(() => window.history.back());
    await waitFor(() => expect(window.location.pathname).toBe("/tasks"));
    await waitFor(() => expect(sheet("Write the report")).not.toBeInTheDocument());

    act(() => window.history.forward());
    await waitFor(() => expect(window.location.pathname).toBe("/task/tsk_1"));
    await waitFor(() => expect(sheet("Write the report")).toBeInTheDocument());
  });

  it("opens the task again after it was closed, even though the address names the same task", () => {
    const { model } = openAt("/task/tsk_1");
    frame(model, rosterFrame);
    frame(model, listFrame(taskRow("tsk_1", "Write the report")));
    fireEvent.click(screen.getByRole("button", { name: "Close details" }));
    // A task list refresh (every few seconds) must not reopen what the owner closed.
    frame(model, listFrame(taskRow("tsk_1", "Write the report")));
    expect(sheet("Write the report")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Write the report" }));
    expect(sheet("Write the report")).toBeInTheDocument();
  });

  it("does not pull the owner back to Tasks after handing a task to a bot", () => {
    const { model } = openAt("/task/tsk_1");
    frame(model, rosterFrame);
    frame(model, listFrame(taskRow("tsk_1", "Write the report")));
    fireEvent.click(screen.getByRole("button", { name: "Hand off to AI" }));
    expect(window.location.pathname).toBe("/agent/ea");
    expect(sheet("Write the report")).not.toBeInTheDocument();
  });
});
