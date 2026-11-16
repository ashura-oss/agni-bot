import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { SecretStore, type ClientFrame, type ConnectionEvent, type FrameTransport, type HealthReport } from "@agni/client";
import { AppModel } from "../src/state/app-model";
import { silentNotifications } from "../src/state/notifications";
import { AppModelProvider } from "../src/state/use-app-model";
import { RootView } from "../src/components/RootView";

// A browser that was away longer than the daemon's replay window: the daemon answers `resync_gap`,
// and the roster only arrives after it. Until it does the address cannot be resolved.

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
const rosterFrame = { type: "agents.update", seq: 91, agents: roster, mentions: roster };

function openAt(path: string): { model: AppModel; sent: ClientFrame[] } {
  window.history.replaceState({}, "", path);
  SecretStore.save("test-token");
  const model = new AppModel({ makeTransport: idleTransport, healthFetch: async () => health, notifier: silentNotifications, healthPollMs: 0 });
  model.start();
  const sent: ClientFrame[] = [];
  const inner = model as unknown as { connection: unknown; connectionState: unknown };
  inner.connection = { send: async (item: ClientFrame) => void sent.push(item), retryNow: () => undefined };
  inner.connectionState = { kind: "ready", lastSeq: 0 };
  return { model, sent };
}

const inner = (model: AppModel) => model as unknown as { handleFrame: (value: unknown) => void; handle: (event: ConnectionEvent) => void };
const frame = (model: AppModel, value: unknown) => act(() => inner(model).handleFrame(value));
const event = (model: AppModel, value: ConnectionEvent) => act(() => inner(model).handle(value));
const show = (model: AppModel) => render(<AppModelProvider model={model}><RootView /></AppModelProvider>);

beforeEach(() => { localStorage.clear(); SecretStore.memoryToken = null; });
afterEach(() => {
  cleanup();
  localStorage.clear();
  SecretStore.memoryToken = null;
  window.history.replaceState({}, "", "/");
  vi.restoreAllMocks();
});

describe("a stale session (resync_gap)", () => {
  it("shows loading, never the default bot's thread, until the roster has arrived", () => {
    const { model } = openAt("/agent/scout");
    show(model);
    expect(screen.getByRole("status", { name: /loading/i })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /message/i })).not.toBeInTheDocument();
    frame(model, rosterFrame);
    expect(screen.queryByRole("status", { name: /loading/i })).not.toBeInTheDocument();
    expect(model.getSnapshot().conversation.agentID).toBe("scout");
    expect(screen.getByRole("textbox", { name: /message scout/i })).toBeInTheDocument();
    expect(document.title).toBe("Scout");
  });

  it("forgets the roster when the daemon cannot replay, and waits for the fresh one", () => {
    const { model } = openAt("/agent/scout");
    show(model);
    frame(model, rosterFrame);
    expect(screen.queryByRole("status", { name: /loading/i })).not.toBeInTheDocument();

    event(model, { type: "durableReloadRequired", restarted: false });
    frame(model, { type: "error", seq: 95, code: "resync_gap", message: "cannot replay from 3" });
    expect(screen.getByRole("status", { name: /loading/i })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /message/i })).not.toBeInTheDocument();

    frame(model, { ...rosterFrame, seq: 96 });
    expect(screen.queryByRole("status", { name: /loading/i })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /message scout/i })).toBeInTheDocument();
  });

  it("calls an unknown bot not found once the roster is known, with no default thread", () => {
    const { model } = openAt("/agent/nobody");
    show(model);
    expect(screen.queryByRole("textbox", { name: /message/i })).not.toBeInTheDocument();
    frame(model, rosterFrame);
    expect(screen.getByRole("heading", { name: /bot not found/i })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /message/i })).not.toBeInTheDocument();
    expect(document.title).toMatch(/not found/i);
    expect(window.location.pathname).toBe("/agent/nobody");
  });

  it("never sends to a bot other than the one in the address", () => {
    const { model, sent } = openAt("/agent/scout");
    // The roster has not arrived: the conversation is still the seed bot's, the address says Scout.
    expect(model.send("hello")).toBe(false);
    expect(sent.some((item) => item.type === "msg.send")).toBe(false);
    frame(model, rosterFrame);
    expect(model.send("hello")).toBe(true);
    const out = sent.filter((item) => item.type === "msg.send");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ toAgentId: "scout", channelId: "dm:scout" });
  });
});
