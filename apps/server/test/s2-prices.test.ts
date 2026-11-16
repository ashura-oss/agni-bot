import { beforeEach, describe, expect, test } from "bun:test";
import { PRICES, computeCostUsd, findPrice, resetPriceWarnings } from "../src/models/prices";

beforeEach(() => resetPriceWarnings());

const WORKING_SET = [
  "deepseek/deepseek-v4.1-flash-1017",
  "qwen/qwen3.8-flash",
  "qwen/qwen3.7-flash",
  "z-ai/glm-5.3-flash",
  "openai/gpt-6-luna",
];

describe("price table", () => {
  test("every working-set model has input, cached input, output and a source date", () => {
    for (const model of WORKING_SET) {
      const price = findPrice("openrouter", model);
      expect(price, model).not.toBeNull();
      expect(price!.inputPerM).toBeGreaterThan(0);
      expect(price!.cachedInputPerM).toBeGreaterThan(0);
      expect(price!.cachedInputPerM).toBeLessThanOrEqual(price!.inputPerM);
      expect(price!.outputPerM).toBeGreaterThan(0);
      expect(price!.sourceDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(price!.source.length).toBeGreaterThan(0);
    }
  });

  test("every entry is well formed", () => {
    for (const entry of PRICES) {
      expect(entry.sourceDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.inputPerM).toBeGreaterThanOrEqual(0);
      expect(entry.outputPerM).toBeGreaterThanOrEqual(0);
    }
  });

  test("the default worker prices match the published per-million figures", () => {
    const price = findPrice("openrouter", "deepseek/deepseek-v4.1-flash-1017")!;
    expect(price.inputPerM).toBeCloseTo(0.036, 6);
    expect(price.cachedInputPerM).toBeCloseTo(0.01, 6);
    expect(price.outputPerM).toBeCloseTo(0.5, 6);
  });
});

describe("computeCostUsd", () => {
  test("input, cached input and output are priced separately; cached tokens are part of the input count", () => {
    const cost = computeCostUsd({
      provider: "openrouter", model: "deepseek/deepseek-v4.1-flash-1017",
      inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 100_000,
    });
    // uncached 600k x $0.036/M + cached 400k x $0.01/M + output 100k x $0.5/M
    expect(cost).toBeCloseTo(0.0216 + 0.004 + 0.05, 9);
  });

  test("no cached count means everything is billed as uncached input", () => {
    const cost = computeCostUsd({ provider: "openrouter", model: "qwen/qwen3.8-flash", inputTokens: 1000, outputTokens: 500 });
    expect(cost).toBeCloseTo(1000 * 0.15 / 1e6 + 500 * 0.47 / 1e6, 12);
  });

  test("cached tokens above the input count cannot make the cost negative", () => {
    const cost = computeCostUsd({ provider: "openrouter", model: "qwen/qwen3.8-flash", inputTokens: 100, cachedInputTokens: 500, outputTokens: 0 });
    expect(cost).toBeGreaterThanOrEqual(0);
  });

  test("a long prompt moves to the higher tier where the provider has one", () => {
    const short = computeCostUsd({ provider: "openrouter", model: "qwen/qwen3.7-flash", inputTokens: 10_000, outputTokens: 1_000 })!;
    const long = computeCostUsd({ provider: "openrouter", model: "qwen/qwen3.7-flash", inputTokens: 40_000, outputTokens: 1_000 })!;
    expect(short).toBeCloseTo(10_000 * 0.03 / 1e6 + 1_000 * 0.13 / 1e6, 12);
    expect(long).toBeCloseTo(40_000 * 0.1 / 1e6 + 1_000 * 0.4 / 1e6, 12);
  });

  test("an unknown model is null, never zero, and warns once", () => {
    const warnings: string[] = [];
    const cost = computeCostUsd({ provider: "openrouter", model: "nobody/never-heard-of-it", inputTokens: 10, outputTokens: 10 }, (m) => warnings.push(m));
    expect(cost).toBeNull();
    computeCostUsd({ provider: "openrouter", model: "nobody/never-heard-of-it", inputTokens: 10, outputTokens: 10 }, (m) => warnings.push(m));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("nobody/never-heard-of-it");
  });

  test("a provider that reported no token counts gives null, not zero", () => {
    expect(computeCostUsd({ provider: "openrouter", model: "qwen/qwen3.8-flash" })).toBeNull();
  });

  test("a local model costs zero and a :free model costs zero, on purpose", () => {
    expect(computeCostUsd({ provider: "lmstudio", model: "whatever-is-loaded", inputTokens: 100, outputTokens: 100 })).toBe(0);
    expect(computeCostUsd({ provider: "openrouter", model: "meta-llama/llama-3.3-70b-instruct:free", inputTokens: 100, outputTokens: 100 })).toBe(0);
  });

  test("a vendor/model slug on a custom provider id falls back to the OpenRouter price", () => {
    expect(findPrice("my-gateway", "qwen/qwen3.8-flash")).not.toBeNull();
    expect(findPrice("my-gateway", "plain-model-name")).toBeNull();
  });
});
