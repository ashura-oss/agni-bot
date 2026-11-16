/**
 * Model prices, in US dollars per million tokens, with where each number came
 * from and when. The ledger turns token counts into cost with this table.
 *
 * Prices drift and differ by route, so an entry is a dated snapshot, not a
 * promise. The accuracy check (ledger total against the provider's own reported
 * cost) is how drift is caught. A model that is not here has an unknown cost:
 * `computeCostUsd` returns null and warns once. It never returns zero for a
 * model it cannot price, because zero would let spend caps wave it through.
 *
 * Token accounting: `inputTokens` is the provider's prompt token count, which
 * includes the cached part (OpenAI-compatible `prompt_tokens`). Cached tokens
 * are billed at the cached rate, the rest at the input rate. Reasoning tokens
 * are already inside the output count.
 */
import { log } from "../log";
import type { ModelUsageEvent } from "./usage-hook";

/**
 * The usage event as the router really sends it: the frozen `ModelUsageEvent`
 * plus the cost the provider reported for the call, when it reported one. Kept
 * here so the frozen interface is untouched; a recorder that ignores the extra
 * field behaves as before.
 */
export interface PricedUsageEvent extends ModelUsageEvent {
  reportedCostUsd?: number;
  /** The tokens are the router's estimate of a call that failed part-way, not the provider's count. */
  estimated?: boolean;
}

/** A higher price that applies once the prompt reaches `minPromptTokens` (whole request). */
export interface PriceTier {
  minPromptTokens: number;
  inputPerM: number;
  cachedInputPerM: number;
  outputPerM: number;
}

export interface ModelPrice {
  provider: string;
  model: string;
  inputPerM: number;
  cachedInputPerM: number;
  outputPerM: number;
  tiers?: PriceTier[];
  /** Day the numbers were read (YYYY-MM-DD). */
  sourceDate: string;
  /** Where they were read. */
  source: string;
}

const OPENROUTER_LIST = "openrouter.ai/api/v1/models";
const OPENROUTER_DATE = "2026-11-16";

/** Listed OpenRouter prices. OpenRouter bills the upstream endpoint it routes to; see the accuracy check. */
const openrouter = (model: string, inputPerM: number, cachedInputPerM: number, outputPerM: number, tiers?: PriceTier[]): ModelPrice => ({
  provider: "openrouter",
  model,
  inputPerM,
  cachedInputPerM,
  outputPerM,
  ...(tiers ? { tiers } : {}),
  sourceDate: OPENROUTER_DATE,
  source: OPENROUTER_LIST,
});

export const PRICES: ModelPrice[] = [
  openrouter("deepseek/deepseek-v4.1-flash-1017", 0.036, 0.01, 0.5),
  openrouter("qwen/qwen3.8-flash", 0.15, 0.016, 0.47),
  openrouter("qwen/qwen3.7-flash", 0.03, 0.006, 0.13, [
    { minPromptTokens: 32_000, inputPerM: 0.1, cachedInputPerM: 0.02, outputPerM: 0.4 },
    { minPromptTokens: 256_000, inputPerM: 0.2, cachedInputPerM: 0.04, outputPerM: 0.8 },
  ]),
  openrouter("z-ai/glm-5.3-flash", 0.0399, 0.03, 0.0784),
  openrouter("openai/gpt-6-luna", 0.1, 0.01, 0.5, [
    { minPromptTokens: 272_000, inputPerM: 0.2, cachedInputPerM: 0.02, outputPerM: 0.75 },
  ]),
];

const FREE: Pick<ModelPrice, "inputPerM" | "cachedInputPerM" | "outputPerM"> = { inputPerM: 0, cachedInputPerM: 0, outputPerM: 0 };

/**
 * Find the price for a provider and model.
 *  - exact provider + model entry;
 *  - a local model server (`lmstudio`) and OpenRouter `:free` models cost nothing, on purpose;
 *  - a `vendor/model` slug on any other provider id is an OpenRouter-style name, so the OpenRouter entry applies.
 * Anything else is unknown (null).
 */
