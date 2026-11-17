/**
 * A value staged ahead of a save (by `readConnectionTokens`, `saveTokens`) is the newest token a store has seen and has
 * not yet had a chance to settle. The bound on retired values in all slots together (`RETIRED_MAX`) used to evict the
 * oldest entry whichever list it was in, so many rotations in other slots could push a staged token out of the registry
 * and unmask it. Only retired queues are evicted from; staged stays capped at `RETIRED_PER_SLOT` per slot.
 */
import { describe, expect, test } from "bun:test";
import { readConnectionTokens, type PluginConnectionRow } from "../src/plugins/store";
import { RETIRED_MAX, RETIRED_PER_SLOT, redact, rememberSecretsAt, stageSecretsAt } from "../src/util/redact";

const masked = (value: string): boolean => redact(`before ${value} after`) === "before [redacted] after";

function row(id: string, tokens: Record<string, unknown>): PluginConnectionRow {
  return { id, plugin_id: "calendar", account: "agent", status: "connected", account_label: null, scopes: null, capabilities: null, tokens: JSON.stringify(tokens), token_ref: null, error: null, grant_started_at: null, connected_at: null, updated_at: "now" };
}

/** Rotate a value through each of `slots` slots until `rounds` values have been retired in all. */
function rotate(slots: number, rounds: number): void {
  for (let i = 0; i < rounds; i++) rememberSecretsAt(`other-slot-${i % slots}`, `rotated-secret-${String(i).padStart(4, "0")}-xxxxxxxx`);
}

describe("the bound on retired values in all slots", () => {
  test("a token staged by readConnectionTokens stays masked after 600+ rotations across 16 other slots", () => {
    expect(RETIRED_MAX).toBeLessThan(16 * RETIRED_PER_SLOT + 2); // the scenario fills every queue and then some
    readConnectionTokens(row("conn-1", { access_token: "staged-access-token-0000000001", refresh_token: "staged-refresh-token-000000002" }));
    rotate(16, 640);
    expect(masked("staged-access-token-0000000001")).toBe(true);
    expect(masked("staged-refresh-token-000000002")).toBe(true);
  });

  test("retired values are still bounded: the oldest rotated values are the ones that go", () => {
    readConnectionTokens(row("conn-2", { access_token: "staged-access-token-0000000003" }));
    rotate(16, 640);
    expect(masked("rotated-secret-0000-xxxxxxxx")).toBe(false); // the very first one, long since evicted
    expect(masked("rotated-secret-0638-xxxxxxxx")).toBe(true); // the most recent retired one is still held
  });

  test("a slot's staged values are capped at RETIRED_PER_SLOT, oldest out", () => {
    for (let i = 0; i < RETIRED_PER_SLOT + 5; i++) stageSecretsAt("one-slot", `staged-value-${String(i).padStart(3, "0")}-xxxxxxxx`);
    expect(masked("staged-value-000-xxxxxxxx")).toBe(false);
    expect(masked("staged-value-004-xxxxxxxx")).toBe(false);
    expect(masked("staged-value-005-xxxxxxxx")).toBe(true);
    expect(masked(`staged-value-${String(RETIRED_PER_SLOT + 4).padStart(3, "0")}-xxxxxxxx`)).toBe(true);
  });
});
