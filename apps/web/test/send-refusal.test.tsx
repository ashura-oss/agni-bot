import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SecretStore, type ClientFrame, type FrameTransport, type HealthReport } from "@agni/client";
import { AppModel } from "../src/state/app-model";
import { silentNotifications } from "../src/state/notifications";
import { AppModelProvider } from "../src/state/use-app-model";
import { ComposerView } from "../src/components/ComposerView";

// A send that cannot go out tells the owner once, and a task is only "handed off" when the message went.

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
const rosterFrame = { type: "agents.update", seq: 1, agents: roster, mentions: roster };
const task = {
  id: "tsk_1", title: "Write the report", status: "open", priority: "normal", listID: "lst_inbox",
  dueAt: null, snoozedUntil: null, createdAt: "2026-11-01T09:00:00.000Z", updatedAt: "2026-11-01T09:00:00.000Z",
};

function openAt(path: string, ready = true): { model: AppModel; sent: ClientFrame[] } {
  window.history.replaceState({}, "", path);
  SecretStore.save("test-token");
  const model = new AppModel({ makeTransport: idleTransport, healthFetch: async () => health, notifier: silentNotifications, healthPollMs: 0 });
  model.start();
  const sent: ClientFrame[] = [];
  const inner = model as unknown as { connection: unknown; connectionState: unknown };
  inner.connection = { send: async (item: ClientFrame) => void sent.push(item), retryNow: () => undefined };
  inner.connectionState = ready ? { kind: "ready", lastSeq: 0 } : { kind: "waiting", attempt: 1 };
  return { model, sent };
}
const frame = (model: AppModel, value: unknown) => act(() => (model as unknown as { handleFrame: (value: unknown) => void }).handleFrame(value));

beforeEach(() => { localStorage.clear(); SecretStore.memoryToken = null; });
afterEach(() => {
  cleanup();
  localStorage.clear();
  SecretStore.memoryToken = null;
  window.history.replaceState({}, "", "/");
  vi.restoreAllMocks();
});

describe("send refused because the chat is still loading", () => {
  it("shows one message, the accurate one, and no toast", () => {
    // The address names Scout, the roster has not arrived: the open chat is still the seed bot's.
    const { model } = openAt("/agent/scout");
    render(<AppModelProvider model={model}><ComposerView /></AppModelProvider>);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.keyDown(input, { key: "Enter" });

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/still loading/i);
    expect(alert).not.toHaveTextContent(/not connected/i);
    expect(model.getSnapshot().toast).toBeNull();
    expect(input).toHaveValue("hello");
  });
});

describe("handing a task to a bot", () => {
  it("marks the task handed off after the message went", () => {
    const { model, sent } = openAt("/tasks");
    frame(model, rosterFrame);
    model.handoffTask(task as never, roster[1] as never);
    const types = sent.map((item) => item.type);
    expect(types).toContain("msg.send");
    expect(types).toContain("task.update");
    expect(types.indexOf("msg.send")).toBeLessThan(types.indexOf("task.update"));
    expect(sent.find((item) => item.type === "task.update")).toMatchObject({ progressNote: "Handed off to Scout" });
  });

  it("does not mark the task handed off when the message could not be sent", () => {
    const { model, sent } = openAt("/tasks", false);
    frame(model, rosterFrame);
    model.handoffTask(task as never, roster[1] as never);
    expect(sent.some((item) => item.type === "task.update")).toBe(false);
    expect(sent.some((item) => item.type === "msg.send")).toBe(false);
  });
});
