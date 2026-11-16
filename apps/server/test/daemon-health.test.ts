import { afterEach, describe, expect, test } from "bun:test";
import type { Config } from "../src/config";
import { fetchHealth, formatHealthLines } from "../src/daemon";
import { startHarness, type Harness } from "./ws-harness";

/**
 * W2-A item 1: an unpaired `GET /health` returns only liveness, so `daemon
 * status/start/restart` must send the local device token when one is stored
 * and must not crash on the minimal answer.
 */

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const configFor = (port: number): Config => ({ host: "127.0.0.1", port }) as Config;

describe("fetchHealth", () => {
  test("sends the stored local device token and gets the full report", async () => {
    harness = await startHarness();
    const health = await fetchHealth(configFor(harness.server.port), 1500, { AGNI_TOKEN: harness.token });
    expect(health).not.toBeNull();
    expect(Array.isArray(health?.providers)).toBe(true);
    expect(health?.usageToday).toBeDefined();
  });

  test("without a stored token it still answers, with liveness only", async () => {
    harness = await startHarness();
    const health = await fetchHealth(configFor(harness.server.port), 1500, {});
    expect(health).toMatchObject({ ok: true });
    expect(health?.providers).toBeUndefined();
    expect(health?.usageToday).toBeUndefined();
  });

  test("a stale token falls back to liveness instead of failing", async () => {
    harness = await startHarness();
    const health = await fetchHealth(configFor(harness.server.port), 1500, { AGNI_TOKEN: "agni_revoked" });
    expect(health).toMatchObject({ ok: true });
    expect(health?.providers).toBeUndefined();
  });
});

describe("formatHealthLines", () => {
  const config = { host: "127.0.0.1", port: 8787 } as Config;

  test("prints the minimal answer without crashing and says details need a paired device", async () => {
    harness = await startHarness();
    const minimal = await fetchHealth(configFor(harness.server.port), 1500, {});
    const lines = formatHealthLines(minimal ?? undefined, config);
    expect(lines.join("\n")).toContain("details need a paired device");
    expect(lines.join("\n")).toContain("protocol v");
  });

  test("prints providers and usage for the full report", async () => {
    harness = await startHarness();
    const full = await fetchHealth(configFor(harness.server.port), 1500, { AGNI_TOKEN: harness.token });
    const text = formatHealthLines(full ?? undefined, config).join("\n");
    expect(text).toContain("today 0 turns");
    expect(text).toContain("test"); // the provider id
    expect(text).not.toContain("details need a paired device");
  });

  test("prints nothing when there is no health", () => {
    expect(formatHealthLines(undefined, config)).toEqual([]);
  });
});
