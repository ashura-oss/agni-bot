/**
 * Closing a request that did not finish.
 *
 * When a turn is stopped by the owner or cut off by a restart, its request
 * stays in the thread with no reply. The next turn would see it as still open
 * and answer it as well, re-asking the actions that were stopped. So one note
 * is stored in the thread, firmly worded, that the MODEL reads as its own last
 * words. It is stored as a `system` row: the owner's conversation history
 * leaves those out, so it never shows as a bot reply.
 */
import type { Database } from "bun:sqlite";
import { appendMessage } from "../stores/threads";
import { entry } from "./card-text";

/**
 * The wording is fixed server text, and careful about one thing: a request that
 * was cut off may have done part of its work. The note must never lead the
 * model to tell the owner it "never ran"; if asked, it looks at the real state.
 */
const CHECK_STATE = "If the owner asks what happened, I check the actual state first (read the file, look at the result) before I answer.";

export const STOPPED_REQUEST_NOTE =
  `[The owner pressed Stop on my previous request, so I did not finish it. Some of its steps may already have run. That request is closed: I will not resume it, retry its actions, or ask for its approvals again unless the owner asks for it again in a new message. ${CHECK_STATE}]`;

export const INTERRUPTED_REQUEST_NOTE =
  `[My previous request was interrupted by a restart and was not completed. Some of its steps may already have run. That request is closed: I will not resume it, re-run its tool calls, or ask for its approvals again unless the owner asks for it again in a new message. ${CHECK_STATE}]`;

export const REVOKED_REQUEST_NOTE =
  `[My previous request came from a device that has since been revoked. Some of its steps may already have run. That request is closed: I will not resume it, retry its actions, or ask for its approvals again. ${CHECK_STATE}]`;

/**
 * True for a stored row that is a closure note: one `closeRequest` wrote. It marks the row, and the
 * mark cannot come from model text. The words alone never make a row a closure note: a note of the
 * fixed wording with no record (only the 2026-11-16 development builds wrote those) is plain system
 * text, and so is a scheduled job's instruction that happens to read like one.
 */
export function isClosureNote(role: string, _text: string, kind?: string | null): boolean {
  return role === "system" && kind === "closure";
}

/**
 * Does this text read like a closure note or its record line? A bot writes jobs, routines and prompts
 * that are stored and shown to a model later as the server's own words; none of them may say what only
 * the server says about a request that was closed. Whitespace and case are ignored, so spacing cannot hide it.
 */
export function closureWording(text: string): boolean {
  const flat = text.replace(/\s+/g, " ").toLowerCase();
  return CLOSURE_MARKERS.some((marker) => marker.test(flat));
}
const CLOSURE_MARKERS: readonly RegExp[] = [
  /that request is closed\b/,
  /the owner pressed stop on my previous request/,
  /my previous request (?:was interrupted by a restart|came from a device that has since been revoked)/,
  /\[record from the tool log of that request/,
];

/** What a refusal says when a bot's text reads like a closure note. */
export const CLOSURE_WORDING_REFUSAL = "not done: that text reads like a server notice about a stopped request, which a bot may not write. Say it in your own words.";

/**
 * Error codes the loop stores on a tool call. A tool's own failure message is stored as its text, so one that
 * happens to equal a code is stored with a prefix instead: no tool can make its error read as one of these.
 */
export const ABORTED_MID_CALL = "aborted_mid_call";
const LOOP_ERROR_CODES: ReadonlySet<string> = new Set([
  "approval_rejected", "approval_expired", "tool_not_allowed", "domain_not_allowed", "tool_not_loaded",
  "cancelled", "interrupted_before_result", ABORTED_MID_CALL, "tool timed out or was cancelled",
]);
export function toolErrorCode(message: string): string {
  return LOOP_ERROR_CODES.has(message) ? `tool_error: ${message}` : message;
}

/** Most calls a note lists; the rest are counted. */
const RECORD_LIMIT = 10;

/** The argument that says what a call was about, in the order a person would name it. */
const TARGET_KEYS = ["path", "command", "to", "recipients", "attendees", "url", "title", "name", "toAgentID", "query"] as const;

/** A tool is named only when it looks like one (registry names, mcp_ names included); anything else is a placeholder. */
function toolLabel(name: string): string {
  return /^[a-z0-9_]{1,64}$/.test(name) ? name : "unknown_tool";
}

function targetOf(args: unknown): string {
  if (typeof args !== "object" || args === null) return "";
  const record = args as Record<string, unknown>;
  for (const key of TARGET_KEYS) {
    const value = record[key];
    if (value === undefined || value === null || value === "") continue;
    // Cleaned and cut by the card sanitiser, then quoted: inside quotes (with its own quotes and
      // backslashes escaped) a target cannot end its entry, start another or open a section.
      return JSON.stringify(entry(Array.isArray(value) ? value.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).join(", ") : value, 80));
  }
  return "";
}

