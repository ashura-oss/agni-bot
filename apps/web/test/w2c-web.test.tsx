import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SecretStore, type ClientFrame, type FrameTransport, type HealthReport, type JobInfo } from "@agni/client";
import { AppModel } from "../src/state/app-model";
import { silentNotifications } from "../src/state/notifications";
import { AppModelProvider } from "../src/state/use-app-model";
import { RootView } from "../src/components/RootView";
import { InspectorView } from "../src/components/InspectorView";
import { SettingsView } from "../src/components/SettingsView";

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

const rules = [
  { id: "rul_1", agentID: "ea", agentName: "Friday", toolName: "bash", target: "git push origin main", createdAt: "2026-11-10T10:00:00.000Z" },
  { id: "rul_2", agentID: "gone", agentName: null, toolName: "write_file", target: "C:/work/notes.md", createdAt: "2026-11-11T10:00:00.000Z" },
];

async function openRules(model: AppModel) {
  act(() => model.openSettings());
  renderWith(model, <SettingsView />);
  fireEvent.click(screen.getByRole("button", { name: "Always allow" }));
}

describe("the Always allow rules (W2-C)", () => {
  it("asks for the list when Settings opens and shows bot, tool, target and date", async () => {
    const { model, sent } = rig();
    await openRules(model);
    await waitFor(() => expect(sent.some((item) => item.type === "approval.rules.list")).toBe(true));

    frame(model, { type: "approval.rules.list.ok", seq: 1, rules });
    expect(screen.getByText("Friday")).toBeInTheDocument();
    expect(screen.getByText("bash")).toBeInTheDocument();
    expect(screen.getByText("git push origin main")).toBeInTheDocument();
    expect(screen.getAllByText(/^Allowed /)).toHaveLength(2);
    // A bot that no longer exists is said so, not shown blank.
    expect(screen.getByText("gone (removed)")).toBeInTheDocument();
  });

  it("revokes one rule through its frame and drops it when the daemon confirms", async () => {
    const { model, sent } = rig();
    await openRules(model);
    frame(model, { type: "approval.rules.list.ok", seq: 1, rules });

    fireEvent.click(screen.getByRole("button", { name: "Revoke bash for Friday" }));
    expect(sent).toContainEqual({ type: "approval.rule.revoke", id: "rul_1" });
    // Nothing disappears on the click itself: the list follows the daemon.
    expect(screen.getByText("git push origin main")).toBeInTheDocument();

    frame(model, { type: "approval.rule.revoke.ok", seq: 2, id: "rul_1" });
    expect(screen.queryByText("git push origin main")).not.toBeInTheDocument();
    expect(screen.getByText("C:/work/notes.md")).toBeInTheDocument();
  });

  it("refreshes the list when a rule was already gone", async () => {
    const { model, sent } = rig();
    await openRules(model);
    frame(model, { type: "approval.rules.list.ok", seq: 1, rules });
    sent.length = 0;
    frame(model, { type: "error", seq: 3, code: "not_found", message: "no rule rul_1" });
    expect(sent).toContainEqual({ type: "approval.rules.list" });
    expect(model.getSnapshot().toast?.title).toBe("Already gone");
  });

  it("says when nothing is always allowed", async () => {
    const { model } = rig();
    await openRules(model);
    frame(model, { type: "approval.rules.list.ok", seq: 1, rules: [] });
    expect(screen.getByText("Nothing is always allowed")).toBeInTheDocument();
  });
});

