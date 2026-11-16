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

/**
 * Send an event to the current sink. Errors the sink throws propagate to the
 * caller (fail closed): a caller that must not lose its audit row lets the
 * failure stop the action; one that can carry on catches it.
 */
export function audit(event: AuditEvent): void {
  current.record(event);
}
