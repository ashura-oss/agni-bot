/**
 * While a new bot waits for its first name, the owner's next message in
 * #main may be the answer. Only a message that reads like a name is taken as
 * one: a question or a sentence is the owner talking to the bot, and must not
 * become its name (or be dropped when the rename fails). A greeting ("hi",
 * "thanks"), a request ("plan my week", "call me Agni") and the product name are
 * not names either.
 */
import { normalizeAgentName } from "../agent/identity";

const MAX_NAME_WORDS = 3;
const MAX_NAME_CHARS = 32;

/** The owner starting a chat, not naming the bot. Compared lower-case, without punctuation. */
const GREETINGS = new Set([
  "hi", "hello", "hey", "hiya", "yo", "howdy", "thanks", "thank you", "thx", "ty", "ok", "okay", "k", "yes", "yeah", "yep",
  "no", "nope", "sure", "cool", "great", "nice", "fine", "please", "help", "good morning", "good afternoon",
  "good evening", "good night", "hi there", "hello there", "hey there", "whats up", "sup",
]);

/** A message that opens with one of these is a request to the bot, not a name. */
const IMPERATIVES = new Set([
  "plan", "summarize", "summarise", "write", "find", "call", "tell", "show", "help", "check", "make", "send", "schedule",
  "remind", "search", "read", "create", "list", "give", "get", "draft", "explain", "open", "add", "set", "do", "run",
  "look", "ask", "let", "can", "could", "would", "please", "update", "fix", "build", "review", "translate", "calculate",
  "compare", "analyze", "analyse", "buy", "delete", "remove", "start", "stop", "tell",
]);

/** The product name: a bot is never named after it. */
const PRODUCT_NAMES = new Set(["agni", "agni bot"]);

const plain = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();

export function looksLikeNameAnswer(text: string): boolean {
  // One line only: a pasted paragraph is not a name, even though a rename
  // would collapse its whitespace.
  if (/[\r\n]/.test(text.trim())) return false;
  const name = normalizeAgentName(text);
  if (!name || name.length > MAX_NAME_CHARS) return false;
  if (name.split(" ").length > MAX_NAME_WORDS) return false;
  if (/[?!]$/.test(name)) return false;
  const words = plain(name);
  if (!words || GREETINGS.has(words) || PRODUCT_NAMES.has(words)) return false;
  return !IMPERATIVES.has(words.split(" ")[0]!);
}
