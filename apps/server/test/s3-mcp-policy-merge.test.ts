/**
 * Sprint 3 merge, integration item (e): Sprint 3's `mcpToolMeta` and Sprint 2's policy registry in one tree.
 *
 * Both describe an MCP tool: `mcpToolMeta` (what a connector tool may carry as its own `meta`) and the policy table's MCP default
 * (`mcpPolicy`, which reads `MCP_FREE_TOOLS`). A tool's own meta can only add to its policy, never take away (Sprint 2 round P), so the
 * table's row stays the authority for what an MCP tool does. These tests pin that down: whichever way an MCP tool is described, its
 * result still taints the run, a tool the owner did not trust still asks, and only the free set can make one run unasked.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { MCP_FREE_TOOLS, mcpToolMeta } from "../src/plugins/mcp";
import { decide } from "../src/policy/engine";
import { policyFor, taintFrom } from "../src/policy/metadata";
import { policyRig, type PolicyRig } from "./policy-fixture";

const TOOL = "mcp_granola_search";
const AT = "2026-11-17T10:00:00Z";
let rig: PolicyRig | undefined;
afterEach(() => { rig?.close(); rig = undefined; MCP_FREE_TOOLS.clear(); });

/** An MCP tool as the hub would register it, carrying Sprint 3's meta, in a run that may use it. */
function withMcpTool() {
  rig = policyRig();
  rig.registry.register({
    name: TOOL, description: "search notes", schema: { type: "object", properties: {} }, timeoutMs: 1000, kind: "static",
    meta: mcpToolMeta(TOOL)!, handler: async () => ({ text: "from outside" }),
  });
  return rig.another({ capabilities: [...rig.registry.list().map((tool) => tool.name)] });
}
const taintOf = (own = mcpToolMeta(TOOL)) => taintFrom(policyFor(TOOL, own), TOOL, {}, { text: "from outside" }, AT);

describe("an MCP tool that carries mcpToolMeta", () => {
  test("its result taints the run, trusted or not", () => {
    expect(taintOf()).toMatchObject({ kind: "mcp", tool: TOOL });
    MCP_FREE_TOOLS.add(TOOL);
    expect(taintOf(mcpToolMeta(TOOL))).toMatchObject({ kind: "mcp", tool: TOOL });
  });

  test("one the owner did not trust is put to the owner", () => {
    const run = withMcpTool();
    expect(decide(run, { tool: TOOL, args: {}, callID: "c1" }, { record: false }).action).toBe("ask");
  });

  test("one the owner trusted runs free, and the run it served is still read as tainted by it", () => {
    const run = withMcpTool();
    MCP_FREE_TOOLS.add(TOOL);
    expect(decide(run, { tool: TOOL, args: {}, callID: "c2" }, { record: false })).toMatchObject({ action: "run", via: "free" });
    expect(taintFrom(policyFor(TOOL, rig!.registry.get(TOOL)!.meta), TOOL, {}, {}, AT)).toMatchObject({ kind: "mcp" });
  });

  test("the meta alone cannot make a tool free: a tier-1 meta made while it was trusted does not outlive the owner's trust", () => {
    MCP_FREE_TOOLS.add(TOOL);
    const run = withMcpTool(); // the tool's meta says tier 1 now
    expect(rig!.registry.get(TOOL)!.meta).toMatchObject({ tier: 1 });
    MCP_FREE_TOOLS.delete(TOOL); // the owner took the trust back
    expect(decide(run, { tool: TOOL, args: {}, callID: "c3" }, { record: false }).action).toBe("ask");
  });
});
