/**
 * Visibility — the one place another agent's text is allowed to cross a
 * boundary.
 *
 * An agent's `visibility` says what the caller (usually the executive
 * assistant) may see of what that agent produced:
 *
 *   private  → nothing leaves the agent. The caller gets a receipt: the
 *              task id, the state, and the fact that it finished. The text
 *              stays in the agent's own conversation, which the owner can
 *              open directly.
 *   summary  → the caller gets one line (SUMMARY_MAX_CHARS), enough to report
 *              status and an outcome, not the working. The result of work
 *              the caller asked for is the exception: RESULT_MAX_CHARS.
 *   shared   → the caller gets the full text.
 *
 * The rule that matters: every path that can carry that text goes through
 * `redactForCaller`. Tool results, task rows, artifacts, recall, summaries,
 * `expand` and the logs. A new sink added without this filter is a leak, so
 * the filter lives here and nowhere else.
 *
 * The owner always sees everything: the owner is the human, not an agent.
 */

export const VISIBILITIES = ["private", "summary", "shared"] as const;
export type Visibility = (typeof VISIBILITIES)[number];

/** What an agent gets when nothing says otherwise. */
export const DEFAULT_VISIBILITY: Visibility = "summary";

export function normalizeVisibility(value: string | null | undefined): Visibility {
  return VISIBILITIES.includes(value as Visibility) ? (value as Visibility) : DEFAULT_VISIBILITY;
}

/**
 * How much of another bot's chat, facts or working a `summary` caller gets:
 * one short line.
 */
export const SUMMARY_MAX_CHARS = 240;

/**
 * A different thing: the deliverable of work the caller asked for (a
 * delegated task's result, a handoff's answer). It goes back to the bot that
 * asked in full up to this size, even from a `summary` bot, because cutting it
 * to a line threw the work away. Anything longer is cut and the full text
 * stays in the artifact the task points at. `private` is still a receipt.
 */
export const RESULT_MAX_CHARS = 4_000;

export interface RedactedText {
  /** The text the caller may see, or null when nothing may cross. */
  text: string | null;
  /** True when the caller sees a receipt instead of the text. */
  redacted: boolean;
  /** The visibility that produced this result. */
  mode: Visibility;
}

/**
 * The first line (or first sentence) of a text, bounded. Used for the
 * `summary` mode and for receipts: enough to say what happened, not the
 * working.
 */
export function summarizeText(text: string, maxChars: number = SUMMARY_MAX_CHARS, keepLines = false): string | null {
  // A work result keeps its line breaks (a list stays a list); only runs of blank lines and of spaces collapse.
  const cleaned = keepLines
    ? text.replace(/\r\n?/g, "\n").split("\n").map((line) => line.replace(/[^\S\n]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim()
    : text.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  if (cleaned.length <= maxChars) return cleaned;
  const head = cleaned.slice(0, maxChars);
  const cut = Math.max(head.lastIndexOf(" "), head.lastIndexOf("\n"));
  const body = cut > maxChars * 0.6 ? head.slice(0, cut) : head;
  return `${body}…`;
}

/**
 * The choke point. `ownerAgentID` is the agent that produced the text,
 * `callerAgentID` is the agent asking for it, and `visibility` is the
 * producer's visibility to that caller.
 */
export function redactForCaller(
  text: string,
  ownerAgentID: string,
  callerAgentID: string | null | undefined,
  visibility: Visibility,
  summaryMaxChars: number = SUMMARY_MAX_CHARS,
  keepLines = false,
): RedactedText {
  const mode = normalizeVisibility(visibility);
  const body = text ?? "";
  if (!body.trim()) return { text: null, redacted: false, mode };
  // The owner is not an agent: the owner's own agent (the executive
  // assistant) is its proxy, and it sees everything the owner sees.
  if (!callerAgentID || callerAgentID === ownerAgentID) {
    return { text: body, redacted: false, mode };
  }
  if (mode === "shared") return { text: body, redacted: false, mode };
  if (mode === "summary") {
    const summary = summarizeText(body, summaryMaxChars, keepLines);
    return { text: summary, redacted: false, mode };
  }
  return { text: null, redacted: true, mode };
}

/**
 * The same choke point for the result of work the caller asked for: a
 * `summary` bot's answer comes back up to RESULT_MAX_CHARS, not one line.
 */
export function redactResultForCaller(
  text: string,
  ownerAgentID: string,
  callerAgentID: string | null | undefined,
  visibility: Visibility,
): RedactedText {
  return redactForCaller(text, ownerAgentID, callerAgentID, visibility, RESULT_MAX_CHARS, true);
}

/**
 * The same rule for a stored value that may be absent: a task row whose
 * result the caller may not see. Returns the value or null, plus whether the
 * caller was cut off.
 */
export function redactStoredForCaller(
  value: string | null | undefined,
  ownerAgentID: string,
  callerAgentID: string | null | undefined,
  visibility: Visibility,
  summaryMaxChars: number = SUMMARY_MAX_CHARS,
  keepLines = false,
): { value: string | null; redacted: boolean } {
  if (value === null || value === undefined || value === "") return { value: null, redacted: false };
  const result = redactForCaller(value, ownerAgentID, callerAgentID, visibility, summaryMaxChars, keepLines);
  return { value: result.text, redacted: result.redacted };
}
