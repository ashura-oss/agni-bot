/**
 * The buttons a replayed approval card offers.
 *
 * The broker offers "always" only when the call can be remembered: its turn
 * has a bot, and `approvalTarget` finds a target for the arguments. A card
 * replayed on reconnect must offer the same buttons, never more, so it works
 * the call out again from the stored tool call. When that cannot be done (no
 * stored call, unreadable arguments) it offers the safe pair, without
 * "always": a card must never gain a standing-rule button it did not have.
 */
import type { Database } from "bun:sqlite";
import { agentForTurn, approvalTarget } from "../stores/approval-rules";

export type ReplayButtons = Array<"once" | "always" | "reject">;

export function replayButtons(
  db: Database,
  approval: { thread_id: string | null; turn_id: string | null; call_id: string | null; tool_name: string | null },
): ReplayButtons {
  const safe: ReplayButtons = ["once", "reject"];
  if (!approval.thread_id || !approval.turn_id || !approval.call_id || !approval.tool_name) return safe;
  const call = db
    .query<{ args: string }, [string, string]>("SELECT args FROM tool_calls WHERE turn_id = ? AND call_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(approval.turn_id, approval.call_id);
  if (!call) return safe;
  let args: unknown;
  try {
    args = JSON.parse(call.args);
  } catch {
    return safe;
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) return safe;
  const agentID = agentForTurn(db, approval.thread_id, approval.turn_id);
  const target = approvalTarget(approval.tool_name, args as Record<string, unknown>);
  return agentID && target !== null ? ["once", "always", "reject"] : safe;
}
