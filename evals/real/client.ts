/**
 * A minimal protocol client for the eval harness: plain JSON frames over the
 * server's real WebSocket, with scripted owner answers to approval and form
 * cards. Imported from the round-5 harness (`agni.ts`), plus the
 * `approval.full` step that a truncated card needs before an allow
 * (protocol v2: an allow to a truncated card is refused until it was opened).
 */
import { PROTOCOL_VERSION } from "../../packages/protocol/src/frames";
import { sleep } from "./util";

export interface TurnRec {
  turnID: string;
  threadID: string;
  agentID: string;
  startAt: number;
  endAt?: number;
  stopReason?: string;
  usage?: unknown;
}
export interface ApprovalRec {
  requestID: string;
  action: string;
  preview: string;
  decision: "once" | "reject";
  at: number;
}
export interface FormRec {
  requestID: string;
  question: string;
  kind?: string;
  answer: string;
  at: number;
}
export interface ApprovalRequest {
  requestID: string;
  action: string;
  preview: string;
}
export interface FormRequest {
  requestID: string;
  question: string;
  options?: string[];
  kind?: string;
}

export class AgniClient {
  ws: WebSocket | null = null;
  frames: Array<{ t: number; f: any }> = [];
  turns = new Map<string, TurnRec>();
  approvals: ApprovalRec[] = [];
  forms: FormRec[] = [];
  replies: Array<{ t: number; from: string; text: string; channel: string; hint?: string }> = [];
  notifies: Array<{ t: number; title: string; body: string }> = [];
  errors: Array<{ t: number; code: string; message: string }> = [];
  sessionStarts: Array<{ t: number; reason: string; sessionID: string }> = [];
  toolEvents = 0;
  closed = false;
  /** The owner's answer to an approval card. The default denies. */
  decideApproval: (req: ApprovalRequest) => "once" | "reject" = () => "reject";
  /** The owner's answer to a form card. */
  answerForm: (req: FormRequest) => string = () =>
    "Please use your best judgment and carry on; I am not available to answer questions right now.";
  /** Allows held until the server answers `approval.full` for the card. */
  private readonly pendingFull = new Set<string>();
  private waiters: Array<(f: any) => boolean> = [];

