import { describe, expect, test } from "bun:test";
import { AgniClient } from "../client";

/** The real client with its socket replaced by a list of what it would send. */
class RecordingClient extends AgniClient {
  sent: any[] = [];
  override send(frame: unknown): void {
    this.sent.push(frame);
  }
}

const frame = (f: Record<string, unknown>): string => JSON.stringify({ seq: 1, ...f });

describe("eval protocol client", () => {
  test("an allowed card that is not truncated is answered at once", () => {
    const c = new RecordingClient();
    c.decideApproval = () => "once";
    c.handleRaw(frame({ type: "approval.request", requestID: "apr_1", action: "write file: x.txt", preview: "body", buttons: ["once", "reject"] }));
    expect(c.sent).toEqual([{ type: "approve.reply", requestID: "apr_1", decision: "once" }]);
    expect(c.approvals.map((a) => a.decision)).toEqual(["once"]);
  });

  test("an allowed truncated card is opened in full first, then allowed", () => {
    const c = new RecordingClient();
    c.decideApproval = () => "once";
    c.handleRaw(frame({ type: "approval.request", requestID: "apr_2", action: "run shell: ls", preview: "body", buttons: ["once", "reject"], truncated: true }));
    expect(c.sent).toEqual([{ type: "approval.full", requestID: "apr_2" }]);
    c.handleRaw(frame({ type: "approval.full.ok", requestID: "apr_2", text: "the whole card" }));
    expect(c.sent).toEqual([
      { type: "approval.full", requestID: "apr_2" },
      { type: "approve.reply", requestID: "apr_2", decision: "once" },
    ]);
  });

  test("a denied truncated card is denied without opening it", () => {
    const c = new RecordingClient();
    c.handleRaw(frame({ type: "approval.request", requestID: "apr_3", action: "run shell: rm x", preview: "body", buttons: ["once", "reject"], truncated: true }));
    expect(c.sent).toEqual([{ type: "approve.reply", requestID: "apr_3", decision: "reject" }]);
  });

  test("approval.full.ok for a card it did not hold sends nothing", () => {
    const c = new RecordingClient();
    c.handleRaw(frame({ type: "approval.full.ok", requestID: "apr_unknown", text: "x" }));
    expect(c.sent).toEqual([]);
  });

  test("turns, replies and forms are recorded", () => {
    const c = new RecordingClient();
    c.answerForm = (req) => `answer to ${req.question}`;
    c.handleRaw(frame({ type: "turn.start", turnID: "t1", threadID: "th1", agentID: "ea" }));
    expect(c.running().map((t) => t.turnID)).toEqual(["t1"]);
    c.handleRaw(frame({ type: "msg.new", id: "m1", channelId: "main", fromType: "agent", fromId: "ea", senderName: "Ada", text: "hello", internal: false }));
    c.handleRaw(frame({ type: "form.request", requestID: "f1", question: "Which one?" }));
    c.handleRaw(frame({ type: "turn.end", turnID: "t1", threadID: "th1", stopReason: "end" }));
    expect(c.running()).toEqual([]);
    expect(c.turns.get("t1")?.stopReason).toBe("end");
    expect(c.replies.map((r) => r.text)).toEqual(["hello"]);
    expect(c.forms.map((f) => f.answer)).toEqual(["answer to Which one?"]);
    expect(c.sent).toEqual([{ type: "form.answer", requestID: "f1", answer: "answer to Which one?" }]);
  });

  test("a frame that is not JSON is ignored", () => {
    const c = new RecordingClient();
    c.handleRaw("not json");
    expect(c.frames).toEqual([]);
  });
});
