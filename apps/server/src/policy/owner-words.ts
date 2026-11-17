/**
 * What the owner actually typed, kept in its own table (migration 58) and never taken from the
 * thread's message rows or a session's log: those also hold a routine's prompt, a peer's brief, a
 * group-room block, a wake's text and a model's own words. The egress binding (policy/egress.ts) may
 * only treat a destination as named when it is in text written here.
 */
import type { Database } from "bun:sqlite";
import { nowISO } from "../util/ids";
import { redactForStorage } from "../util/redact-storage";

const MAX_STORED_CHARS = 8_000;
const MAX_READ_ROWS = 16;

/**
 * Record the owner's message for a thread. Called only for a turn the owner started. A key the owner pasted is masked first, then
 * the text is cut (a key that straddled the cut would otherwise be stored in part); the addresses and hosts the egress check looks
 * for are not secrets, so masking leaves them as they were written.
 */
export function recordOwnerWords(db: Database, threadID: string, text: string): void {
  const flat = redactForStorage(text.trim());
  if (!flat) return;
  db.run("INSERT INTO owner_words (thread_id, text, created_at) VALUES (?, ?, ?)", [threadID, flat.slice(0, MAX_STORED_CHARS), nowISO()]);
}

/** The owner's recent words in a thread, oldest first. */
export function ownerWordsOf(db: Database, threadID: string): string[] {
  return db
    .query<{ text: string }, [string, number]>("SELECT text FROM owner_words WHERE thread_id = ? ORDER BY id DESC LIMIT ?")
    .all(threadID, MAX_READ_ROWS)
    .map((row) => row.text)
    .reverse();
}
