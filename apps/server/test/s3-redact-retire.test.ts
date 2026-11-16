/**
 * A secret a store replaces or drops is not unmasked at once: it may still be valid until it
 * expires or until the provider confirms a revoke, and unmasking a live credential leaks it
 * while masking a dead one costs nothing. A slot keeps a short, bounded queue of the values it
 * let go of; they leave it at their known expiry, on a confirmed revoke, or (only when more than
 * RETIRED_PER_SLOT pile up) oldest first.
 */
import { describe, expect, setSystemTime, test } from "bun:test";
import {
  RETIRED_PER_SLOT,
  forgetSecretSlots,
  redact,
  releaseExpiredSecrets,
  releaseRetiredSecrets,
  rememberSecretsAt,
  secretCount,
  stageSecretsAt,
} from "../src/util/redact";

const masked = (value: string): boolean => redact(`before ${value} after`) === "before [redacted] after";
const HOUR = 3_600_000;

describe("a replaced secret stays masked", () => {
  test("a replaced access and refresh token are both still masked, next to the new ones", () => {
    rememberSecretsAt("conn", "access-token-one-aaaa", "refresh-token-one-aaaa");
    rememberSecretsAt("conn", "access-token-two-bbbb", "refresh-token-two-bbbb");
    for (const value of ["access-token-one-aaaa", "refresh-token-one-aaaa", "access-token-two-bbbb", "refresh-token-two-bbbb"]) {
      expect(masked(value)).toBe(true);
    }
  });

  test("a slot that is emptied keeps what it held masked", () => {
    rememberSecretsAt("conn", "access-token-one-aaaa");
    rememberSecretsAt("conn");
    expect(masked("access-token-one-aaaa")).toBe(true);
  });

  test("forgetSecretSlots keeps the values of a slot that is gone masked", () => {
    rememberSecretsAt("plugins.json:gmail:pass", "mail-app-password-1111");
    forgetSecretSlots("plugins.json:");
    expect(masked("mail-app-password-1111")).toBe(true);
  });

  test("a value put back in the slot is live again, not queued twice", () => {
    rememberSecretsAt("conn", "token-one-aaaaaaaa");
    rememberSecretsAt("conn", "token-two-bbbbbbbb");
    rememberSecretsAt("conn", "token-one-aaaaaaaa");
    rememberSecretsAt("conn", "token-three-cccccc");
    const size = secretCount();
    rememberSecretsAt("conn", "token-one-aaaaaaaa");
    expect(secretCount()).toBe(size);
    expect(masked("token-two-bbbbbbbb")).toBe(true);
  });
});

describe("a replaced secret is let go at its expiry", () => {
  test("one whose expiry has passed is released when it is replaced", () => {
    const now = Date.now();
    rememberSecretsAt("conn", { value: "access-token-one-aaaa", expiresAt: now - 1 });
    rememberSecretsAt("conn", "access-token-two-bbbb");
    expect(masked("access-token-one-aaaa")).toBe(false);
    expect(masked("access-token-two-bbbb")).toBe(true);
  });

  test("one that has not expired stays masked until it does, then redact lets it go by itself", () => {
    const now = Date.now();
    try {
      rememberSecretsAt("conn", { value: "access-token-one-aaaa", expiresAt: now + HOUR });
      rememberSecretsAt("conn", "access-token-two-bbbb");
      expect(masked("access-token-one-aaaa")).toBe(true);
      setSystemTime(new Date(now + HOUR - 1));
      expect(masked("access-token-one-aaaa")).toBe(true);
      setSystemTime(new Date(now + HOUR));
      expect(masked("access-token-one-aaaa")).toBe(false);
      expect(masked("access-token-two-bbbb")).toBe(true);
    } finally {
      setSystemTime();
    }
  });

  test("releaseExpiredSecrets releases what has expired by the given time, and no more", () => {
    const now = Date.now();
    rememberSecretsAt("conn", { value: "access-token-one-aaaa", expiresAt: now + HOUR }, "refresh-token-one-aaaa");
    rememberSecretsAt("conn");
    releaseExpiredSecrets(now + 2 * HOUR);
    expect(masked("access-token-one-aaaa")).toBe(false);
    expect(masked("refresh-token-one-aaaa")).toBe(true); // no known expiry
  });

  test("a live value is never released by its expiry", () => {
    const now = Date.now();
    rememberSecretsAt("conn", { value: "access-token-one-aaaa", expiresAt: now + HOUR });
    releaseExpiredSecrets(now + 2 * HOUR);
    expect(masked("access-token-one-aaaa")).toBe(true);
  });
});

describe("a confirmed revoke releases the queued values", () => {
  test("only the named values, and only those a slot let go of", () => {
    rememberSecretsAt("conn", "access-token-one-aaaa", "refresh-token-one-aaaa");
    rememberSecretsAt("conn", "access-token-two-bbbb");
    releaseRetiredSecrets("access-token-one-aaaa", "refresh-token-one-aaaa", "access-token-two-bbbb");
    expect(masked("access-token-one-aaaa")).toBe(false);
    expect(masked("refresh-token-one-aaaa")).toBe(false);
    expect(masked("access-token-two-bbbb")).toBe(true); // still the live one
  });

  test("a value another slot holds live stays masked", () => {
    rememberSecretsAt("conn", "shared-token-aaaaaaa");
    rememberSecretsAt("plugins.json:gmail:access_token", "shared-token-aaaaaaa");
    rememberSecretsAt("conn");
    releaseRetiredSecrets("shared-token-aaaaaaa");
    expect(masked("shared-token-aaaaaaa")).toBe(true);
  });
});

