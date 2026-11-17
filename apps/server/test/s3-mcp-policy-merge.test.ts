/**
 * Sprint 3 merge, integration item (e): the connector hub and Sprint 2's policy table in one tree.
 *
 * An MCP tool is described by the policy table's MCP default (`mcpPolicy`, which reads `MCP_FREE_TOOLS`) and by nothing the tool carries
 * itself: the hub registers it with no `meta`, and a tool's own meta could only add to its policy, never take away (Sprint 2 round P). These
 * tests pin that down: its result taints the run, a tool the owner did not trust asks, and only the free set can make one run unasked.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { MCP_FREE_TOOLS } from "../src/plugins/mcp";
import { decide } from "../src/policy/engine";
import { policyFor, taintFrom } from "../src/policy/metadata";
import { policyRig, type PolicyRig } from "./policy-fixture";

const TOOL = "mcp_granola_search";
const AT = "2026-11-17T10:00:00Z";
let rig: PolicyRig | undefined;
afterEach(() => { rig?.close(); rig = undefined; MCP_FREE_TOOLS.clear(); });

/** An MCP tool as the hub registers it (no meta of its own), in a run that may use it. */
function withMcpTool() {
  rig = policyRig();
  rig.registry.register({
    name: TOOL, description: "search notes", schema: { type: "object", properties: {} }, timeoutMs: 1000, kind: "static",
    handler: async () => ({ text: "from outside" }),
  });
  return rig.another({ capabilities: [...rig.registry.list().map((tool) => tool.name)] });
}
const taintOf = () => taintFrom(policyFor(TOOL, undefined), TOOL, {}, { text: "from outside" }, AT);

describe("an MCP tool as the hub registers it", () => {
  test("its result taints the run, trusted or not", () => {
    expect(taintOf()).toMatchObject({ kind: "mcp", tool: TOOL });
    MCP_FREE_TOOLS.add(TOOL);
    expect(taintOf()).toMatchObject({ kind: "mcp", tool: TOOL });
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

  test("the owner taking the trust back puts the tool to the owner again", () => {
    MCP_FREE_TOOLS.add(TOOL);
    const run = withMcpTool();
    expect(decide(run, { tool: TOOL, args: {}, callID: "c3" }, { record: false })).toMatchObject({ action: "run", via: "free" });
    MCP_FREE_TOOLS.delete(TOOL);
    expect(decide(run, { tool: TOOL, args: {}, callID: "c4" }, { record: false }).action).toBe("ask");
  });
});
