/**
 * Approval and owner-question cards belong to the turn that raised them. When
 * the turn ends, any card still waiting is dead: nobody is listening for the
 * answer, so it is marked `expired` (a status the hello replay does not
 * re-send) and clients are told to remove it with `approval.closed`.
 */
import type { Database } from "bun:sqlite";
import { APPROVAL_SOURCE_KINDS, type ApprovalSource, type ServerFrameBody } from "@agni/protocol";
import { log } from "../log";
import { audit } from "../policy/audit-sink";
import { nowISO } from "../util/ids";

/**
 * How long any owner wait (an approval card or a question) lasts. Past this
 * nobody is coming: the card expires and the work goes on without the answer,
 * so a scheduled job cannot hold a worker forever. Matches the owner-wait
 * timeout of the `ask` tool.
 */
export const OWNER_WAIT_CEILING_MS = 600_000;

/** A background job has no one watching, so its cards wait longer (owner decision, 2026-11-16). */
export const BACKGROUND_OWNER_WAIT_MS = 1_800_000;

/** How long a card raised by a chat turn (false) or a background job (true) waits for the owner. */
export function ownerWaitMsFor(background: boolean): number {
  return background ? BACKGROUND_OWNER_WAIT_MS : OWNER_WAIT_CEILING_MS;
}

/** The time a card raised now stops waiting, as the `expiresAt` on `approval.request`. */
export function cardExpiresAt(background: boolean, from: number = Date.now()): string {
  return new Date(from + ownerWaitMsFor(background)).toISOString();
}

/**
 * What a card was raised with beyond its text: the untrusted input the run had read, how risky the call is,
 * when the card expires, and whether the preview hides part of the call. Saved with the card so a replay on
 * reconnect shows the same card.
 */
export interface CardMeta {
  source?: ApprovalSource[];
  tier?: 0 | 1 | 2 | 3;
  expiresAt?: string;
  truncated?: boolean;
  /** False when the card did not offer "always": a replay must not offer it either. */
  canRemember?: boolean;
}

export function saveCardMeta(db: Database, approvalID: string, meta: CardMeta): void {
  db.run("UPDATE approvals SET card_meta = ? WHERE id = ?", [JSON.stringify(meta), approvalID]);
}

/** The saved meta, field by field: whatever does not have the right shape is left out, never trusted. */
export function loadCardMeta(db: Database, approvalID: string): CardMeta | null {
  const row = db.query<{ card_meta: string | null }, [string]>("SELECT card_meta FROM approvals WHERE id = ?").get(approvalID);
  if (!row?.card_meta) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(row.card_meta);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const meta: CardMeta = {};
  if (Array.isArray(record.source)) {
    const source: ApprovalSource[] = [];
    for (const item of record.source) {
      if (typeof item !== "object" || item === null) continue;
      const { kind, label } = item as { kind?: unknown; label?: unknown };
      if (!APPROVAL_SOURCE_KINDS.some((known) => known === kind)) continue;
      source.push({ kind: kind as ApprovalSource["kind"], ...(typeof label === "string" ? { label: label.slice(0, 300) } : {}) });
    }
    if (source.length > 0) meta.source = source.slice(0, 20);
  }
  if (record.tier === 0 || record.tier === 1 || record.tier === 2 || record.tier === 3) meta.tier = record.tier;
  if (typeof record.expiresAt === "string") meta.expiresAt = record.expiresAt;
  if (typeof record.truncated === "boolean") meta.truncated = record.truncated;
  if (typeof record.canRemember === "boolean") meta.canRemember = record.canRemember;
  return Object.keys(meta).length > 0 ? meta : null;
}

/** Record that a waiting card ended without an answer. A failing log never keeps a dead card open. */
function auditClosed(kind: CardKind, id: string, reason: "expired" | "cancelled"): void {
  try {
    audit({ kind: `approval.${reason}`, actor: "system", detail: { requestID: id, kind, reason } });
  } catch (error) {
    log.warn("audit: could not record a closed card", error);
  }
}

type CardKind = "approval" | "form";

/** Expire one card if it is still pending, and tell clients to remove it. */
export function expireCard(
  db: Database,
  kind: CardKind,
  id: string,
  reason: "expired" | "cancelled",
  emit: (frame: ServerFrameBody) => void,
): void {
  const now = nowISO();
  const changed = kind === "approval"
    ? db.run("UPDATE approvals SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'pending'", [now, id]).changes
    : db.run("UPDATE forms SET status = 'expired', answered_at = ? WHERE id = ? AND status = 'pending'", [now, id]).changes;
  if (changed > 0) {
    auditClosed(kind, id, reason);
    emit({ type: "approval.closed", requestID: id, kind, reason });
  }
}

/** The pending approval card a tool call raised, expired. */
export function expireApprovalForCall(
  db: Database,
  turnID: string,
  callID: string,
  reason: "expired" | "cancelled",
  emit: (frame: ServerFrameBody) => void,
): void {
  const rows = db.query<{ id: string }, [string, string]>("SELECT id FROM approvals WHERE turn_id = ? AND call_id = ? AND status = 'pending'").all(turnID, callID);
  for (const { id } of rows) expireCard(db, "approval", id, reason, emit);
}

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
    auditClosed("approval", id, reason);
    emit({ type: "approval.closed", requestID: id, kind: "approval", reason });
  }
  const forms = db.query<{ id: string }, [string]>(
    "SELECT id FROM forms WHERE turn_id = ? AND status = 'pending' ORDER BY created_at",
  ).all(turnID);
  for (const { id } of forms) {
    if (db.run("UPDATE forms SET status = 'expired', answered_at = ? WHERE id = ? AND status = 'pending'", [now, id]).changes === 0) continue;
    auditClosed("form", id, reason);
    emit({ type: "approval.closed", requestID: id, kind: "form", reason });
  }
}
