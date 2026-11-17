/**
 * S2-6: the approval card in the app. A long card cannot be allowed until its full text was opened,
 * a refused Allow never loses the card, and what the server sends is what the card shows.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { SecretStore, type ClientFrame, type FrameTransport, type HealthReport } from "@agni/client";
import { AppModel } from "../src/state/app-model";
import { silentNotifications } from "../src/state/notifications";
import { AppModelProvider } from "../src/state/use-app-model";
import { RootView } from "../src/components/RootView";

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
  inner.connection = { send: async (value: ClientFrame) => void sent.push(value), retryNow: () => undefined };
  inner.connectionState = { kind: "ready", lastSeq: 0 };
  return { model, sent };
}

function frame(model: AppModel, value: unknown): void {
  act(() => (model as unknown as { handleFrame: (value: unknown) => void }).handleFrame(value));
}

function renderWith(model: AppModel) {
  return render(
    <AppModelProvider model={model}>
      <RootView />
    </AppModelProvider>,
  );
}

const roster = [{ id: "ea", name: "Friday", tools: [] }];
const LONG = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join("\n");

function longCard(extra: Record<string, unknown> = {}) {
  return {
    type: "approval.request",
    seq: 5,
    requestID: "apr_long",
    action: "run a command",
    preview: LONG,
    buttons: ["once", "reject"],
    truncated: true,
    ...extra,
  };
}

function settle(): Promise<void> {
  return act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  localStorage.clear();
  SecretStore.memoryToken = null;
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  SecretStore.memoryToken = null;
});

describe("model: a long card cannot be allowed before it was opened", () => {
  it("sends nothing for Allow on a locked card, and keeps the card with a line saying why", async () => {
    const { model, sent } = rig();
    frame(model, longCard());
    const card = model.getSnapshot().conversation.approvals[0]!;
    act(() => model.answer(card, "once"));
    await settle();
    expect(sent.filter((item) => item.type === "approve.reply")).toHaveLength(0);
    const row = model.getSnapshot().conversation.openApprovals[0]!;
    expect(row.decision).toBeNull();
    expect(row.notice).toMatch(/Read the full text/);
  });

  it("lets Deny through on a locked card", async () => {
    const { model, sent } = rig();
    frame(model, longCard());
    act(() => model.answer(model.getSnapshot().conversation.approvals[0]!, "reject"));
    await settle();
    expect(sent.filter((item) => item.type === "approve.reply")).toEqual([{ type: "approve.reply", requestID: "apr_long", decision: "reject" }]);
  });

  it("asks for the full text, and Allow goes through once it came", async () => {
    const { model, sent } = rig();
    frame(model, longCard());
    act(() => model.openApprovalFull(model.getSnapshot().conversation.approvals[0]!));
    await settle();
    expect(sent).toContainEqual({ type: "approval.full", requestID: "apr_long" });
    expect(model.getSnapshot().conversation.approvals[0]!.full?.state).toBe("loading");

    frame(model, { type: "approval.full.ok", seq: 6, requestID: "apr_long", text: LONG });
    expect(model.getSnapshot().conversation.approvals[0]!.full?.state).toBe("open");

    act(() => model.answer(model.getSnapshot().conversation.approvals[0]!, "once"));
    await settle();
    expect(sent.filter((item) => item.type === "approve.reply")).toEqual([{ type: "approve.reply", requestID: "apr_long", decision: "once" }]);
  });

  it("a card that is not truncated is never locked", async () => {
    const { model, sent } = rig();
    frame(model, { type: "approval.request", seq: 5, requestID: "apr_short", action: "ls", preview: "ls", buttons: ["once", "reject"] });
    act(() => model.answer(model.getSnapshot().conversation.approvals[0]!, "once"));
    await settle();
    expect(sent.filter((item) => item.type === "approve.reply")).toHaveLength(1);
  });

  it("an answer that cannot be sent ends the loading: Allow stays locked, Try again is possible", async () => {
    const { model } = rig();
    const inner = model as unknown as { connection: { send: () => Promise<void> } };
    inner.connection.send = async () => {
      throw new Error("closed");
    };
    frame(model, longCard());
    act(() => model.openApprovalFull(model.getSnapshot().conversation.approvals[0]!));
    await settle();
    const row = model.getSnapshot().conversation.approvals[0]!;
    expect(row.full?.state).toBe("failed");
    expect(row.notice).toMatch(/Could not load the full text/);
  });

  it("not_found while the text is loading means the card is gone: failed, not a toast about rules", async () => {
    const { model } = rig();
    frame(model, longCard());
    act(() => model.openApprovalFull(model.getSnapshot().conversation.approvals[0]!));
    await settle();
    frame(model, { type: "error", seq: 7, code: "not_found", message: "no waiting card apr_long with a full text to show" });
    expect(model.getSnapshot().conversation.approvals[0]!.full?.state).toBe("failed");
    expect(model.getSnapshot().toast?.title).not.toBe("Already gone");
  });

  it("a lost connection ends a load that was on its way", async () => {
    const { model } = rig();
    frame(model, longCard());
    act(() => model.openApprovalFull(model.getSnapshot().conversation.approvals[0]!));
    await settle();
    const inner = model as unknown as { handle: (event: unknown) => void };
    act(() => inner.handle({ type: "state", state: { kind: "waiting", attempt: 1, seconds: 1, reason: "gone" } }));
    expect(model.getSnapshot().conversation.approvals[0]!.full?.state).toBe("failed");
  });
});

describe("model: a refused Allow never loses the card (approval_not_opened)", () => {
  it("brings the card back, locked again, and says to open the text", async () => {
    const { model } = rig();
    frame(model, longCard());
    act(() => model.openApprovalFull(model.getSnapshot().conversation.approvals[0]!));
    await settle();
    frame(model, { type: "approval.full.ok", seq: 6, requestID: "apr_long", text: LONG });
    act(() => model.answer(model.getSnapshot().conversation.approvals[0]!, "once"));
    await settle();
    // The card is hidden while the answer is on its way.
    expect(model.getSnapshot().conversation.openApprovals).toHaveLength(0);

    frame(model, { type: "error", seq: 8, code: "approval_not_opened", message: "Open its full text (approval.full) before you allow it. The card is still waiting." });
    const row = model.getSnapshot().conversation.openApprovals[0]!;
    expect(row).toBeDefined();
    expect(row.decision).toBeNull();
    expect(row.full?.state).toBe("idle");
    expect(row.notice).toMatch(/open the full text/i);
    // The refusal is about the card, not a failure of the turn running beside it.
    expect(model.getSnapshot().conversation.notices.filter((notice) => notice.kind === "failure")).toHaveLength(0);
  });

  it("a card the daemon closed in the meantime stays gone", async () => {
    const { model } = rig();
    frame(model, longCard());
    act(() => model.openApprovalFull(model.getSnapshot().conversation.approvals[0]!));
    await settle();
    frame(model, { type: "approval.full.ok", seq: 6, requestID: "apr_long", text: LONG });
    act(() => model.answer(model.getSnapshot().conversation.approvals[0]!, "once"));
    await settle();
    frame(model, { type: "approval.closed", seq: 8, requestID: "apr_long", kind: "approval", reason: "decided" });
    frame(model, { type: "error", seq: 9, code: "approval_not_opened", message: "late" });
    expect(model.getSnapshot().conversation.openApprovals).toHaveLength(0);
  });

  it("an audit-log refusal (internal) also gives the card back, still unlocked, with the daemon's words", async () => {
    const { model } = rig();
    frame(model, { type: "approval.request", seq: 5, requestID: "apr_short", action: "ls", preview: "ls", buttons: ["once", "reject"] });
    act(() => model.answer(model.getSnapshot().conversation.approvals[0]!, "once"));
    await settle();
    expect(model.getSnapshot().conversation.openApprovals).toHaveLength(0);
    frame(model, { type: "error", seq: 8, code: "internal", message: "Your answer could not be written to the audit log, so it was not applied. The card is still waiting." });
    const row = model.getSnapshot().conversation.openApprovals[0]!;
    expect(row.notice).toMatch(/audit log/);
    expect(row.decision).toBeNull();
  });
});

describe("the card on screen", () => {
  const request = longCard({ requestID: "apr_ui" });

  it("shows the whole multi-line preview in a scrollable box, not cut", () => {
    const { model } = rig();
    frame(model, { type: "agents.update", seq: 1, agents: roster, mentions: roster });
    frame(model, request);
    renderWith(model);
    const box = screen.getByRole("region", { name: /what .* wants to run|full preview|preview/i });
    expect(box.textContent).toContain("line 1");
    expect(box.textContent).toContain("line 60");
    expect(box).toHaveAttribute("tabindex", "0");
  });

  it("Allow once is aria-disabled (still focusable) until the full text was opened", () => {
    const { model } = rig();
    frame(model, request);
    renderWith(model);
    const allow = screen.getByRole("button", { name: /allow once/i });
    expect(allow).toHaveAttribute("aria-disabled", "true");
    expect(allow).not.toBeDisabled();
    expect(allow.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(allow.getAttribute("aria-describedby")!)?.textContent).toMatch(/Read the full text before allowing/);
  });

  it("clicking a locked Allow sends nothing and moves focus to View full text", async () => {
    const { model, sent } = rig();
    frame(model, request);
    renderWith(model);
    fireEvent.click(screen.getByRole("button", { name: /allow once/i }));
    await settle();
    expect(sent.filter((item) => item.type === "approve.reply")).toHaveLength(0);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /view full text/i }));
  });

  it("View full text opens a dialog, asks the server, shows the text, and then Allow once works from the card", async () => {
    const { model, sent } = rig();
    frame(model, request);
    renderWith(model);
    fireEvent.click(screen.getByRole("button", { name: /view full text/i }));
    await settle();
    expect(sent).toContainEqual({ type: "approval.full", requestID: "apr_ui" });
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/Loading the full text/)).toBeInTheDocument();

    frame(model, { type: "approval.full.ok", seq: 6, requestID: "apr_ui", text: `FULL BODY\n${LONG}` });
    expect(within(screen.getByRole("dialog")).getByText(/FULL BODY/)).toBeInTheDocument();

    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^close/i }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /view full text again/i })).toBeInTheDocument();
    const allow = screen.getByRole("button", { name: /allow once/i });
    expect(allow).not.toHaveAttribute("aria-disabled", "true");
    fireEvent.click(allow);
    await settle();
    expect(sent.filter((item) => item.type === "approve.reply")).toEqual([{ type: "approve.reply", requestID: "apr_ui", decision: "once" }]);
  });

  it("the dialog closes on Escape and gives focus back to View full text", async () => {
    const { model } = rig();
    frame(model, request);
    renderWith(model);
    const open = screen.getByRole("button", { name: /view full text/i });
    open.focus();
    fireEvent.click(open);
    await settle();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /view full text/i }));
  });

  it("a failed load says so, offers Try again, and Allow stays locked while Deny works", async () => {
    const { model, sent } = rig();
    frame(model, request);
    renderWith(model);
    fireEvent.click(screen.getByRole("button", { name: /view full text/i }));
    await settle();
    frame(model, { type: "error", seq: 7, code: "not_found", message: "no waiting card" });
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/Could not load the full text/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /try again/i })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /allow once/i })).toHaveAttribute("aria-disabled", "true");
    sent.length = 0;
    fireEvent.click(within(dialog).getByRole("button", { name: /deny/i }));
    await settle();
    expect(sent).toEqual([{ type: "approve.reply", requestID: "apr_ui", decision: "reject" }]);
  });

  it("a refused Allow puts the card back on screen with the line telling the owner to open it", async () => {
    const { model } = rig();
    frame(model, request);
    renderWith(model);
    fireEvent.click(screen.getByRole("button", { name: /view full text/i }));
    await settle();
    frame(model, { type: "approval.full.ok", seq: 6, requestID: "apr_ui", text: LONG });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^close/i }));
    fireEvent.click(screen.getByRole("button", { name: /allow once/i }));
    await settle();
    expect(screen.queryByRole("button", { name: /allow once/i })).not.toBeInTheDocument();

    frame(model, { type: "error", seq: 8, code: "approval_not_opened", message: "x" });
    expect(screen.getByRole("button", { name: /allow once/i })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("alert").textContent).toMatch(/open the full text/i);
  });

  it("a standing-rule card shows what the server sent: no Always button when it sent none", () => {
    const { model } = rig();
    frame(model, {
      type: "approval.request", seq: 5, requestID: "apr_rule", action: "create a repeating job",
      preview: "This job would run again by itself.\n\"Always allow\" is off: work that starts again on its own is always put to you.\n\nevery day at 9",
      buttons: ["once", "reject"],
    });
    renderWith(model);
    expect(screen.queryByRole("button", { name: /always allow/i })).not.toBeInTheDocument();
    expect(screen.getByText(/work that starts again on its own/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /allow once/i })).toBeInTheDocument();
  });

  it("an Always button appears when the server sent one", () => {
    const { model } = rig();
    frame(model, { type: "approval.request", seq: 5, requestID: "apr_a", action: "x", preview: "x", buttons: ["once", "always", "reject"] });
    renderWith(model);
    expect(screen.getByRole("button", { name: /always allow/i })).toBeInTheDocument();
  });

  it("shows how long the card has left, in words", () => {
    const { model } = rig();
    frame(model, { type: "approval.request", seq: 5, requestID: "apr_t", action: "x", preview: "x", buttons: ["once", "reject"], expiresAt: new Date(Date.now() + 9 * 60_000 - 5_000).toISOString() });
    renderWith(model);
    expect(screen.getByText("Expires in 9 min")).toBeInTheDocument();
  });

  it("a card already past its time shows Expired and no buttons", () => {
    const { model } = rig();
    frame(model, { type: "approval.request", seq: 5, requestID: "apr_e", action: "x", preview: "x", buttons: ["once", "reject"], expiresAt: new Date(Date.now() - 1000).toISOString() });
    renderWith(model);
    expect(screen.getByText(/Expired\. Not run\./)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /allow once/i })).not.toBeInTheDocument();
  });
});
