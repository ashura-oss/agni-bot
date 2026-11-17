import { expect, test } from "bun:test";
import { ipv6LoopbackAvailable } from "./ipv6-loopback";

test("IPv6 loopback is reported available when a listener can bind ::1, and unavailable when binding throws", () => {
  let stopped = 0;
  expect(ipv6LoopbackAvailable(() => ({ stop: () => void stopped++ }))).toBe(true);
  expect(stopped).toBe(1);
  expect(ipv6LoopbackAvailable(() => {
    throw Object.assign(new Error("Failed to listen at ::1"), { code: "EADDRNOTAVAIL" });
  })).toBe(false);
});

test("the probe asks for ::1 on a port of the system's choosing", () => {
  const asked: Array<{ hostname?: string; port?: number }> = [];
  ipv6LoopbackAvailable((options) => {
    asked.push(options);
    return { stop() {} };
  });
  expect(asked).toHaveLength(1);
  expect(asked[0]).toMatchObject({ hostname: "::1", port: 0 });
});
