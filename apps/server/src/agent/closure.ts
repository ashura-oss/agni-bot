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

export const STOPPED_REQUEST_NOTE =
  "[The owner pressed Stop on my previous request, so I did not finish it. That request is closed: I will not resume it, retry its actions, or ask for its approvals again unless the owner asks for it again in a new message.]";

export const INTERRUPTED_REQUEST_NOTE =
  "[My previous request was interrupted by a restart and was not completed. That request is closed: I will not resume it, re-run its tool calls, or ask for its approvals again unless the owner asks for it again in a new message.]";

const CLOSURE_NOTES: ReadonlySet<string> = new Set([STOPPED_REQUEST_NOTE, INTERRUPTED_REQUEST_NOTE]);

/** True for a stored row that is one of these notes (and not, say, a scheduled job's instruction). */
export function isClosureNote(role: string, text: string): boolean {
  return role === "system" && CLOSURE_NOTES.has(text);
}

export function closeRequest(db: Database, params: { threadID: string; turnID?: string; reason: "stopped" | "interrupted" }): void {
  appendMessage(db, {
    threadID: params.threadID,
    ...(params.turnID ? { turnID: params.turnID } : {}),
    role: "system",
    text: params.reason === "stopped" ? STOPPED_REQUEST_NOTE : INTERRUPTED_REQUEST_NOTE,
  });
}