  static async connect(port: number, token: string, device = "eval-driver"): Promise<AgniClient> {
    const client = new AgniClient();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    client.ws = ws;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("ws open timeout")), 8000);
      ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("ws error")); }, { once: true });
    });
    ws.addEventListener("message", (event) => {
      if (typeof event.data === "string") client.handleRaw(event.data);
    });
    ws.addEventListener("close", () => { client.closed = true; });
    const hello = client.waitFrame((f) => f.type === "hello.ok" || f.type === "error", 8000);
    client.send({ type: "hello", v: PROTOCOL_VERSION, token, device });
    const h = await hello;
    if (h.type !== "hello.ok") throw new Error(`hello failed: ${h.code} ${h.message}`);
    return client;
  }

  send(frame: unknown): void {
    if (!this.ws) throw new Error("not connected");
    this.ws.send(JSON.stringify(frame));
  }

  waitFrame(pred: (f: any) => boolean, ms: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const waiter = (f: any): boolean => {
        if (!pred(f)) return false;
        clearTimeout(timer);
        this.waiters = this.waiters.filter((x) => x !== waiter);
        resolve(f);
        return true;
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== waiter);
        reject(new Error("waitFrame timeout"));
      }, ms);
      this.waiters.push(waiter);
    });
  }

  /** One raw frame from the server. Public so a test can feed frames without a socket. */
  handleRaw(raw: string): void {
    let f: any;
    try {
      f = JSON.parse(raw);
    } catch {
      return;
    }
    const t = Date.now();
    this.frames.push({ t, f });
    switch (f.type) {
      case "turn.start":
        this.turns.set(f.turnID, { turnID: f.turnID, threadID: f.threadID, agentID: f.agentID, startAt: t });
        break;
      case "turn.end": {
        const rec = this.turns.get(f.turnID);
        if (rec) {
          rec.endAt = t;
          rec.stopReason = f.stopReason;
          rec.usage = f.usage;
        } else {
          this.turns.set(f.turnID, { turnID: f.turnID, threadID: f.threadID, agentID: "?", startAt: t, endAt: t, stopReason: f.stopReason, usage: f.usage });
        }
        break;
      }
      case "tool.start":
        this.toolEvents++;
        break;
      case "msg.new":
        if (f.fromType === "agent") this.replies.push({ t, from: f.fromId, text: f.text, channel: f.channelId, hint: f.uiHint });
        break;
      case "notify":
        this.notifies.push({ t, title: String(f.title ?? ""), body: String(f.body ?? "") });
        break;
      case "error":
        this.errors.push({ t, code: f.code, message: String(f.message ?? "") });
        break;
      case "session.start":
        this.sessionStarts.push({ t, reason: f.reason, sessionID: f.sessionID });
        break;
      case "approval.request": {
        const action = String(f.action);
        const preview = String(f.preview);
        const decision = this.decideApproval({ requestID: f.requestID, action, preview });
        this.approvals.push({ requestID: f.requestID, action, preview: preview.slice(0, 600), decision, at: t });
        if (decision !== "reject" && f.truncated === true) {
          // The server refuses an allow to a truncated card until the card was opened in full.
          this.pendingFull.add(f.requestID);
          this.send({ type: "approval.full", requestID: f.requestID });
        } else {
          this.send({ type: "approve.reply", requestID: f.requestID, decision });
        }
        break;
      }
      case "approval.full.ok":
        if (this.pendingFull.delete(f.requestID)) this.send({ type: "approve.reply", requestID: f.requestID, decision: "once" });
        break;
      case "form.request": {
        const answer = this.answerForm({ requestID: f.requestID, question: f.question, options: f.options, kind: f.kind });
        this.forms.push({ requestID: f.requestID, question: String(f.question).slice(0, 400), kind: f.kind, answer, at: t });
        this.send({ type: "form.answer", requestID: f.requestID, answer });
        break;
      }
      default:
        break;
    }
    for (const waiter of [...this.waiters]) waiter(f);
  }

  running(): TurnRec[] {
    return [...this.turns.values()].filter((turn) => turn.endAt === undefined);
  }

  /** An owner message to a bot (main channel for the assistant, `dm:<id>` otherwise). Resolves when that bot's turn ends. */
  async say(
    text: string,
    opts: { agentId?: string; maxMs?: number } = {},
  ): Promise<{ turn?: TurnRec; replies: string[]; ms: number; timedOut: boolean }> {
    const agent = opts.agentId ?? "ea";
    const maxMs = opts.maxMs ?? 600_000;
    const t0 = Date.now();
    const before = this.frames.length;
    const repliesBefore = this.replies.length;
    this.send({ type: "msg.send", text, channelId: agent === "ea" ? "main" : `dm:${agent}`, ...(agent === "ea" ? {} : { toAgentId: agent }) });
    let turn: TurnRec | undefined;
    const deadline = t0 + maxMs;
    while (Date.now() < deadline) {
      if (!turn) {
        for (const { f } of this.frames.slice(before)) {
          if (f.type === "turn.start" && (f.agentID === agent || (agent === "ea" && f.agentID === "agni"))) {
            turn = this.turns.get(f.turnID);
            break;
          }
        }
      }
      if (turn?.endAt) break;
      if (this.closed) break;
      await sleep(250);
    }
    const replies = this.replies
      .slice(repliesBefore)
      .filter((r) => r.from === agent || (agent === "ea" && r.from === "agni"))
      .map((r) => r.text);
    return { turn, replies, ms: Date.now() - t0, timedOut: !turn?.endAt };
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {
      // already closed
    }
  }
}
