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

const CLOSURE_NOTES: ReadonlySet<string> = new Set([STOPPED_REQUEST_NOTE, INTERRUPTED_REQUEST_NOTE, REVOKED_REQUEST_NOTE, ...EARLIER_WORDINGS]);

/** True for a stored row that is one of these notes (and not, say, a scheduled job's instruction). */
export function isClosureNote(role: string, text: string): boolean {
  return role === "system" && CLOSURE_NOTES.has(text);
}

export function closeRequest(db: Database, params: { threadID: string; turnID?: string; reason: "stopped" | "interrupted" | "revoked" }): void {
  appendMessage(db, {
    threadID: params.threadID,
    ...(params.turnID ? { turnID: params.turnID } : {}),
    role: "system",
    text: params.reason === "stopped" ? STOPPED_REQUEST_NOTE : params.reason === "revoked" ? REVOKED_REQUEST_NOTE : INTERRUPTED_REQUEST_NOTE,
  });
}
