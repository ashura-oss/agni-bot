/**
 * The one call every durable write of outside text goes through (Sprint 3 fix round 6).
 *
 * Text that comes from outside the server (an upstream server's answer, a provider's error body, an
 * exception message built from either) can echo back a secret the server sent it: a bearer token in an
 * `Authorization` header that a misbehaving server reflects in its 500 page, say. The frames and the log
 * mask such text on the way out (`ws/server.ts`, `log.ts`); this does the same before the text goes to a
 * database column or a file, so the plaintext is never in the database, its write-ahead log, a share page
 * or a backup of any of them.
 *
 * Use it on error text, tool and server output, and anything else the server did not write itself. Do not
 * use it on a value that is itself a secret being stored on purpose (a token column, a vault entry): that
 * would replace the secret with its own mask.
 */
import { redact } from "./redact";

/** `text` with every registered secret masked, ready to be written to disk. A missing value stays missing (`null`). */
export function redactForStorage(text: string): string;
export function redactForStorage(text: string | null | undefined): string | null;
export function redactForStorage(text: string | null | undefined): string | null {
  return text == null ? null : redact(text);
}
