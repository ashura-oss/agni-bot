/**
 * S2-08 / S2-17: "view full text" before Allow. `approval.full` returns the
 * whole call behind a pending card whose preview was cut, with every
 * invisible character escaped the way the card escapes them.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { FULL_TEXT_MAX_CHARS, fullApprovalText } from "../src/ws/approval-full";
import { createThread, createTurn } from "../src/stores/threads";

let db: Database;
let threadID: string;
let turnID: string;

beforeEach(() => {
  db = openDatabase(":memory:");
  threadID = createThread(db, "ea").id;
  turnID = "trn_full";
  createTurn(db, { id: turnID, threadID, agentID: "ea" });
});

afterEach(() => db.close());

function card(toolName: string, args: unknown, options: { status?: string; withCall?: boolean } = {}): string {
  const id = `apr_${Math.random().toString(36).slice(2, 8)}`;
  const callID = `call_${id}`;
  db.run(
    "INSERT INTO approvals (id, thread_id, turn_id, action, preview, status, decision, call_id, tool_name, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)",
    [id, threadID, turnID, "act", "preview", options.status ?? "pending", callID, toolName, new Date().toISOString()],
  );
  if (options.withCall !== false) {
    db.run(
      "INSERT INTO tool_calls (id, thread_id, turn_id, call_id, tool_name, args, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [`tc_${id}`, threadID, turnID, callID, toolName, JSON.stringify(args), new Date().toISOString()],
    );
  }
  return id;
}

describe("fullApprovalText", () => {
  test("a long shell command comes back whole, with its end", () => {
    const command = `echo start && ${"x".repeat(20_000)} && rm -rf /tmp/the-end`;
    const result = fullApprovalText(db, card("bash", { command }))!;
    expect(result.text).toContain(command);
    expect(result.cut).toBe(false);
  });

  test("a mail shows every recipient, the subject and the whole body", () => {
    const body = `${"hello ".repeat(2_000)}and the last line`;
    const result = fullApprovalText(db, card("mail_send", { to: ["a@example.com", "b@example.com"], cc: ["c@example.com"], subject: "Report", body }))!;
    expect(result.text).toContain("To (2): a@example.com, b@example.com");
    expect(result.text).toContain("Cc (1): c@example.com");
    expect(result.text).toContain("Subject: Report");
    expect(result.text).toContain("and the last line");
  });

  test("a file write shows the path and the whole content", () => {
    const content = `${"line\n".repeat(3_000)}final`;
    const result = fullApprovalText(db, card("write_file", { path: "notes/out.txt", content, append: true }))!;
    expect(result.text).toContain("Path: notes/out.txt");
    expect(result.text).toContain("add to the end of the file");
    expect(result.text.endsWith("final")).toBe(true);
  });

  test("any other tool shows its name and every argument in full", () => {
    const result = fullApprovalText(db, card("calendar_create", { title: "t".repeat(5_000), attendees: ["x@example.com"] }))!;
    expect(result.text).toContain("calendar_create with these arguments");
    expect(result.text).toContain("t".repeat(5_000));
    expect(result.text).toContain("x@example.com");
  });

  test("invisible and direction-changing characters are shown as escapes, line breaks are kept", () => {
    const result = fullApprovalText(db, card("bash", { command: "ls​‮ -la\nwhoami" }))!;
    expect(result.text).toContain("\\u200B");
    expect(result.text).toContain("\\u202E");
    expect(result.text).toContain("\nwhoami");
    expect(result.text).not.toMatch(/[​‮]/);
  });

  test("text over the limit is cut and says so", () => {
    const result = fullApprovalText(db, card("bash", { command: "y".repeat(FULL_TEXT_MAX_CHARS + 5_000) }))!;
    expect(result.cut).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(FULL_TEXT_MAX_CHARS + 200);
  });

  test("a card that is not pending, unknown, or without a stored call gives nothing", () => {
    expect(fullApprovalText(db, card("bash", { command: "ls" }, { status: "decided" }))).toBeNull();
    expect(fullApprovalText(db, card("bash", { command: "ls" }, { status: "expired" }))).toBeNull();
    expect(fullApprovalText(db, "apr_missing")).toBeNull();
    expect(fullApprovalText(db, card("bash", { command: "ls" }, { withCall: false }))).toBeNull();
  });

  test("unreadable stored arguments give nothing rather than a guess", () => {
    const id = card("bash", {});
    db.run("UPDATE tool_calls SET args = ? WHERE tool_name = 'bash'", ["{not json"]);
    expect(fullApprovalText(db, id)).toBeNull();
  });
});
