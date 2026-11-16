/**
 * Approval and owner-question cards belong to the turn that raised them. When
 * the turn ends, any card still waiting is dead: nobody is listening for the
 * answer, so it is marked `expired` (a status the hello replay does not
 * re-send) and clients are told to remove it with `approval.closed`.
 */
import type { Database } from "bun:sqlite";
import type { ServerFrameBody } from "@agni/protocol";
import { nowISO } from "../util/ids";

export function expirePendingForTurn(
  db: Database,
  turnID: string,
  reason: "expired" | "cancelled",
  emit: (frame: ServerFrameBody) => void,
): void {
  const now = nowISO();
  const approvals = db.query<{ id: string }, [string]>(
    "SELECT id FROM approvals WHERE turn_id = ? AND status = 'pending' ORDER BY created_at",
  ).all(turnID);
  for (const { id } of approvals) {
    if (db.run("UPDATE approvals SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'pending'", [now, id]).changes === 0) continue;
    emit({ type: "approval.closed", requestID: id, kind: "approval", reason });
  }
  const forms = db.query<{ id: string }, [string]>(
    "SELECT id FROM forms WHERE turn_id = ? AND status = 'pending' ORDER BY created_at",
  ).all(turnID);
  for (const { id } of forms) {
    if (db.run("UPDATE forms SET status = 'expired', answered_at = ? WHERE id = ? AND status = 'pending'", [now, id]).changes === 0) continue;
    emit({ type: "approval.closed", requestID: id, kind: "form", reason });
  }
}
