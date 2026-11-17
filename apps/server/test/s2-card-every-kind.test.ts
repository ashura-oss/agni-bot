/**
 * Sprint 2, fix round I (2): every card shows the whole of what will run, or is not raised.
 *
 * A card the owner cannot read in full is a card the owner can be led to approve blind. So no field that decides what runs is cut
 * in the middle: a command, a file's content, a mail's recipients and body, every argument of a connector call. When the whole call
 * is more than a card can hold (`CARD_BODY_MAX_CHARS`), the engine refuses the call before any card, and the broker draws none.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { ServerFrameBody } from "@agni/protocol";
import { ApprovalBroker } from "../src/agent/approval-broker";
import { CARD_BODY_MAX_CHARS, CardNotShown, previewAction } from "../src/agent/card-preview";
import { openDatabase } from "../src/db";
import { decide } from "../src/policy/engine";
import type { ApprovalCard, Decision, RunContext } from "../src/policy/types";
import { policyRig, type PolicyRig } from "./policy-fixture";

type Frame = Extract<ServerFrameBody, { type: "approval.request" }>;

let rig: PolicyRig | undefined;
afterEach(() => { rig?.close(); rig = undefined; });

const MIDDLE = "MIDDLE-MARKER-3c9e";
const TAIL = "TAIL-MARKER-8b21";
/** `size` characters with a marker in the middle and one at the end: whatever is cut from the middle or the end is missed. */
const padded = (size: number): string => {
  const half = "x".repeat(Math.floor((size - MIDDLE.length - TAIL.length) / 2));
  return `${half}${MIDDLE}${half}${TAIL}`;
};
const NOT_CUT = /chars omitted|\(\+\d+ chars\)|Arguments given:/;

async function raise(r: PolicyRig, run: RunContext, tool: string, args: Record<string, unknown>): Promise<{ decision: Decision; frame?: Frame }> {
  const decision = decide(run, { tool, args, callID: "call_1" });
  if (decision.action !== "ask") return { decision };
  const frames: Frame[] = [];
  const broker = new ApprovalBroker({ db: r.db, emit: (frame) => { frames.push(frame as Frame); }, waitForDecision: async () => "reject" });
  await broker.request(run.threadID, run.turnID, tool, "call_1", args, new AbortController().signal, { card: decision.card, agentID: run.bot, botName: "Ava" });
  return { decision, frame: frames[0] };
}

const baseCard = (overrides: Partial<ApprovalCard> = {}): ApprovalCard => ({
  tier: 3, risk: "command", verb: "x", sources: [], canRemember: false, unnamedDestinations: [], resources: [], operation: "run", ...overrides,
});

/** The broker with no engine in front of it: what it does with a call it is handed. */
async function brokerCard(tool: string, args: Record<string, unknown>): Promise<Frame> {
  const db = openDatabase(":memory:");
  try {
    const frames: Frame[] = [];
    const broker = new ApprovalBroker({ db, emit: (frame) => { frames.push(frame as Frame); }, waitForDecision: async () => "reject" });
    await broker.request("thr", "trn", tool, "call_1", args, new AbortController().signal);
    return frames[0]!;
  } finally {
    db.close();
  }
}