interface RecordedCall {
  tool_name: string; args: string; result: string | null; ok: number; error: string | null;
  /** The call's approval card: how it stands (`pending`, `decided`, `expired`) and what the owner answered. */
  card: string | null; decision: string | null; rule_id: string | null;
}
type Bucket = "done" | "unknown" | "failed" | "denied" | "notRun";

/** Errors stored when the abort cut a call in the middle: the call may well have gone through. */
const CUT_ERRORS: readonly string[] = [ABORTED_MID_CALL, "tool timed out or was cancelled", "interrupted_before_result"];

function bucketOf(row: RecordedCall): { bucket: Bucket; outcome: string } {
  if (row.error !== null && CUT_ERRORS.includes(row.error)) return { bucket: "unknown", outcome: "outcome unknown" };
  if (row.error === "approval_rejected") {
    // Only the owner's own "reject" is a denial; a card still open when the turn was stopped never ran.
    return row.decision === "reject"
      ? { bucket: "denied", outcome: "denied" }
      : { bucket: "notRun", outcome: "not run: stopped while waiting for approval" };
  }
  if (row.error !== null && ["approval_expired", "tool_not_allowed", "domain_not_allowed", "tool_not_loaded", "cancelled"].includes(row.error)) {
    return { bucket: "notRun", outcome: "not run: refused or not approved" };
  }
  if (row.result === null) {
    // No result was stored. A card that is still pending means the call never started. An approved call (or one
    // with no card) was running, and nobody knows how far it got.
    if (row.card === "pending") return { bucket: "notRun", outcome: "not run: interrupted before it ran" };
    if (row.decision === "reject") return { bucket: "denied", outcome: "denied" };
    return { bucket: "unknown", outcome: "outcome unknown" };
  }
  return row.ok === 1 && row.error === null ? { bucket: "done", outcome: "ok" } : { bucket: "failed", outcome: "failed" };
}

/**
 * What the tool log shows a request did, as one line of server text for the model. Built from the stored
 * calls only: the tool, what it was about (cleaned and cut), and how it ended, never a result body.
 */
function recordOf(db: Database, turnID: string): string {
  const rows = db
    .query<RecordedCall, [string]>(
      `SELECT tc.tool_name, tc.args, tc.result, tc.ok, tc.error,
              (SELECT a.status FROM approvals a WHERE a.turn_id = tc.turn_id AND a.call_id = tc.call_id LIMIT 1) AS card,
              (SELECT a.decision FROM approvals a WHERE a.turn_id = tc.turn_id AND a.call_id = tc.call_id LIMIT 1) AS decision,
              (SELECT a.rule_id FROM approvals a WHERE a.turn_id = tc.turn_id AND a.call_id = tc.call_id LIMIT 1) AS rule_id
       FROM tool_calls tc WHERE tc.turn_id = ? ORDER BY tc.created_at, tc.rowid`,
    )
    .all(turnID);
  if (rows.length === 0) return "[Record from the tool log: No tool call of that request had run.]";
  const sections: Array<[Bucket, string]> = [["done", "Already done"], ["unknown", "Outcome unknown, check the real state before repeating"], ["failed", "Failed"], ["denied", "Denied"], ["notRun", "Not done"]];
  const described = rows.map((row) => {
    const { bucket, outcome } = bucketOf(row);
    let args: unknown = {};
    try { args = JSON.parse(row.args); } catch { /* an unreadable call is listed by name only */ }
    const target = targetOf(args);
    return { bucket, text: `${toolLabel(row.tool_name)}${target ? ` ${target}` : ""} (${outcome})` };
  });
  let shown = 0;
  const parts: string[] = [];
  for (const [bucket, label] of sections) {
    const items = described.filter((call) => call.bucket === bucket);
    const room = Math.max(0, RECORD_LIMIT - shown);
    if (items.length === 0 || room === 0) continue;
    const take = items.slice(0, room);
    shown += take.length;
    parts.push(`${label}: ${take.map((call) => call.text).join("; ")}`);
  }
  const more = described.length - shown;
  return `[Record from the tool log of that request (not from memory): ${parts.join(". ")}${more > 0 ? ` (and ${more} more)` : ""}. I will never say that anything listed as done did not happen, I will not repeat it, and I check anything listed as unknown before I act on it.]`;
}

export function closeRequest(db: Database, params: { threadID: string; turnID?: string; reason: "stopped" | "interrupted" | "revoked" }): void {
  const base = params.reason === "stopped" ? STOPPED_REQUEST_NOTE : params.reason === "revoked" ? REVOKED_REQUEST_NOTE : INTERRUPTED_REQUEST_NOTE;
  appendMessage(db, {
    threadID: params.threadID,
    ...(params.turnID ? { turnID: params.turnID } : {}),
    role: "system",
    kind: "closure",
    text: params.turnID ? `${base}\n${recordOf(db, params.turnID)}` : base,
  });
}
