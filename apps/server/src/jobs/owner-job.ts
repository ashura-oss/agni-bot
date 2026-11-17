/**
 * The payload of a turn job the owner makes themselves (`agni job add`), as opposed to one a bot makes with `job_schedule`.
 *
 * It carries the positive marker that starts a chain the owner began (`policy/provenance.ts`). Without it a job's fire is not shown to be
 * the owner's: an owner job made before the marker existed is treated as a bot's, and asks before it schedules a follow-up.
 */
import { OWNER_STARTED } from "../policy/provenance";
import type { TurnJobPayload } from "./turn";

export function ownerJobPayload(fields: { text: string; threadID?: string; agentID?: string; notify?: boolean; everyMs?: number | null }): TurnJobPayload {
  return {
    text: fields.text,
    ...(fields.threadID ? { threadID: fields.threadID } : {}),
    ...(fields.agentID ? { agentID: fields.agentID } : {}),
    notify: fields.notify !== false,
    ...(fields.everyMs ? { everyMs: fields.everyMs } : {}),
    provenance: { ...OWNER_STARTED },
  };
}
