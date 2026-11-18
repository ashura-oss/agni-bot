import { describe, expect, test } from "bun:test";
import { actualCostUsd, priceFor, SpendGuard, worstCaseUsd } from "../spend";
import type { CallRecord } from "../types";

const price = { inputPerM: 1, outputPerM: 4, known: true };

function call(over: Partial<CallRecord>): CallRecord {
  return {
    startedAt: "2026-11-18T00:00:00.000Z", startMs: 0, endMs: 1, path: "/api/v1/chat/completions", model: "m", hadTools: true, nMessages: 1,
    reqChars: 10, status: 200, blocked: false, aborted: false, firstMs: 5, finish: "stop", contentLen: 3, reasoningLen: 0, toolNames: [],
    cachedReported: false, chargedUsd: 0, ...over,
  };
}

describe("spend guard", () => {
  test("reservations within the cap pass; one that would pass the cap is refused and counted", () => {
    const guard = new SpendGuard(0.01);
    const a = guard.reserve(0.004);
    const b = guard.reserve(0.004);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(guard.reserve(0.004)).toBeNull();
    expect(guard.blockedCalls).toBe(1);
    expect(guard.remainingUsd()).toBeCloseTo(0.002, 10);
  });

  test("settling charges the actual cost, or the whole reservation when the cost is unknown", () => {
    const guard = new SpendGuard(1);
    const a = guard.reserve(0.5)!;
    expect(guard.settle(a, 0.01)).toBe(0.01);
    const b = guard.reserve(0.2)!;
    expect(guard.settle(b, null)).toBe(0.2);
    expect(guard.spentUsd).toBeCloseTo(0.21, 10);
    expect(guard.reservedUsd).toBe(0);
  });

  test("a ticket settles once", () => {
    const guard = new SpendGuard(1);
    const t = guard.reserve(0.1)!;
    guard.settle(t, 0.05);
    expect(() => guard.settle(t, 0.05)).toThrow("already settled");
  });

  test("a cap that is not a finite non-negative number is refused", () => {
    expect(() => new SpendGuard(Number.NaN)).toThrow();
    expect(() => new SpendGuard(-1)).toThrow();
    expect(() => new SpendGuard(Number.POSITIVE_INFINITY)).toThrow();
  });

  test("an unreadable worst case is refused", () => {
    const guard = new SpendGuard(1);
    expect(guard.reserve(Number.NaN)).toBeNull();
    expect(guard.blockedCalls).toBe(1);
  });
});

describe("pricing", () => {
  test("a listed model uses the server's price table; an unknown one the fallback", () => {
    expect(priceFor("deepseek/deepseek-v4.1-flash-1017")).toEqual({ inputPerM: 0.036, outputPerM: 0.5, known: true });
    expect(priceFor("qwen/qwen3.7-flash")).toEqual({ inputPerM: 0.2, outputPerM: 0.8, known: true });
    expect(priceFor("nobody/unknown-model")).toEqual({ inputPerM: 1, outputPerM: 4, known: false });
  });

  test("worst case is two characters per token plus the output limit", () => {
    // "[]" + "[]" is 4 characters: 2 tokens in.
    expect(worstCaseUsd({ messages: [], max_tokens: 1000 }, price)).toBeCloseTo((2 * 1 + 1000 * 4) / 1e6, 12);
    expect(worstCaseUsd({ messages: [], max_completion_tokens: 10 }, price)).toBeCloseTo((2 * 1 + 10 * 4) / 1e6, 12);
    // A chat request with no limit is assumed to produce 32,000 tokens.
    expect(worstCaseUsd({ messages: [] }, price)).toBeCloseTo((2 * 1 + 32_000 * 4) / 1e6, 12);
  });

  test("actual cost prefers the provider's figure, then tokens, else unknown", () => {
    expect(actualCostUsd(call({ reportedCostUsd: 0.002, promptTokens: 1000, completionTokens: 1000 }), price)).toBe(0.002);
    expect(actualCostUsd(call({ promptTokens: 1000, completionTokens: 500 }), price)).toBeCloseTo((1000 + 2000) / 1e6, 12);
    expect(actualCostUsd(call({}), price)).toBeNull();
  });
});