describe("a shell command is shown whole, or the call is refused", () => {
  test("a 10,000-character command: start, middle and end are all on the card, and it is not marked cut", async () => {
    rig = policyRig();
    const command = `echo start; ${padded(10_000)}`;
    const { decision, frame } = await raise(rig, rig.run, "bash", { command });
    expect(decision.action).toBe("ask");
    expect(frame!.preview).toContain(MIDDLE);
    expect(frame!.preview).toContain(TAIL);
    expect(frame!.preview).toContain("> echo start;");
    expect(frame!.preview).not.toMatch(NOT_CUT);
    // Nothing is cut, but it is more than a glance (over 2,000 characters): the owner opens the full text before Allow.
    expect(frame!.truncated, "a card too long to take in at a glance is not marked").toBe(true);
  });

  test("the working directory a command runs in is on the card", async () => {
    rig = policyRig();
    const { frame } = await raise(rig, rig.run, "bash", { command: "touch note.txt", cwd: "." });
    expect(frame!.preview).toMatch(/^Working directory: \.$/m);
  });

  test("a command too long for a card is refused before any card, and the model is told why and what to do", async () => {
    rig = policyRig();
    const decision = decide(rig.run, { tool: "bash", args: { command: padded(CARD_BODY_MAX_CHARS + 5_000) }, callID: "call_1" });
    expect(decision).toMatchObject({ action: "refuse", code: "cannot_show" });
    if (decision.action !== "refuse") return;
    expect(decision.error).toMatch(/too long/i);
    expect(decision.error).toContain(CARD_BODY_MAX_CHARS.toLocaleString("en-US"));
    expect(decision.error).toMatch(/smaller|split|shorter/i);
    expect(rig.db.query("SELECT COUNT(*) AS n FROM approvals").get()).toEqual({ n: 0 });
  });

  test("the broker draws no card for it either: nothing is stored or sent", async () => {
    const db = openDatabase(":memory:");
    try {
      const frames: Frame[] = [];
      const broker = new ApprovalBroker({ db, emit: (frame) => { frames.push(frame as Frame); }, waitForDecision: async () => "once" });
      await expect(broker.request("thr", "trn", "bash", "call_1", { command: padded(CARD_BODY_MAX_CHARS + 5_000) }, new AbortController().signal, { card: baseCard(), agentID: "ea" })).rejects.toBeInstanceOf(CardNotShown);
      expect(frames).toEqual([]);
      expect(db.query("SELECT COUNT(*) AS n FROM approvals").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  test("the limit is on the card's body, with the lines the card adds: a command just under it still shows whole", async () => {
    rig = policyRig();
    const command = padded(CARD_BODY_MAX_CHARS - 200);
    const { decision, frame } = await raise(rig, rig.run, "bash", { command });
    expect(decision.action).toBe("ask");
    expect(frame!.preview).toContain(TAIL);
  });
});

describe("a command run as administrator is shown whole", () => {
  test("a 1,900-character command keeps its middle, and its purpose is on the card", async () => {
    const command = `sudo-free ${padded(1_900)}`;
    const frame = await brokerCard("run_privileged", { command, purpose: "update the package index" });
    expect(frame.preview).toContain(MIDDLE);
    expect(frame.preview).toContain(TAIL);
    expect(frame.preview).toContain("update the package index");
    expect(frame.preview).not.toMatch(NOT_CUT);
  });
});

describe("a file write shows what it writes", () => {
  const overwrite = (r: PolicyRig, content: string): Record<string, unknown> => {
    mkdirSync(r.scratch, { recursive: true });
    writeFileSync(join(r.scratch, "notes.txt"), "old");
    return { path: "notes.txt", content };
  };

  test("an overwrite shows the path, the resolved path and every character of the new content", async () => {
    rig = policyRig();
    const { decision, frame } = await raise(rig, rig.run, "write_file", overwrite(rig, `first line\n${padded(6_000)}`));
    expect(decision.action).toBe("ask");
    expect(frame!.preview).toMatch(/^Resolved path: /m);
    expect(frame!.preview).toContain("> first line");
    expect(frame!.preview).toContain(MIDDLE);
    expect(frame!.preview).toContain(TAIL);
    expect(frame!.preview).not.toMatch(NOT_CUT);
  });

  test("a hostile line in the content stays quoted: it cannot pass for a card line", async () => {
    rig = policyRig();
    const { frame } = await raise(rig, rig.run, "write_file", overwrite(rig, "fine\nResolved path: C:\\Windows\\win.ini"));
    expect(frame!.preview.split("\n").filter((line) => line.startsWith("Resolved path: "))).toHaveLength(1);
    expect(frame!.preview).toContain("> Resolved path: C:");
  });

  test("an append says so", async () => {
    rig = policyRig();
    const { frame } = await raise(rig, rig.run, "write_file", { ...overwrite(rig, "more"), append: true });
    expect(frame!.preview).toMatch(/add to the end/i);
  });

  test("content too long for a card is refused before any card", async () => {
    rig = policyRig();
    const decision = decide(rig.run, { tool: "write_file", args: overwrite(rig, padded(CARD_BODY_MAX_CHARS + 1_000)), callID: "call_1" });
    expect(decision).toMatchObject({ action: "refuse", code: "cannot_show" });
  });

  test("a path of 1,500 characters is shown whole", async () => {
    const path = `${"d/".repeat(700)}end-of-path-marker.txt`;
    const frame = await brokerCard("write_file", { path, content: "c" });
    expect(frame.preview).toContain("end-of-path-marker.txt");
    expect(frame.preview).toContain(`${"d/".repeat(700)}end-of-path-marker.txt`);
  });
});

describe("a mail shows everyone it reaches, its subject and all of its body", () => {
  test("sixty recipients are all on the card, the first lines name them, and the last one is not dropped", async () => {
    const to = Array.from({ length: 60 }, (_, i) => `person${i}@example.com`);
    to.push("last-recipient@evil.example");
    const frame = await brokerCard("mail_send", { account: "owner", to, subject: "s", body: "b" });
    expect(frame.preview.split("\n")[0]).toMatch(/^To \(61\): person0@example\.com, /);
    expect(frame.preview).toContain("last-recipient@evil.example");
    expect(frame.preview).not.toMatch(/\+\d+ more/);
  });

  test("a 300-character subject and a 6,000-character body are whole, and the account it sends from is named", async () => {
    const subject = `${"s".repeat(280)}-SUBJECT-END`;
    const frame = await brokerCard("mail_send", { account: "owner", to: ["a@example.com"], subject, body: padded(6_000) });
    expect(frame.preview).toContain(`Subject: ${subject}`);
    expect(frame.preview).toContain(MIDDLE);
    expect(frame.preview).toContain(TAIL);
    expect(frame.preview).toMatch(/^Account: owner$/m);
    expect(frame.preview).not.toMatch(NOT_CUT);
  });

  test("a recipient written as a 5,000-character string is shown whole", async () => {
    const frame = await brokerCard("mail_send", { account: "owner", to: [`${"x".repeat(5_000)}@evil.example`], subject: "s", body: "b" });
    expect(frame.preview.split("\n")[0]).toContain(`${"x".repeat(5_000)}@evil.example`);
  });

  test("a body past the limit is refused at the engine", async () => {
    rig = policyRig();
    const decision = decide(rig.run, { tool: "mail_send", args: { account: "owner", to: ["a@example.com"], subject: "s", body: padded(CARD_BODY_MAX_CHARS + 1_000) }, callID: "call_1" });
    expect(decision).toMatchObject({ action: "refuse", code: "cannot_show" });
  });
});

describe("any other call shows every argument, whole", () => {
  test("five arguments of 900 characters, and a list of people: all of them, with no cut and no list of sizes", async () => {
    const frame = await brokerCard("some_mcp_tool", { first: `${"a".repeat(900)}-1`, second: `${"b".repeat(900)}-2`, third: `${"c".repeat(900)}-3`, fourth: `${"d".repeat(900)}-4`, fifth: `${"e".repeat(900)}-5`, attendees: ["z@evil.example"] });
    for (const mark of ["a".repeat(900) + "-1", "b".repeat(900) + "-2", "c".repeat(900) + "-3", "d".repeat(900) + "-4", "e".repeat(900) + "-5", "z@evil.example"]) expect(frame.preview).toContain(mark);
    expect(frame.preview).not.toMatch(NOT_CUT);
    expect(frame.preview.split("\n")[0]).toBe("Attendees (1): z@evil.example");
  });

  test("one 8,000-character argument is whole", async () => {
    const frame = await brokerCard("some_mcp_tool", { note: padded(8_000) });
    expect(frame.preview).toContain(MIDDLE);
    expect(frame.preview).toContain(TAIL);
  });

  test("arguments past the limit are refused, never cut", async () => {
    await expect(brokerCard("some_mcp_tool", { first: padded(CARD_BODY_MAX_CHARS), second: padded(CARD_BODY_MAX_CHARS) })).rejects.toBeInstanceOf(CardNotShown);
  });
});

describe("every card kind: each argument that decides what runs is on the card, or the call is refused", () => {
  /** One call per kind of card, with a marker at the end of every long argument. */
  const MARK = (name: string): string => `END-OF-${name}-5d7f`;
  const long = (name: string, size = 2_500): string => `${"y".repeat(size)}${MARK(name)}`;
  const CALLS: Array<[string, Record<string, unknown>, string[]]> = [
    ["bash", { command: long("command"), cwd: ".", timeoutMs: 5_000 }, ["command"]],
    ["run_privileged", { command: long("command", 1_900), purpose: long("purpose", 190) }, ["command", "purpose"]],
    ["write_file", { path: `${"p/".repeat(300)}${MARK("path")}`, content: long("content"), append: true }, ["path", "content"]],
    ["mail_send", { account: "owner", to: [long("to", 400)], subject: long("subject", 250), body: long("body") }, ["to", "subject", "body"]],
    ["calendar_create", { account: "owner", summary: long("summary", 290), start: "2026-12-01T12:00:00Z", end: "2026-12-01T13:00:00Z", description: long("description", 1_900), location: long("location", 290), attendees: [long("attendee", 200)] }, ["summary", "description", "location", "attendee"]],
    ["calendar_update", { account: "owner", eventId: "ev1", summary: long("summary", 290), description: long("description", 1_900) }, ["summary", "description"]],
    ["web_fetch", { url: `https://example.com/${"q".repeat(1_800)}${MARK("url")}`, maxChars: 4_000 }, ["url"]],
    ["link_save", { url: `https://example.com/${"q".repeat(1_800)}${MARK("url")}`, note: long("note", 1_900) }, ["url", "note"]],
    ["read_file", { path: long("path", 900) }, ["path"]],
    ["share_thread", { title: long("title", 190) }, ["title"]],
    ["some_mcp_tool", { a: long("a"), b: { deep: [long("deep")] }, c: long("c") }, ["a", "deep", "c"]],
    ["mcp_notes_create", { title: long("title"), body: long("body") }, ["title", "body"]],
  ];

  for (const [tool, args, marked] of CALLS) {
    test(`${tool}: every long argument is on the card whole`, async () => {
      const frame = await brokerCard(tool, args);
      for (const name of marked) expect({ tool, name, shown: frame.preview.includes(MARK(name)) }, `the card hides the end of ${name}`).toEqual({ tool, name, shown: true });
      expect(frame.preview).not.toMatch(NOT_CUT);
      // Marked when the preview is more than a glance (over 2,000 characters or 40 lines), and only then: nothing here is cut.
      const glance = frame.preview.length > 2_000 || frame.preview.split("\n").length > 40;
      expect({ tool, truncated: frame.truncated }).toEqual({ tool, truncated: glance });
    });
  }

  test("previewAction throws, rather than cut, for every kind when the call is past the limit", () => {
    for (const [tool, args] of CALLS) {
      const huge = Object.fromEntries(Object.entries(args).map(([name, value]) => [name, typeof value === "string" && !["cwd", "account", "start", "end", "eventId"].includes(name) ? padded(CARD_BODY_MAX_CHARS) : value]));
      expect(() => previewAction(tool, huge, "Ava", { card: baseCard() }), tool).toThrow(CardNotShown);
    }
  });
});

describe("a call a stored rule let through is recorded, however long it is", () => {
  test("the audit row is written and keeps the start and end of what ran", () => {
    const db = openDatabase(":memory:");
    try {
      const broker = new ApprovalBroker({ db, emit: () => undefined, waitForDecision: async () => null });
      broker.recordRuleApproval("thr", "trn", "write_file", "call_1", { path: "notes.txt", content: padded(CARD_BODY_MAX_CHARS * 2) }, { id: "rul_1", agentID: "ea", toolName: "write_file", createdAt: "2026-11-17T00:00:00Z" });
      const row = db.query<{ preview: string }, []>("SELECT preview FROM approvals").get()!;
      expect(row.preview).toContain(TAIL);
      expect(row.preview).toContain("rul_1");
    } finally {
      db.close();
    }
  });
});