describe("jobs, from what the daemon says about them (W2-C)", () => {
  function job(partial: Partial<JobInfo> & { id: string; kind: string }): JobInfo {
    return { state: "queued", runAt: "2026-11-17T09:00:00.000Z", enabled: true, attempts: 0, internal: false, ...partial };
  }

  it("hides internal jobs by the daemon's flag and labels a clock recurrence and a one-off", () => {
    const { model } = rig();
    frame(model, {
      type: "job.list.ok",
      seq: 1,
      jobs: [
        job({ id: "j1", kind: "turn", title: "Disguised housekeeping", internal: true }),
        job({ id: "j2", kind: "turn", title: "Morning brief", dailyAt: "09:00", days: ["mon", "tue", "wed", "thu", "fri"] }),
        job({ id: "j3", kind: "turn", title: "Water the plants" }),
      ],
    });
    const { container } = renderWith(model, <InspectorView />);
    expect(container.textContent).not.toContain("Disguised housekeeping");
    expect(screen.getByText(/^Weekdays at 09:00/)).toBeInTheDocument();
    expect(screen.getByText(/^Once · runs /)).toBeInTheDocument();
  });

  it("stands the Run now button down when the daemon says it is already running", () => {
    const { model } = rig();
    frame(model, { type: "job.list.ok", seq: 1, jobs: [job({ id: "j1", kind: "turn", title: "Brief" })] });
    renderWith(model, <InspectorView />);
    const button = screen.getByRole("button", { name: /Run Brief now/ });
    fireEvent.click(button);
    expect(button).toBeDisabled();

    frame(model, { type: "error", seq: 2, code: "already_running", message: "Brief is already running." });
    expect(screen.getByRole("button", { name: /Run Brief now/ })).toBeEnabled();
    expect(model.getSnapshot().toast).toMatchObject({ title: "Already running", body: "Brief is already running." });
  });
});

describe("new bots (W2-C)", () => {
  it("are not told to call rename_agent, which they do not have", () => {
    const { model, sent } = rig();
    model.startNewAgent();
    const create = sent.find((item) => item.type === "agent.create");
    expect(create && "prompt" in create ? create.prompt : "").not.toMatch(/rename_agent/);
    expect(create && "prompt" in create ? create.prompt : "").toMatch(/profile/);
  });
});

describe("a message that is too long (W2-C)", () => {
  it("is taken back and its text returns to the composer with the reason", () => {
    const { model } = rig();
    renderWith(model, <RootView />);
    const text = "long ".repeat(50);
    act(() => void model.send(text));
    expect(model.getSnapshot().conversation.messages.some((message) => message.isLocalEcho)).toBe(true);

    frame(model, { type: "error", seq: 2, code: "bad_frame", message: "That message is too long (100,001 characters). The limit is 100,000; split it or attach it as a file." });
    expect(model.getSnapshot().conversation.messages.some((message) => message.isLocalEcho)).toBe(false);
    const box = screen.getByPlaceholderText(/^Message /) as HTMLTextAreaElement;
    expect(box.value).toBe(text);
    expect(screen.getByText(/limit is 100,000/)).toBeInTheDocument();
  });

  it("does not overwrite what the owner has typed since", () => {
    const { model } = rig();
    renderWith(model, <RootView />);
    act(() => void model.send("first"));
    fireEvent.change(screen.getByPlaceholderText(/^Message /), { target: { value: "something new" } });
    frame(model, { type: "error", seq: 2, code: "bad_frame", message: "That message is too long (200,000 characters). The limit is 100,000." });
    expect((screen.getByPlaceholderText(/^Message /) as HTMLTextAreaElement).value).toBe("something new");
  });

  it("leaves other bad_frame errors alone", () => {
    const { model } = rig();
    renderWith(model, <RootView />);
    act(() => void model.send("hello"));
    frame(model, { type: "error", seq: 2, code: "bad_frame", message: "not json" });
    expect(model.getSnapshot().conversation.messages.some((message) => message.isLocalEcho)).toBe(true);
    expect((screen.getByPlaceholderText(/^Message /) as HTMLTextAreaElement).value).toBe("");
  });
});

describe("a card the daemon no longer knows (W2-C)", () => {
  it("disappears when answering it is refused as unknown_request", () => {
    const { model } = rig();
    frame(model, { type: "approval.request", seq: 1, requestID: "apr_x", action: "shell: ls", preview: "", buttons: ["once", "reject"] });
    renderWith(model, <RootView />);
    fireEvent.click(screen.getByRole("button", { name: /allow once/i }));
    // Answered locally the moment the send succeeds; the daemon then says it never heard of it.
    frame(model, { type: "error", seq: 2, code: "unknown_request", message: "That request expired or was already answered." });
    expect(model.getSnapshot().conversation.approvals).toHaveLength(0);
    expect(model.getSnapshot().toast?.title).toBe("Request expired");
  });
});
