/**
 * Sprint 2, fix round P (item 3): a tool's own `meta` cannot take away what the policy table knows.
 *
 * `policyFor(tool, own)` returned the tool's own meta as it was, so a tool that carried one lost the table's (or the MCP default's) taint,
 * per-call assessment, protected-write mark, and tier. The run never read a tool that brought outside text as outside text, and a tool the
 * table asks about could be made to run free. The merge keeps every class and the higher tier, keeps what the table holds, and derives
 * taint from the `untrusted-reader` class for a tool the table does not know.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MCP_FREE_TOOLS } from "../src/plugins/mcp";
import { decide } from "../src/policy/engine";
import { assessCall, policyFor, taintFrom } from "../src/policy/metadata";
import type { ToolMeta } from "../src/policy/tool-meta";
import { policyRig, type PolicyRig } from "./policy-fixture";

const AT = "2026-11-17T10:00:00Z";
const READER: ToolMeta = { classes: ["untrusted-reader", "private-reader"], tier: 0 };
const INERT: ToolMeta = { classes: ["inert"], tier: 0 };
const taintOf = (tool: string, own: ToolMeta | undefined, args: Record<string, unknown> = {}) => taintFrom(policyFor(tool, own), tool, args, { text: "from outside" }, AT);

afterEach(() => { MCP_FREE_TOOLS.clear(); });

describe("a tool the table does not know, with its own meta", () => {
  test("an untrusted-reader taints the run that reads its result", () => {
    const source = taintOf("vendor_inbox", READER);
    expect(source).not.toBeNull();
    expect(source).toMatchObject({ tool: "vendor_inbox", at: AT });
    expect(source?.label).toContain("vendor_inbox");
  });

  test("a tool that is not an untrusted-reader does not", () => {
    expect(taintOf("vendor_writer", { classes: ["effector"], tier: 2 })).toBeNull();
    expect(taintOf("vendor_clock", INERT)).toBeNull();
  });

  test("its own tier and classes are what the policy uses", () => {
    const policy = policyFor("vendor_writer", { classes: ["effector"], tier: 2 })!;
    expect(policy.tier).toBe(2);
    expect(policy.classes).toEqual(["effector"]);
    expect(assessCall(policy, {})).toMatchObject({ tier: 2, asks: true });
  });
});

describe("a tool in the table, with its own meta", () => {
  test("still taints the run: the table's rule is kept", () => {
    expect(taintOf("web_fetch", INERT, { url: "https://evil.example/page" })).toMatchObject({ kind: "web", tool: "web_fetch" });
    expect(policyFor("web_fetch", INERT)!.classes).toContain("untrusted-reader");
  });

  test("cannot lower the tier: a destructive shell command still asks at tier 3", () => {
    const policy = policyFor("bash", INERT)!;
    expect(policy.tier).toBe(3);
    expect(assessCall(policy, { command: "rm -rf /tmp/everything" })).toMatchObject({ tier: 3, asks: true });
  });

  test("may raise the tier", () => {
    expect(policyFor("read_file", { classes: ["private-reader"], tier: 2 })!.tier).toBe(2);
  });

  test("keeps the mark that bars a run that has read outside text from changing the bots", () => {
    expect(policyFor("create_agent")!.protectedWrite).toBe(true);
    expect(policyFor("create_agent", INERT)!.protectedWrite).toBe(true);
  });

  test("keeps the table's own resources unless the meta names its own", () => {
    const own: ToolMeta = { classes: ["effector"], tier: 2, resources: () => [{ kind: "other", value: "mine" }] };
    expect(policyFor("mail_send", { classes: ["effector"], tier: 2 })!.resources).toBe(policyFor("mail_send")!.resources);
    expect(policyFor("mail_send", own)!.resources?.({})).toEqual([{ kind: "other", value: "mine" }]);
  });
});

describe("an MCP tool with its own meta", () => {
  test("still asks every time and still taints, whatever the meta says", () => {
    const policy = policyFor("mcp_vendor_search", INERT)!;
    expect(assessCall(policy, {})).toMatchObject({ tier: 2, asks: true });
    expect(taintOf("mcp_vendor_search", INERT)).toMatchObject({ kind: "mcp", tool: "mcp_vendor_search" });
  });

  test("one the owner trusted runs free as before, and still taints", () => {
    MCP_FREE_TOOLS.add("mcp_vendor_search");
    const policy = policyFor("mcp_vendor_search", INERT)!;
    expect(assessCall(policy, {})).toMatchObject({ tier: 0, asks: false });
    expect(taintOf("mcp_vendor_search", INERT)).toMatchObject({ kind: "mcp" });
  });
});

describe("through the engine", () => {
  let rig: PolicyRig;
  beforeEach(() => { rig = policyRig(); });
  afterEach(() => { rig.close(); });

  test("a shell tool registered with a free meta is still asked about for a destructive command", () => {
    (rig.registry.get("bash") as { meta?: ToolMeta }).meta = INERT;
    expect(decide(rig.run, { tool: "bash", args: { command: "rm -rf /tmp/everything" }, callID: "call_1" }).action).toBe("ask");
  });
});
