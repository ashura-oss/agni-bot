/**
 * The wake limit (S2-09, fix round D). A delegated task that finishes wakes the bot that delegated it, and that bot may
 * delegate again, so a chain of delegate, wake, delegate has no end in time: each wake starts a clock of its own. It is
 * bounded by count instead: a request (one run: `wakeScope`) gets at most
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

/**
 * The request a wake is counted in: the run it came from. The root turn is set once, when the run's first turn starts, and a
 * wake, a delegated child and a resumed task all carry it, so it names the run. The root job alone does not: it is the same
 * for every scheduled run of a recurring job, so a daily routine that delegates would lose its wakes for good after the
 * tenth. Together they name one run of one job, or (no root job) one chat request. A wake that names no root is counted by
 * its parent thread.
 */
export function wakeScope(payload: Pick<WakePayload, "rootTurnID" | "rootJob" | "threadID">): string {
  if (!payload.rootTurnID) return `unrooted:${payload.threadID ?? ""}`;
  return payload.rootJob ? `${payload.rootJob}@${payload.rootTurnID}` : payload.rootTurnID;
}

/** How many wakes of one request ran a model turn so far: `?1` is the request's scope, `?2` this job's own id. `jobs.wake_scope` is set when a wake is counted, and indexed. */
export const WAKE_COUNT_SQL = "SELECT COUNT(*) AS n FROM jobs WHERE wake_scope = ?1 AND id != ?2";

/**
 * May this wake run a model turn? Counts it against its request when it may. Nothing awaits between the count and the
 * mark, and both are one transaction, so two wakes cannot both take the last place.
 */
export function takeWakePlace(db: Database, job: JobRow, payload: WakePayload): { ok: true } | { ok: false; limit: number } {
  if (payload.wakeCounted) return { ok: true };
  const limit = getRunCaps(db).maxWakesPerRequest;
  return db.transaction((): { ok: true } | { ok: false; limit: number } => {
    const used = db.query<{ n: number }, [string, string]>(WAKE_COUNT_SQL).get(wakeScope(payload), job.id)?.n ?? 0;
    if (used >= limit) return { ok: false, limit };
    db.run("UPDATE jobs SET payload = json_set(payload, '$.wakeCounted', json('true')), wake_scope = ? WHERE id = ?", [wakeScope(payload), job.id]);
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
