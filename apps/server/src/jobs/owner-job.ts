/**
 * The payload of a turn job the owner makes themselves (`agni job add`), as opposed to one a bot makes with `job_schedule`.
 *
 * It starts a chain the owner began: `ownerOnly` is the bit only a front door that knows may set (`policy/carry.ts`). Without it a job's fire is
 * not shown to be the owner's: an owner job made before the bit existed is stamped by migration 65 only when its shape proves it (no thread and an agent cannot be told from a bot's), and any other without it is treated as a bot's
 * and asks before it schedules a follow-up. It says what it had read as well: nothing, because the owner wrote it.
 */
import type { TurnJobPayload } from "./turn";

export function ownerJobPayload(fields: { text: string; threadID?: string; agentID?: string; notify?: boolean; everyMs?: number | null }): TurnJobPayload {
  return {
    text: fields.text,
    ...(fields.threadID ? { threadID: fields.threadID } : {}),
    ...(fields.agentID ? { agentID: fields.agentID } : {}),
    notify: fields.notify !== false,
    ...(fields.everyMs ? { everyMs: fields.everyMs } : {}),
    ownerOnly: true,
  };
}