describe("the queue is bounded", () => {
  test("1,000 replacements keep the registry at the live values plus the queue", () => {
    const rounds = 1_000;
    rememberSecretsAt("conn", "access-round-0-zzzzzzzz", "refresh-round-0-zzzzzzzz");
    for (let i = 1; i <= RETIRED_PER_SLOT; i += 1) rememberSecretsAt("conn", `access-round-${i}-zzzzzzzz`, `refresh-round-${i}-zzzzzzzz`);
    const plateau = secretCount();
    for (let i = RETIRED_PER_SLOT + 1; i <= rounds; i += 1) rememberSecretsAt("conn", `access-round-${i}-zzzzzzzz`, `refresh-round-${i}-zzzzzzzz`);
    expect(secretCount()).toBe(plateau);
    expect(masked(`access-round-${rounds}-zzzzzzzz`)).toBe(true);
    expect(masked("access-round-3-zzzzzzzz")).toBe(false);
  });

  test("past the bound the oldest is dropped first and the newer ones stay", () => {
    // One value per replacement: the queue holds the last RETIRED_PER_SLOT replaced values.
    for (let i = 0; i <= RETIRED_PER_SLOT + 1; i += 1) rememberSecretsAt("conn", `token-number-${i}-zzzzzz`);
    expect(masked("token-number-0-zzzzzz")).toBe(false);
    expect(masked("token-number-1-zzzzzz")).toBe(true);
    expect(masked(`token-number-${RETIRED_PER_SLOT + 1}-zzzzzz`)).toBe(true);
  });

  test("a value dropped from one slot's queue stays masked while another holder holds it", () => {
    rememberSecretsAt("other", "token-number-0-zzzzzz");
    for (let i = 0; i <= RETIRED_PER_SLOT + 1; i += 1) rememberSecretsAt("conn", `token-number-${i}-zzzzzz`);
    expect(masked("token-number-0-zzzzzz")).toBe(true);
  });
});

describe("staging a value before the save that will hold it", () => {
  test("a staged value is masked, and a failed save (no settle) keeps the old values masked too", () => {
    rememberSecretsAt("conn", "access-token-one-aaaa");
    stageSecretsAt("conn", "access-token-two-bbbb");
    expect(masked("access-token-one-aaaa")).toBe(true);
    expect(masked("access-token-two-bbbb")).toBe(true);
  });

  test("settling on the new value queues the old one and does not queue the staged one twice", () => {
    rememberSecretsAt("conn", "access-token-one-aaaa");
    stageSecretsAt("conn", "access-token-two-bbbb");
    rememberSecretsAt("conn", "access-token-two-bbbb");
    expect(masked("access-token-one-aaaa")).toBe(true);
    releaseRetiredSecrets("access-token-two-bbbb", "access-token-one-aaaa");
    expect(masked("access-token-one-aaaa")).toBe(false);
    expect(masked("access-token-two-bbbb")).toBe(true);
  });

  test("staged values do not push a queued value out before the save has succeeded", () => {
    // The queue is full: a value replaced now would push the oldest out. A staged value is not replaced yet.
    for (let i = 0; i <= RETIRED_PER_SLOT; i += 1) rememberSecretsAt("conn", `token-number-${i}-zzzzzz`);
    stageSecretsAt("conn", "token-staged-1-zzzzzz", "token-staged-2-zzzzzz");
    expect(masked("token-number-0-zzzzzz")).toBe(true);
    expect(masked("token-staged-1-zzzzzz")).toBe(true);
    // The save succeeded: now the bound applies, oldest first.
    rememberSecretsAt("conn", "token-staged-1-zzzzzz", "token-staged-2-zzzzzz");
    expect(masked("token-number-0-zzzzzz")).toBe(false);
    expect(masked("token-number-1-zzzzzz")).toBe(true);
  });

  test("staging again and again (a save that keeps failing) is bounded too", () => {
    rememberSecretsAt("conn", "token-live-aaaaaaaaaa");
    for (let i = 0; i < 100; i += 1) stageSecretsAt("conn", `token-staged-${i}-zzzzzz`);
    expect(secretCount()).toBe(1 + RETIRED_PER_SLOT);
    expect(masked("token-live-aaaaaaaaaa")).toBe(true);
    expect(masked("token-staged-99-zzzzzz")).toBe(true);
  });

  test("a staged value that was never settled is let go like any queued one", () => {
    rememberSecretsAt("conn", "access-token-one-aaaa");
    stageSecretsAt("conn", { value: "access-token-two-bbbb", expiresAt: Date.now() + HOUR });
    releaseExpiredSecrets(Date.now() + 2 * HOUR);
    expect(masked("access-token-two-bbbb")).toBe(false);
    expect(masked("access-token-one-aaaa")).toBe(true);
  });
});
