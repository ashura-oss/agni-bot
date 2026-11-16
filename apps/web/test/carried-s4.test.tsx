import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { SecretStore, type ClientFrame, type FrameTransport, type HealthReport } from "@agni/client";
import { AppModel } from "../src/state/app-model";
import { silentNotifications } from "../src/state/notifications";
import { AppModelProvider } from "../src/state/use-app-model";
import { RootView } from "../src/components/RootView";
import { insertStoppedTurns, loadStops, rememberStop } from "../src/state/stops";

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

function rig(): { model: AppModel; sent: ClientFrame[] } {
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

const roster = [
  { id: "ea", name: "Friday", tools: [] },
  { id: "scout", name: "Scout", tools: [] },
];

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

describe("a stop before any text (S4-08)", () => {
  const user = (turnID: string, id = `msg_${turnID}`) => ({ id, role: "user", text: "do the thing", createdAt: "2026-11-16T10:00:00.000Z", turnID });
  const reply = (turnID: string) => ({ id: `asst_${turnID}`, role: "assistant", text: "Done.", createdAt: "2026-11-16T10:00:05.000Z", turnID, stopReason: "end" });

  function reloadWith(messages: unknown[]): AppModel {
    const { model } = rig();
    frame(model, { type: "agents.update", seq: 1, agents: roster, mentions: roster });
    frame(model, { type: "conversation.ok", seq: 2, conversationID: "cnv_1", agentID: "ea", sessionID: "thr_1" });
    frame(model, { type: "conversation.history.ok", seq: 3, conversationID: "cnv_1", messages });
    return model;
  }

  it("puts the marker back after reload, under the message that was stopped", () => {
    rememberStop("trn_1", "cancelled");
    const model = reloadWith([user("trn_1"), user("trn_2"), reply("trn_2")]);
    const messages = model.getSnapshot().conversation.messages;
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(messages[1]).toMatchObject({ turnID: "trn_1", text: "", state: { kind: "stopped", reason: "cancelled" } });
    expect(messages[3]?.state).toEqual({ kind: "complete" });
  });

  it("draws it as 'No reply' in the transcript", () => {
    rememberStop("trn_1", "cancelled");
    const model = reloadWith([user("trn_1")]);
    render(<AppModelProvider model={model}><RootView /></AppModelProvider>);
    expect(screen.getByText(/No reply — /)).toBeInTheDocument();
  });

  it("adds nothing for a turn that has an answer, or that this chat never held", () => {
    rememberStop("trn_1", "cancelled");
    rememberStop("trn_elsewhere", "cancelled");
    const model = reloadWith([user("trn_1"), reply("trn_1")]);
    const messages = model.getSnapshot().conversation.messages;
    expect(messages).toHaveLength(2);
    expect(messages[1]?.text).toBe("Done.");
  });

  it("keeps one marker however many times the history is reloaded", () => {
    rememberStop("trn_1", "cancelled");
    const model = reloadWith([user("trn_1")]);
    frame(model, { type: "conversation.history.ok", seq: 4, conversationID: "cnv_1", messages: [user("trn_1")] });
    expect(model.getSnapshot().conversation.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
  });

  it("is a pure insert: the stops it reads are not changed", () => {
    rememberStop("trn_1", "cancelled");
    const before = loadStops();
    insertStoppedTurns([], before);
    expect(loadStops()).toEqual(before);
  });
});

describe("a bot's channel (S4-08)", () => {
  it("is forgotten when another bot is picked, so a message goes to that bot", () => {
    const { model, sent } = rig();
    frame(model, { type: "agents.update", seq: 1, agents: roster, mentions: roster });
    // The daemon bound this chat to a channel of the first bot.
    (model as unknown as { boundChannelID: string | null }).boundChannelID = "dm:ea-old";
    act(() => model.selectAgent(roster[1]! as never));
    expect(model.send("hello")).toBe(true);
    const message = sent.find((item) => item.type === "msg.send") as { channelId?: string } | undefined;
    expect(message?.channelId).toBe("dm:scout");
  });

  it("is kept when the same bot is picked again", () => {
    const { model } = rig();
    frame(model, { type: "agents.update", seq: 1, agents: roster, mentions: roster });
    frame(model, { type: "conversation.ok", seq: 2, conversationID: "cnv_1", agentID: "ea", sessionID: "thr_1" });
    (model as unknown as { boundChannelID: string | null }).boundChannelID = "main";
    act(() => model.selectAgent(roster[0]! as never));
    expect((model as unknown as { boundChannelID: string | null }).boundChannelID).toBe("main");
  });
});
