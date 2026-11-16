/**
 * Reading a channel's history through each row's author (S2-06 follow-up).
 *
 * A channel names one primary bot, but a group has several authors and the owner
 * writes in all of them. Judging the whole channel by the primary bot's visibility
 * handed a private bot's lines to a bot outside the room, so every reader of channel
 * history decides per row, here and nowhere else:
 *
 *   a bot's own row                        in full, wherever it was written
 *   a row written by another bot           that bot's visibility, even for a bot that belongs to the channel
 *                                          (the group context shows a member no more, and neither may a search)
 *   a row written by the owner             in full for a bot that belongs to the channel; for any other bot,
 *                                          the strictest visibility among the channel's bots
 *   a row whose author cannot be resolved  private: a receipt
 *
 * Ids are compared canonically on both sides, and a caller that is not known is a
 * stranger, never "the owner".
 */
import type { Database } from "bun:sqlite";
import { channelAgentIDs, type ChannelRow } from "../stores/channels";
import { canonicalAgentID, resolvePersona } from "./personas";
import { MISSING_AGENT_VISIBILITY, redactForCaller, type RedactedText, type Visibility } from "./visibility";

/** The author of one channel row, as the table stores it. */
export interface RowAuthor {
  from_type: string;
  from_id: string;
}

/** Stands for a caller with no id: it matches no author, so nothing is read as its own. */
const STRANGER = "\u0000stranger";
const OWNER = "\u0000owner";
const STRICTNESS: Record<Visibility, number> = { shared: 0, summary: 1, private: 2 };

/** The caller as a comparison key: canonical, or a stranger when it has no id. */
export function callerKey(callerAgentID: string | null | undefined): string {
  const id = (callerAgentID ?? "").trim();
  return id ? canonicalAgentID(id) : STRANGER;
}

/** Bots that belong to the channel, as canonical ids. */
export function channelMembers(db: Database, channel: ChannelRow | null | undefined): string[] {
  if (!channel) return [];
  return channelAgentIDs(db, channel).map((id) => canonicalAgentID(id));
}

/** Does this bot belong to the channel (its own chat, or a group it is in)? */
export function isChannelParticipant(db: Database, channel: ChannelRow | null | undefined, callerAgentID: string | null | undefined): boolean {
  const caller = callerKey(callerAgentID);
  return caller !== STRANGER && channelMembers(db, channel).includes(caller);
}

/** A bot's visibility; one that no longer exists is private. */
function botVisibility(db: Database, agentID: string): Visibility {
  return resolvePersona(db, agentID)?.visibility ?? MISSING_AGENT_VISIBILITY;
}

/** The strictest visibility among the channel's bots; a channel with none, or none that resolves, is private. */
function strictestMember(db: Database, channel: ChannelRow | null | undefined): Visibility {
  const members = channelMembers(db, channel);
  if (members.length === 0) return MISSING_AGENT_VISIBILITY;
  return members.map((id) => botVisibility(db, id)).reduce((worst, next) => (STRICTNESS[next] > STRICTNESS[worst] ? next : worst));
}

/** Who wrote the row and how much of it another bot may read. */
export function rowAuthority(db: Database, channel: ChannelRow | null | undefined, row: RowAuthor): { owner: string; visibility: Visibility } {
  if (row.from_type === "agent" && row.from_id) return { owner: canonicalAgentID(row.from_id), visibility: botVisibility(db, row.from_id) };
  if (row.from_type === "user") return { owner: OWNER, visibility: strictestMember(db, channel) };
  return { owner: OWNER, visibility: MISSING_AGENT_VISIBILITY };
}

/**
 * The row's text as `callerAgentID` may read it. `redacted` is true when the caller gets a receipt; a
 * summary caller gets one line (`redacted` false, text shorter).
 */
export function redactRowForCaller(
  db: Database,
  channel: ChannelRow | null | undefined,
  row: RowAuthor,
  text: string,
  callerAgentID: string | null | undefined,
): RedactedText {
  // The owner's lines are the room's own. Another bot's line, even in a room the caller belongs to, is read through that
  // bot's visibility, which is how the group context (`groupHistory`) shows it: no reader shows a member more than that.
  if (row.from_type === "user" && isChannelParticipant(db, channel, callerAgentID)) return { text, redacted: false, mode: "shared" };
  const { owner, visibility } = rowAuthority(db, channel, row);
  return redactForCaller(text, owner, callerKey(callerAgentID), visibility);
}
