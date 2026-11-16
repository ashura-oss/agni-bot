import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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
  return { open: () => new Promise<void>(() => undefined), send: async () => undefined, receive: () => new Promise<string>(() => undefined), close: async () => undefined };
}

function rig() {
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

function renderWith(model: AppModel, view: React.ReactElement) {
  return render(<AppModelProvider model={model}>{view}</AppModelProvider>);
}

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

describe("a reload mid-turn: the daemon names the running turn (int11)", () => {
  it("shows Writing and Stop as soon as the history arrives, and takes the tokens that follow", () => {
    const { model } = rig();
    frame(model, { type: "conversation.ok", seq: 1, conversationID: "cnv_1", agentID: "ea", sessionID: "thr_1" });
    frame(model, {
      type: "conversation.history.ok", seq: 2, conversationID: "cnv_1",
      messages: [{ id: "m1", role: "user", text: "a long task", createdAt: "2026-11-16T10:00:00.000Z", turnID: "trn_1", sessionID: "thr_1" }],
      runningTurn: { turnID: "trn_1", threadID: "thr_1", agentID: "ea" },
    });
    renderWith(model, <RootView />);
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(screen.getByText("Writing…")).toBeInTheDocument();

    frame(model, { type: "token", seq: 3, turnID: "trn_1", threadID: "thr_1", delta: "streaming now" });
    frame(model, { type: "agent.presence", seq: 4, agentId: "ea", state: "working" });
    expect(document.body.textContent).toContain("streaming now");
  });

  it("changes nothing when the history names no running turn", () => {
    const { model } = rig();
    frame(model, { type: "conversation.ok", seq: 1, conversationID: "cnv_1", agentID: "ea", sessionID: "thr_1" });
    frame(model, { type: "conversation.history.ok", seq: 2, conversationID: "cnv_1", messages: [] });
    expect(model.getSnapshot().conversation.isStreaming).toBe(false);
  });
});

describe("a routine's result reaches the open chat without a switch (int11)", () => {
  it("renders a msg.new for the bound channel even when it is not the default one", () => {
    const { model } = rig();
    frame(model, { type: "conversation.ok", seq: 1, conversationID: "cnv_1", agentID: "ea", sessionID: "thr_1" });
    frame(model, { type: "bind.direct.ok", seq: 2, agentID: "ea", conversationID: "cnv_1", sessionID: "thr_1", channelID: "dm:ea_room" });
    frame(model, { type: "msg.new", seq: 3, id: "chm_1", channelId: "dm:ea_room", fromType: "agent", fromId: "ea", senderName: "Friday", text: "Routine result", internal: false, createdAt: "2026-11-16T10:00:00.000Z" });
    expect(model.getSnapshot().conversation.messages.some((message) => message.text === "Routine result")).toBe(true);
  });

  it("renders a msg.new on the agent's own channel with no turn frames around it", () => {
    const { model } = rig();
    frame(model, { type: "conversation.ok", seq: 1, conversationID: "cnv_1", agentID: "ea", sessionID: "thr_1" });
    frame(model, { type: "msg.new", seq: 2, id: "chm_2", channelId: "main", fromType: "agent", fromId: "ea", senderName: "Friday", text: "Daily summary", internal: false, createdAt: "2026-11-16T10:00:00.000Z" });
    renderWith(model, <RootView />);
    expect(screen.getByText("Daily summary")).toBeInTheDocument();
  });

  it("reloads history when a routine turn ends with nothing streamed, so its saved result shows", async () => {
    const { model, sent } = rig();
    frame(model, { type: "conversation.ok", seq: 1, conversationID: "cnv_1", agentID: "ea", sessionID: "thr_active" });
    frame(model, { type: "turn.start", seq: 2, turnID: "trn_r", threadID: "thr_routine", agentID: "ea", conversationID: "cnv_1" });
    sent.length = 0;
    frame(model, { type: "turn.end", seq: 3, turnID: "trn_r", threadID: "thr_routine", stopReason: "end", conversationID: "cnv_1" });
    await waitFor(() => expect(sent.some((item) => item.type === "conversation.history")).toBe(true));
  });
});

describe("a conversation with no session block yet does not loop (int11)", () => {
  it("asks for conversation.open once, however many history answers arrive", async () => {
    const { model, sent } = rig();
    frame(model, { type: "conversation.ok", seq: 1, conversationID: "cnv_1", agentID: "ea", sessionID: "" });
    sent.length = 0;
    for (let n = 0; n < 5; n += 1) {
      frame(model, { type: "conversation.history.ok", seq: 10 + n, conversationID: "cnv_1", messages: [] });
      frame(model, { type: "conversation.ok", seq: 20 + n, conversationID: "cnv_1", agentID: "ea", sessionID: "" });
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sent.filter((item) => item.type === "conversation.open")).toHaveLength(1);
    // And the history is not re-requested by every conversation.ok either.
    expect(sent.filter((item) => item.type === "conversation.history").length).toBeLessThanOrEqual(1);
  });
});
