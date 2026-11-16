/**
 * A secret a store replaces or drops is not unmasked at once: it may still be valid until it
 * expires, and unmasking a live credential leaks it while masking a dead one costs nothing. A
 * revoke does not change that (a revoked refresh token does not kill an access token already
 * issued), so nothing a store lets go of is ever unmasked because of one. A slot keeps a bounded
 * queue of the values it let go of; they leave it at their known expiry or, with no known expiry,
 * only by age: oldest first once more than RETIRED_PER_SLOT pile up in the slot, or RETIRED_MAX
 * across all slots.
 */
import { describe, expect, setSystemTime, test } from "bun:test";
import {
  RETIRED_MAX,
  RETIRED_PER_SLOT,
  forgetSecretSlots,
  redact,
  releaseExpiredSecrets,
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

describe("the bound across slots", () => {
  test("many slots with full queues keep the registry within RETIRED_MAX retired values, oldest first", () => {
    const slots = Math.ceil(RETIRED_MAX / RETIRED_PER_SLOT) + 20;
    const name = (slot: number, i: number): string => `token-${slot}-number-${i}-zzzzzz`;
    for (let slot = 0; slot < slots; slot += 1) {
      for (let i = 0; i <= RETIRED_PER_SLOT + 1; i += 1) rememberSecretsAt(`conn-${slot}`, name(slot, i));
    }
    // Each slot holds one live value and its queue is full; together they would be over the bound.
    expect(slots * RETIRED_PER_SLOT).toBeGreaterThan(RETIRED_MAX);
    expect(secretCount()).toBeLessThanOrEqual(RETIRED_MAX + slots);
    expect(masked(name(slots - 1, RETIRED_PER_SLOT + 1))).toBe(true); // the newest live value
    expect(masked(name(slots - 1, RETIRED_PER_SLOT))).toBe(true); // the newest queued one
    expect(masked(name(0, 2))).toBe(false); // the oldest queued value of the oldest slot went first
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
    expect(masked("access-token-two-bbbb")).toBe(true);
    expect(secretCount()).toBe(2); // the old one (queued) and the new one (live), each once
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