export function findPrice(provider: string, model: string): ModelPrice | null {
  const exact = PRICES.find((entry) => entry.provider === provider && entry.model === model);
  if (exact) return exact;
  if (provider === "lmstudio") {
    return { provider, model, ...FREE, sourceDate: OPENROUTER_DATE, source: "local model server, no per-token cost" };
  }
  if (model.endsWith(":free")) {
    return { provider, model, ...FREE, sourceDate: OPENROUTER_DATE, source: "free-tier model id (:free suffix)" };
  }
  if (model.includes("/")) {
    return PRICES.find((entry) => entry.provider === "openrouter" && entry.model === model) ?? null;
  }
  return null;
}

export interface CostInput {
  provider: string;
  model: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

const warned = new Set<string>();

/** Forget which unknown models were already warned about (tests). */
export function resetPriceWarnings(): void {
  warned.clear();
}

/**
 * What an unpriced model is charged when its token counts are known: well above
 * the whole working set (the dearest there is $0.50 per million out), so caps
 * still advance and err on the side of stopping early. Dollars per million tokens.
 */
export const FALLBACK_PRICE = { inputPerM: 1, cachedInputPerM: 1, outputPerM: 4 } as const;

/** How the cost of a call was worked out: from the table, or from the fallback price for an unpriced model. */
export interface PricedCall {
  costUsd: number | null;
  source: "table" | "fallback" | null;
}

/**
 * Rough token count of a text, never low for Chinese: one token per non-ASCII
 * character, one per four ASCII characters. Used only where the provider did
 * not say (a stream that failed part-way).
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const char of text) (char.codePointAt(0)! < 128 ? ascii++ : other++);
  return Math.ceil(ascii / 4) + other;
}

/**
 * Price one call. An unpriced model with token counts is charged `FALLBACK_PRICE`
 * (and warned about once); with no token counts and no price the cost is
 * unknown (null). A free or local model costs 0 whatever the counts.
 */
export function priceCall(input: CostInput, warn: (message: string) => void = (m) => log.warn(m)): PricedCall {
  const price = findPrice(input.provider, input.model);
  const known = input.inputTokens !== undefined || input.outputTokens !== undefined;
  if (price && price.inputPerM === 0 && price.cachedInputPerM === 0 && price.outputPerM === 0 && !price.tiers) {
    return { costUsd: 0, source: "table" };
  }
  if (!price) {
    const key = `${input.provider}|${input.model}`;
    if (!warned.has(key)) {
      warned.add(key);
      warn(`no price for model "${input.model}" on provider "${input.provider}": charged the fallback price of $${FALLBACK_PRICE.inputPerM} in / $${FALLBACK_PRICE.outputPerM} out per million tokens`);
    }
  }
  if (!known) return { costUsd: null, source: null };
  const prompt = Math.max(0, input.inputTokens ?? 0);
  const output = Math.max(0, input.outputTokens ?? 0);
  const cached = Math.min(prompt, Math.max(0, input.cachedInputTokens ?? 0));
  const rate = price ? rateFor(price, prompt) : FALLBACK_PRICE;
  return {
    costUsd: ((prompt - cached) * rate.inputPerM + cached * rate.cachedInputPerM + output * rate.outputPerM) / 1e6,
    source: price ? "table" : "fallback",
  };
}

/** Cost of one call in US dollars, or null when the token counts are unknown and the model is not free. */
export function computeCostUsd(input: CostInput, warn?: (message: string) => void): number | null {
  return priceCall(input, warn).costUsd;
}

function rateFor(price: ModelPrice, promptTokens: number): Pick<ModelPrice, "inputPerM" | "cachedInputPerM" | "outputPerM"> {
  let rate: Pick<ModelPrice, "inputPerM" | "cachedInputPerM" | "outputPerM"> = price;
  let floor = -1;
  for (const tier of price.tiers ?? []) {
    if (promptTokens >= tier.minPromptTokens && tier.minPromptTokens > floor) {
      rate = tier;
      floor = tier.minPromptTokens;
    }
  }
  return rate;
}
