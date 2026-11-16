/**
 * Security round: every model call carries who it is for (so the ledger can count it), and the
 * address check sees a private IPv4 address through every IPv6 wrapper.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isPrivateAddress } from "../src/tools/fetch-url";

const read = (path: string): string => readFileSync(join(import.meta.dir, "..", "src", path), "utf8").replace(/\r\n/g, "\n");

describe("side model calls say who they are for", () => {
  for (const [file, purpose] of [["agent/compactor.ts", "compaction"], ["agent/critic.ts", "critic"], ["agent/rollover.ts", "summary"], ["jobs/tagger.ts", "tagger"]] as const) {
    test(`${file} passes agentID, purpose and kind "side"`, () => {
      const source = read(file);
      const call = source.slice(source.indexOf(".route({"), source.indexOf(".route({") + 900);
      expect(call).toContain("agentID");
      expect(call).toContain(`purpose: "${purpose}"`);
      expect(call).toContain('kind: "side"');
    });
  }

  test("the chat step passes kind turn, purpose chat, the bot, the job and the root job", () => {
    const source = read("agent/task-loop.ts");
    const call = source.slice(source.indexOf("router.route({"), source.indexOf("router.route({") + 700);
    expect(call).toContain('kind: "turn"');
    expect(call).toContain('purpose: "chat"');
    expect(call).toContain("agentID: persona.id");
    expect(call).toContain("jobID:");
    expect(call).toContain("rootJobID:");
  });
});

describe("isPrivateAddress sees through IPv6 wrappers", () => {
  test("6to4 (2002::/16) around a private IPv4 address", () => {
    expect(isPrivateAddress("2002:7f00:0001::")).toBe(true); // 127.0.0.1
    expect(isPrivateAddress("2002:c0a8:0101::1")).toBe(true); // 192.168.1.1
    expect(isPrivateAddress("2002:0a00:0001::")).toBe(true); // 10.0.0.1
    expect(isPrivateAddress("2002:a9fe:a9fe::")).toBe(true); // 169.254.169.254
    expect(isPrivateAddress("2002:0808:0808::")).toBe(false); // 8.8.8.8
  });
  test("IPv4-translated ::ffff:0:a.b.c.d", () => {
    expect(isPrivateAddress("::ffff:0:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("::ffff:0:10.1.2.3")).toBe(true);
    expect(isPrivateAddress("::ffff:0:8.8.8.8")).toBe(false);
  });
  test("NAT64 (64:ff9b::/96)", () => {
    expect(isPrivateAddress("64:ff9b::7f00:1")).toBe(true);
    expect(isPrivateAddress("64:ff9b::10.0.0.1")).toBe(true);
    expect(isPrivateAddress("64:ff9b::8.8.8.8")).toBe(false);
  });
  test("plain mapped and public addresses behave as before", () => {
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
  });
});
void afterEach;
