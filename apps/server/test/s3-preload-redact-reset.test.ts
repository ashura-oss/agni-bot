/**
 * The test preload empties the redaction registry between tests, so what one test
 * registers (or leaves registered) cannot change what the next one sees: no secret
 * count, no held-back stream tail, no masked text.
 *
 * The two tests run in this order; the second only passes because of the preload.
 */
import { describe, expect, test } from "bun:test";
import { holdbackLength, redact, registerSecret, rememberSecretsAt, secretCount } from "../src/util/redact";

describe("the redaction registry between tests", () => {
  test("one test registers secrets, directly and by slot, and leaves them", () => {
    registerSecret("left-behind-by-the-first-test");
    rememberSecretsAt("slot-left-behind", "slot-value-left-behind-1");
    expect(redact("left-behind-by-the-first-test")).toBe("[redacted]");
    expect(secretCount()).toBeGreaterThan(0);
  });

  test("the next test starts with nothing registered", () => {
    expect(secretCount()).toBe(0);
    expect(redact("left-behind-by-the-first-test")).toBe("left-behind-by-the-first-test");
    expect(holdbackLength("a stream that ends in sl")).toBe(0);
    // A slot that still remembered its old values would unregister them (and miscount) here.
    rememberSecretsAt("slot-left-behind", "other-value-in-the-same-slot");
    expect(secretCount()).toBe(1);
  });
});
