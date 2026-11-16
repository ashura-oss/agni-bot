/**
 * While a new bot waits for its first name, the owner's next message in
 * #main may be the answer. Only a message that reads like a name is taken as
 * one: a question or a sentence is the owner talking to the bot, and must not
 * become its name (or be dropped when the rename fails).
 */
import { normalizeAgentName } from "../agent/identity";

const MAX_NAME_WORDS = 3;
const MAX_NAME_CHARS = 32;

export function looksLikeNameAnswer(text: string): boolean {
  // One line only: a pasted paragraph is not a name, even though a rename
  // would collapse its whitespace.
  if (/[\r\n]/.test(text.trim())) return false;
  const name = normalizeAgentName(text);
  if (!name || name.length > MAX_NAME_CHARS) return false;
  if (name.split(" ").length > MAX_NAME_WORDS) return false;
  return !/[?!]$/.test(name);
}
