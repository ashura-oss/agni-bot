/**
 * The wake limit (S2-09, fix round D). A delegated task that finishes wakes the bot that delegated it, and that bot may
 * delegate again, so a chain of delegate, wake, delegate has no end in time: each wake starts a clock of its own. It is
 * bounded by count instead: a request (the scope the owner's refusals hold in: `denialScope`) gets at most
 * `maxWakesPerRequest` wakes that run a model turn. The next one is not run; its results are posted to the parent's
 * conversation as a plain notice, which names the tasks and says the limit was reached (it carries none of their text).
 *
 * A wake job counts once, when it is first allowed to run (`wakeCounted` in its payload), so a retry of it is not
 * counted again or refused.
 */
import type { Database } from "bun:sqlite";
import type { ServerFrameBody } from "@agni/protocol";
import { appendChannelMessage } from "../stores/channels";
import { appendMessage } from "../stores/threads";
import { getRunCaps } from "../stores/policy-settings";
import type { JobRow } from "../stores/jobs";

interface WakePayload {
  threadID?: string;
  rootTurnID?: string;
  rootJob?: string | null;
  wakeCounted?: boolean;
}

/** `denialScope` for a wake: the root job, else the root turn; a wake that names neither is counted by its parent thread. */
const SCOPE_SQL = "COALESCE(json_extract(payload, '$.rootJob'), json_extract(payload, '$.rootTurnID'), 'unrooted:' || COALESCE(json_extract(payload, '$.threadID'), ''))";

function scopeOf(payload: WakePayload): string {
  return payload.rootJob || payload.rootTurnID || `unrooted:${payload.threadID ?? ""}`;
}

/**
 * May this wake run a model turn? Counts it against its request when it may. Nothing awaits between the count and the
 * mark, and both are one transaction, so two wakes cannot both take the last place.
 */
export function takeWakePlace(db: Database, job: JobRow, payload: WakePayload): { ok: true } | { ok: false; limit: number } {
  if (payload.wakeCounted) return { ok: true };
  const limit = getRunCaps(db).maxWakesPerRequest;
  return db.transaction((): { ok: true } | { ok: false; limit: number } => {
    const used = db
      .query<{ n: number }, [string, string]>(
        `SELECT COUNT(*) AS n FROM jobs
         WHERE kind = 'turn' AND id != ? AND json_extract(payload, '$.wakeKey') IS NOT NULL
           AND json_extract(payload, '$.wakeCounted') = 1 AND ${SCOPE_SQL} = ?`,
      )
      .get(job.id, scopeOf(payload))?.n ?? 0;
    if (used >= limit) return { ok: false, limit };
    db.run("UPDATE jobs SET payload = json_set(payload, '$.wakeCounted', json('true')) WHERE id = ?", [job.id]);
    return { ok: true };
  }).immediate();
}

/** What the owner is told in place of a wake that was not run. Names the tasks; carries none of their text. */
export function wakeLimitNotice(botName: string, limit: number, taskIDs: string[]): string {
  const tasks = taskIDs.length === 1 ? `task ${taskIDs[0]}` : `${taskIDs.length} tasks (${taskIDs.join(", ")})`;
  return `This request reached its wake limit of ${limit}, so ${botName} was not woken for the result of ${tasks}. The result is kept with the task. Ask ${botName} to check on it, or change the limit with agni policy caps set --wakes N.`;
}

/** Post the notice to the parent's thread, and to the channel the owner reads, when the wake names one. */
export function postWakeLimitNotice(
  db: Database,
  emit: (frame: ServerFrameBody) => void,
  params: { threadID: string | undefined; channelID: string | undefined; agentID: string; text: string },
): void {
  if (params.threadID) appendMessage(db, { threadID: params.threadID, role: "system", text: params.text });
  if (!params.channelID) return;
  const row = appendChannelMessage(db, { channelID: params.channelID, fromType: "system", fromID: params.agentID, text: params.text, uiHint: "normal" });
  emit({ type: "msg.new", id: row.id, channelId: params.channelID, fromType: "system", fromId: params.agentID, senderName: params.agentID, text: params.text, internal: false, uiHint: "normal", createdAt: row.created_at });
}
