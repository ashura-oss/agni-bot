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
 * Notes already stored under earlier wordings stay recognised, so a thread that
 * holds one still shows it to the model and still keeps it out of the summariser's
 * reach of untrusted system rows.
 */
const EARLIER_WORDINGS = [
  "[The owner pressed Stop on my previous request, so I did not finish it. That request is closed: I will not resume it, retry its actions, or ask for its approvals again unless the owner asks for it again in a new message.]",
  "[My previous request was interrupted by a restart and was not completed. That request is closed: I will not resume it, re-run its tool calls, or ask for its approvals again unless the owner asks for it again in a new message.]",
  "[My previous request came from a device that has since been revoked. That request is closed: I will not resume it, retry its actions, or ask for its approvals again.]",
];

const CLOSURE_NOTES: readonly string[] = [STOPPED_REQUEST_NOTE, INTERRUPTED_REQUEST_NOTE, REVOKED_REQUEST_NOTE, ...EARLIER_WORDINGS];

/**
 * True for a stored row that is one of these notes, alone or followed by the record of what the
 * request had done (and not, say, a scheduled job's instruction).
 */
export function isClosureNote(role: string, text: string): boolean {
  return role === "system" && CLOSURE_NOTES.some((note) => text === note || text.startsWith(`${note}\n[Record`));
}

/** Most calls a note lists; the rest are counted. */
const RECORD_LIMIT = 10;

/** The argument that says what a call was about, in the order a person would name it. */
const TARGET_KEYS = ["path", "command", "to", "recipients", "attendees", "url", "title", "name", "toAgentID", "query"] as const;

/** Characters the record is built from, shown as escapes inside a target so a path cannot imitate its structure. */
const STRUCTURE_CHARS = /[\[\];]/g;
const neutralise = (text: string): string => text.replace(STRUCTURE_CHARS, (ch) => `\\u${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`);

function targetOf(args: unknown): string {
  if (typeof args !== "object" || args === null) return "";
  const record = args as Record<string, unknown>;
  for (const key of TARGET_KEYS) {
    const value = record[key];
    if (value === undefined || value === null || value === "") continue;
    return neutralise(entry(Array.isArray(value) ? value.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).join(", ") : value, 80));
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
const CUT_ERRORS: readonly string[] = ["tool timed out or was cancelled", "interrupted_before_result"];

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
    return { bucket, text: `${entry(row.tool_name, 60)}${target ? ` ${target}` : ""} (${outcome})` };
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
    text: params.turnID ? `${base}\n${recordOf(db, params.turnID)}` : base,
  });
}
