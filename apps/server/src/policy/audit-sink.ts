/**
 * Where audit events go. The default sink drops them; Sprint 2 switches in the
 * real one at startup. Frozen shared interface: change it only through the tech lead.
 */
export interface AuditEvent {
  kind: string;
  actor?: string;
  turnID?: string;
  jobID?: string;
  detail: Record<string, unknown>;
}

export interface AuditSink {
  record(event: AuditEvent): void;
}

export const noopAuditSink: AuditSink = { record() {} };

let current: AuditSink = noopAuditSink;

export function setAuditSink(sink: AuditSink): void {
  current = sink;
}

export function audit(event: AuditEvent): void {
  current.record(event);
}
