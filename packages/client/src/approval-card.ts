/**
 * What an approval card needs beyond its text: whether the owner must open the full call before
 * Allow, what the server answered when asked for it, and how long the card has left. Pure, so the
 * rules are tested without a screen. The reducer (`conversation.ts`) keeps the rows; this file
 * only says what a row means.
 */
import type { ApprovalSource } from "@agni/protocol";

/** The full text behind a card that was cut or is too long to take in at a glance. */
export interface ApprovalFullText {
  /** `idle` not asked yet, `loading` asked, `open` the owner has the whole text, `failed` it did not come. */
  state: "idle" | "loading" | "open" | "failed";
  text: string;
  /** Even the full text hit the server's size limit: the owner has not seen all of it. */
  cut: boolean;
}

/** The fields a card row carries from `approval.request` (all optional: older servers send none). */
export interface ApprovalCardFields {
  truncated?: boolean;
  expiresAt?: string | null;
  tier?: number | null;
  source?: ApprovalSource[];
  full?: ApprovalFullText;
  /** A line the owner should read next to the buttons (a refused Allow, a failed load). */
  notice?: string | null;
}

export const NO_FULL_TEXT: ApprovalFullText = { state: "idle", text: "", cut: false };

export const READ_FIRST = "Read the full text before allowing.";
export const NOT_OPENED_NOTICE =
  "The daemon did not accept Allow because the full text was not opened. The card is still waiting: open the full text, then allow it.";
export const FULL_FAILED = "Could not load the full text. Check the connection and try again.";

/**
 * Is Allow locked? A card marked `truncated` hides part of the call (or is too long to take in at
 * a glance): it cannot be allowed until its full text is open, and only a text that came whole
 * counts. Deny is never locked.
 */
export function allowLocked(row: ApprovalCardFields): boolean {
  if (!row.truncated) return false;
  const full = row.full ?? NO_FULL_TEXT;
  return !(full.state === "open" && !full.cut);
}

/** Does this answer need the full text first? Only an Allow on a locked card does. */
export function answerNeedsFullText(row: ApprovalCardFields, decision: string): boolean {
  return decision !== "reject" && allowLocked(row);
}

export type Expiry = { kind: "none" } | { kind: "expired" } | { kind: "left"; text: string; msLeft: number };

/** "Expires in 9 min", "Expires in under 1 min", or expired. A missing or unreadable time shows nothing. */
export function expiryOf(expiresAt: string | null | undefined, now: number): Expiry {
  if (!expiresAt) return { kind: "none" };
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return { kind: "none" };
  const msLeft = at - now;
  if (msLeft <= 0) return { kind: "expired" };
  if (msLeft <= 60_000) return { kind: "left", text: "Expires in under 1 min", msLeft };
  return { kind: "left", text: `Expires in ${Math.ceil(msLeft / 60_000)} min`, msLeft };
}
