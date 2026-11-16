/**
 * Limits for the auxiliary model calls — the block summary, the tagger and
 * the channel compactor (S1-17).
 *
 * These run in the background, never on the path of a chat turn, so they can
 * afford room. They have to: a reasoning model spends output tokens thinking
 * before it writes, and `max_tokens` covers both. At 1,500 the thinking used
 * the whole budget and the answer came back empty (round 5, qwen3.7).
 *
 * Providers cap `max_tokens` themselves; 8,192 is within what the providers
 * this app targets accept for output. A cheaper model that does not think
 * uses a few hundred of it, and the cap costs nothing unused.
 */

/** Output budget (answer plus reasoning) for one auxiliary call. */
export const AUX_MAX_TOKENS = 8_192;

/**
 * Whole-call deadline for a background auxiliary call: 8,192 tokens at a slow
 * model's ~70 tokens/s is about two minutes.
 */
export const AUX_TIMEOUT_MS = 120_000;

/**
 * The stall window: no token (reasoning counts when the provider streams it)
 * for this long ends the attempt. The turn default is also 30 s; the old
 * tagger (10 s) and compactor (8 s) windows were shorter than a reasoning
 * model's silence before its first token.
 */
export const AUX_FIRST_TOKEN_MS = 30_000;

/**
 * How long the owner's `/new` waits for the summary before it carries the
 * previous one forward. The queued job finishes the summary in the
 * background with the full AUX_TIMEOUT_MS.
 */
export const NEW_COMMAND_SUMMARY_WAIT_MS = 30_000;
