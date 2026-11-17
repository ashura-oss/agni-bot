/**
 * Transcript search (MEM-003).
 *
 * The channel messages are the durable transcript: what was said, in which
 * conversation. FTS5 finds them; the caller's visibility decides which
 * channels it may see. Each hit is read through the bot that wrote it
 * (`redactRowForCaller`): a private bot's line is never a hit for a bot that is
 * not in the room, a summary bot's line comes back as one line, and a line
 * whose author cannot be resolved is not a hit. A bot in the room reads it all.
 */
import type { Database } from "bun:sqlite";
import { toMatchQuery } from "./agent-memories";
import { redactRowForCaller } from "../agent/channel-visibility";
import { getChannel } from "./channels";

export interface TranscriptHit {
  id: string;
  channelID: string;
  /** The agent that owns the channel. */
  agentID: string | null;
  fromType: string;
  fromID: string;
  text: string;
  createdAt: string;
  /** 0..1 — higher is a better match. */
  score: number;
}

export function searchTranscripts(
  db: Database,
  input: {
    query: string;
    /** The agent asking. With no caller, a hit is read as a stranger would read it. */
    callerAgentID?: string | null;
    limit?: number;
  },
): TranscriptHit[] {
  const query = input.query.trim();
  if (!query) return [];
  const limit = Math.min(50, Math.max(1, Math.floor(input.limit ?? 10)));
  // Rows that may not be shown are dropped after the match, so the search reads more than it returns.
  const fetchLimit = limit * 5;
  // Precision first, then recall: a paraphrase still finds the message.
  for (const mode of ["and", "or"] as const) {
    const params: (string | number)[] = [toMatchQuery(query, mode), fetchLimit];
    let rows: Array<{
      id: string;
      channel_id: string;
      agent_id: string | null;
      from_type: string;
      from_id: string;
      text: string;
      created_at: string;
      rank: number;
    }>;
    try {
      rows = db
        .query<
          {
            id: string;
            channel_id: string;
            agent_id: string | null;
            from_type: string;
            from_id: string;
            text: string;
            created_at: string;
            rank: number;
          },
          (string | number)[]
        >(
          `SELECT cm.id AS id, cm.channel_id AS channel_id, c.agent_id AS agent_id,
                  cm.from_type AS from_type, cm.from_id AS from_id, cm.text AS text,
                  cm.created_at AS created_at, bm25(channel_messages_fts) AS rank
           FROM channel_messages_fts
           JOIN channel_messages cm ON cm.rowid = channel_messages_fts.rowid
           LEFT JOIN channels c ON c.id = cm.channel_id
           WHERE channel_messages_fts MATCH ?
           ORDER BY rank ASC
           LIMIT ?`,
        )
        .all(...params);
    } catch {
      return [];
    }
    if (rows.length === 0) continue;
    const channels = new Map<string, ReturnType<typeof getChannel>>();
    const hits: TranscriptHit[] = [];
    for (const row of rows) {
      if (!channels.has(row.channel_id)) channels.set(row.channel_id, getChannel(db, row.channel_id));
      const view = redactRowForCaller(db, channels.get(row.channel_id), row, row.text, input.callerAgentID);
      if (view.text === null) continue;
      // bm25() is negative and more negative is better, so the magnitude is the
      // relevance. s / (1 + s) maps it into 0..1, rising with s.
      const s = Math.max(0, -row.rank);
      hits.push({
        id: row.id,
        channelID: row.channel_id,
        agentID: row.agent_id,
        fromType: row.from_type,
        fromID: row.from_id,
        text: view.text,
        createdAt: row.created_at,
        score: s / (1 + s),
      });
      if (hits.length === limit) break;
    }
    if (hits.length > 0) return hits;
  }
  return [];
}
