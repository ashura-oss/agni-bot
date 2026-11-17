/**
 * Sprint 3 merge, integration item (c): a provider's error body is masked before it is cut.
 *
 * A provider that echoes the key back in an error page can put it anywhere in the body. The message keeps only the first
 * 300 characters, so cutting first can leave the front of the key with its tail gone, and no registered form matches a
 * front half. Masking first replaces the whole key, then the cut has nothing of it to keep.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { ProviderError, streamChat } from "../src/models/client";
import { REDACTED, registerSecret } from "../src/util/redact";
import { unregisterSecret } from "../src/util/redact-core";

const registered: string[] = [];
afterEach(() => { for (const value of registered.splice(0)) unregisterSecret(value); });

function failWith(body: string, status = 401): Promise<ProviderError> {
  const fetchFn = (async () => new Response(body, { status })) as unknown as typeof fetch;
  return streamChat({
    baseUrl: "https://provider.test/v1", apiKey: "irrelevant", model: "m", messages: [{ role: "user", content: "hi" }],
    firstTokenTimeoutMs: 1000, onDelta: () => undefined, fetchFn,
  }).then(() => { throw new Error("expected the call to fail"); }, (error: unknown) => error as ProviderError);
}

describe("a provider error body", () => {
  test("a registered key that straddles the 300-character cut leaves no part of itself in the message", async () => {
    const key = "sk-provider-0123456789abcdefghijklmnopqrstuv";
    registerSecret(key);
    registered.push(key);
    // 285 characters of filler, then the key: the cut at 300 would have kept the first 15 characters of it.
    const error = await failWith(`${"x".repeat(285)}${key} and more text after it`);
    expect(error.message).not.toContain(key.slice(0, 10));
    expect(error.message).not.toContain(key.slice(0, 15));
    expect(error.message).toContain(REDACTED);
    expect(error.message.startsWith("HTTP 401: ")).toBe(true);
  });

  test("a key echoed at the start, with the body still longer than the cut, is masked and the message is still bounded", async () => {
    const key = "sk-provider-fedcba9876543210zyxwvutsrqponmlk";
    registerSecret(key);
    registered.push(key);
    const error = await failWith(`bad key ${key}. ${"y".repeat(600)}`);
    expect(error.message).not.toContain(key);
    expect(error.message).toContain(REDACTED);
    expect(error.message.length).toBeLessThan(330);
  });

  test("a body with no secret in it is kept as it was", async () => {
    const error = await failWith('{"error":  {"message": "rate limited"}}', 429);
    expect(error.message).toBe('HTTP 429: {"error": {"message": "rate limited"}}');
  });
});
