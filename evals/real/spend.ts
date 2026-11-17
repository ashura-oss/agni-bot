/**
 * The hard per-run spend cap (Sprint 5 budget table).
 *
 * The eval proxy reserves a call's worst-case cost BEFORE it sends the call,
 * and refuses the call when that reservation would pass the cap. When the
 * call ends, the reservation is replaced by what the call really cost: the
 * provider's own figure, else its tokens at the price table. A call that ends
 * with no cost and no token counts is charged its whole reservation, so an
 * unknown cost can only make the guard stricter.
 */
import { FALLBACK_PRICE, findPrice } from "../../apps/server/src/models/prices";
import type { CallRecord } from "./types";

/** Output tokens assumed when a chat request names no limit. */
export const ASSUMED_MAX_OUTPUT_TOKENS = 32_000;

export interface Ticket {
  readonly id: number;
  readonly worstUsd: number;
}

export class SpendGuard {
  readonly capUsd: number;
  /** Calls the guard refused. */
  blockedCalls = 0;
  private spent = 0;
  private readonly reserved = new Map<number, number>();
  private nextId = 1;

  constructor(capUsd: number) {
    if (!Number.isFinite(capUsd) || capUsd < 0) throw new Error(`the spend cap must be a finite number of dollars, 0 or more (got ${capUsd})`);
    this.capUsd = capUsd;
  }

  get spentUsd(): number {
    return this.spent;
  }

  get reservedUsd(): number {
    let sum = 0;
    for (const value of this.reserved.values()) sum += value;
    return sum;
  }

  remainingUsd(): number {
    return Math.max(0, this.capUsd - this.spent - this.reservedUsd);
  }

  /** Reserve a call's worst case before it is sent. Null (and the call must not be sent) when the cap would be passed. */
  reserve(worstUsd: number): Ticket | null {
    if (!Number.isFinite(worstUsd) || worstUsd < 0 || this.spent + this.reservedUsd + worstUsd > this.capUsd) {
      this.blockedCalls++;
      return null;
    }
    const id = this.nextId++;
    this.reserved.set(id, worstUsd);
    return { id, worstUsd };
  }

  /** Close a reservation with what the call cost. Null (unknown) charges the whole reservation. Returns the charge. */
  settle(ticket: Ticket, actualUsd: number | null): number {
    if (!this.reserved.delete(ticket.id)) throw new Error(`spend ticket ${ticket.id} was already settled`);
    const charge = actualUsd === null || !Number.isFinite(actualUsd) || actualUsd < 0 ? ticket.worstUsd : actualUsd;
    this.spent += charge;
    return charge;
  }
}

export interface PriceInfo {
  inputPerM: number;
  outputPerM: number;
  /** False when the model has no entry and the server's fallback price is used. */
  known: boolean;
}

/** The server's OpenRouter price for a model, at its most expensive tier; the fallback price when it has none. */
export function priceFor(model: string): PriceInfo {
  const price = findPrice("openrouter", model);
  if (!price) return { inputPerM: FALLBACK_PRICE.inputPerM, outputPerM: FALLBACK_PRICE.outputPerM, known: false };
  const tiers = price.tiers ?? [];
  return {
    inputPerM: Math.max(price.inputPerM, ...tiers.map((t) => t.inputPerM)),
    outputPerM: Math.max(price.outputPerM, ...tiers.map((t) => t.outputPerM)),
    known: true,
  };
}

/**
 * The most a request can cost: its text at two characters per token (an
 * over-count on purpose) plus its output limit, or `ASSUMED_MAX_OUTPUT_TOKENS`
 * for a chat request that names none.
 */
export function worstCaseUsd(body: Record<string, unknown>, price: PriceInfo): number {
  const text = JSON.stringify(body.messages ?? body.input ?? "") + JSON.stringify(body.tools ?? []);
  const inputTokens = Math.ceil(text.length / 2);
  const outputTokens =
    typeof body.max_completion_tokens === "number"
      ? body.max_completion_tokens
      : typeof body.max_tokens === "number"
        ? body.max_tokens
        : body.messages !== undefined
          ? ASSUMED_MAX_OUTPUT_TOKENS
          : 0;
  return (inputTokens * price.inputPerM + outputTokens * price.outputPerM) / 1_000_000;
}

/** What a finished call cost: the provider's figure, else its tokens at `price`, else null (unknown). */
export function actualCostUsd(rec: CallRecord, price: PriceInfo): number | null {
  if (typeof rec.reportedCostUsd === "number") return rec.reportedCostUsd;
  if (typeof rec.promptTokens === "number" && typeof rec.completionTokens === "number") {
    return (rec.promptTokens * price.inputPerM + rec.completionTokens * price.outputPerM) / 1_000_000;
  }
  return null;
}
