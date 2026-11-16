/**
 * Secret redaction. A stub for now: Sprint 3 implements it. Callers use these
 * two names today so the behaviour can change without touching them.
 * Frozen shared signatures: change them only through the tech lead.
 */

/** Return `text` with registered secrets masked. Currently returns it unchanged. */
export function redact(text: string): string {
  return text;
}

/** Remember a secret value so `redact` masks it. Currently does nothing. */
export function registerSecret(_value: string): void {}
