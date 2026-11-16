/**
 * S2-01: every tool says what it is. A tool that registers without a row in the
 * central table fails this file, so a new tool cannot slip in unclassified.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { policyFor, toolsMissingMetadata, TOOL_POLICY } from "../src/policy/metadata";
import { policyRig, type PolicyRig } from "./policy-fixture";

let rig: PolicyRig | undefined;
afterEach(() => { rig?.close(); rig = undefined; });

describe("tool metadata", () => {
  test("every registered tool has a row in the table", () => {
    rig = policyRig();
    const names = rig.registry.list().map((tool) => tool.name);
    expect(names.length).toBeGreaterThan(40);
    expect(toolsMissingMetadata(names)).toEqual([]);
  });

  test("the table has no row for a tool that does not exist", () => {
    rig = policyRig();
    const registered = new Set(rig.registry.list().map((tool) => tool.name));
    expect(Object.keys(TOOL_POLICY).filter((name) => !registered.has(name))).toEqual([]);
  });

  test("a tool with no row, and no mcp_ prefix, is unknown", () => {
    expect(policyFor("brand_new_tool")).toBeNull();
    expect(toolsMissingMetadata(["brand_new_tool", "bash"])).toEqual(["brand_new_tool"]);
  });

  test("connector tools get the default: an outside reader and an effector at tier 2", () => {
    const policy = policyFor("mcp_notion_search");
    expect(policy?.tier).toBe(2);
    expect(policy?.classes).toEqual(expect.arrayContaining(["untrusted-reader", "effector"]));
  });

  test("a tool's own meta wins over the table", () => {
    expect(policyFor("web_fetch", { classes: ["inert"], tier: 0 })?.classes).toEqual(["inert"]);
  });

  test("the classes say what each kind of tool is", () => {
    const classes = (name: string) => policyFor(name)!.classes;
    expect(classes("web_fetch")).toContain("untrusted-reader");
    expect(classes("mail_read")).toEqual(expect.arrayContaining(["untrusted-reader", "private-reader"]));
    expect(classes("mail_send")).toContain("effector");
    expect(classes("write_file")).toContain("effector");
    expect(classes("memory_search")).toContain("private-reader");
    expect(classes("say")).toEqual(["inert"]);
    expect(policyFor("bash")!.tier).toBe(3);
    expect(policyFor("run_privileged")!.tier).toBe(3);
  });

  test("the tools that change bots, schedules and routines are protected", () => {
    for (const name of ["create_agent", "update_agent", "rename_agent", "job_schedule", "job_cancel", "routine_create", "routine_pause", "routine_delete"]) {
      expect({ name, protectedWrite: policyFor(name)!.protectedWrite }).toEqual({ name, protectedWrite: true });
    }
    expect(policyFor("memory_write")!.protectedWrite).toBeUndefined();
  });
});
