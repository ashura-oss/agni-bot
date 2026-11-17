/**
 * The whole call behind an approval card (`approval.full`).
 *
 * A card is marked `truncated` when the owner must open the full text before
 * Allow: its preview is cut, or it is more than can be taken in at a glance
 * (over 2,000 characters or 40 lines: `previewNeedsFullView`). The full text is
 * not pushed with every card: the client asks for it. For a card that is long
 * but not cut, it is the whole preview the card was raised with (the owner reads
 * what the card said, in the form the card said it). For a card that is cut it
 * is built here from the call the turn stored, since the preview no longer holds
 * all of it. Every invisible character is escaped the way the card escapes it
 * (`agent/card-text.ts`), and secrets are masked (`util/redact.ts`).
 *
 * Only a card that is still waiting has a full text to show. A card that is
 * answered, expired, or has no stored call gives nothing; the client then keeps
 * Allow locked, and Deny still works.
 */
import type { Database } from "bun:sqlite";
import { escapeUnsafe } from "../agent/card-text";
import { previewIsCut, previewNeedsFullView } from "../agent/approval-broker";
import { redact } from "../util/redact";

/** The most characters one answer carries; a bigger call is cut and `cut` says so. */
export const FULL_TEXT_MAX_CHARS = 1_000_000;

/** Argument names that hold the people a call reaches, with how each is labelled. */
const AUDIENCE: ReadonlyArray<readonly [string, string]> = [
  ["to", "To"], ["cc", "Cc"], ["bcc", "Bcc"], ["attendees", "Attendees"], ["recipients", "Recipients"],
  ["emails", "Emails"], ["invitees", "Invitees"], ["guests", "Guests"], ["participants", "Participants"],
];

function audienceLines(args: Record<string, unknown>): string[] {
  const lines: string[] = [];
  for (const [key, label] of AUDIENCE) {
    const value = args[key];
    const names = Array.isArray(value) ? value.map(String) : typeof value === "string" && value ? [value] : [];
    if (names.length > 0) lines.push(`${label} (${names.length}): ${names.join(", ")}`);
  }
  return lines;
}

/** The call, every argument in full, laid out the way the owner would want to read it. */
export function renderFullCall(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "bash": {
      const cwd = typeof args.cwd === "string" && args.cwd ? `\n\nWorking directory: ${args.cwd}` : "";
      return `Command:\n${String(args.command ?? "")}${cwd}`;
    }
    case "mail_send": {
      const account = typeof args.account === "string" && args.account ? args.account : "agent";
      return [...audienceLines(args), `Account: ${account}`, `Subject: ${String(args.subject ?? "")}`, "", String(args.body ?? "")].join("\n");
    }
    case "write_file": {
      const mode = args.append === true ? "add to the end of the file" : "write the whole file";
      return `Path: ${String(args.path ?? "")}\nMode: ${mode}\n\n${String(args.content ?? "")}`;
    }
    default:
      return [...audienceLines(args), `${toolName} with these arguments:`, "", JSON.stringify(args, null, 2) ?? "{}"].join("\n");
  }
}

/** The full text of a pending card, or null when there is nothing safe to show. */
export function fullApprovalText(db: Database, requestID: string): { text: string; cut: boolean } | null {
  const card = db
    .query<{ turn_id: string | null; call_id: string | null; tool_name: string | null; preview: string | null }, [string]>(
      "SELECT turn_id, call_id, tool_name, preview FROM approvals WHERE id = ? AND status = 'pending'",
    )
    .get(requestID);
  if (!card?.turn_id || !card.call_id) return null;
  // A card that is too long to take in at a glance but is not cut already holds the whole call: that preview is the full text.
  if (card.preview && !previewIsCut(card.preview) && previewNeedsFullView(card.preview)) {
    const text = escapeUnsafe(card.preview, true);
    return text.length <= FULL_TEXT_MAX_CHARS ? { text, cut: false } : { text: `${text.slice(0, FULL_TEXT_MAX_CHARS)}\n[cut: the card is longer than ${FULL_TEXT_MAX_CHARS.toLocaleString("en-US")} characters]`, cut: true };
  }
  const call = db
    .query<{ args: string; tool_name: string }, [string, string]>(
      "SELECT args, tool_name FROM tool_calls WHERE turn_id = ? AND call_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(card.turn_id, card.call_id);
  if (!call) return null;
  let args: unknown;
  try {
    args = JSON.parse(call.args);
  } catch {
    return null;
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) return null;
  const rendered = redact(renderFullCall(card.tool_name ?? call.tool_name, args as Record<string, unknown>));
  const safe = escapeUnsafe(rendered, true);
  if (safe.length <= FULL_TEXT_MAX_CHARS) return { text: safe, cut: false };
  return { text: `${safe.slice(0, FULL_TEXT_MAX_CHARS)}\n[cut: the call is longer than ${FULL_TEXT_MAX_CHARS.toLocaleString("en-US")} characters]`, cut: true };
}
