/**
 * S2-01: every tool says what it is. A tool that registers without a row in the
 * central table fails this file, so a new tool cannot slip in unclassified.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { assessCall, policyFor, toolsMissingMetadata, TOOL_POLICY } from "../src/policy/metadata";
import { recordDenial } from "../src/policy/denials";
import { decide } from "../src/policy/engine";
import { pathResource } from "../src/policy/resources";
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
    for (const name of ["create_agent", "update_agent", "rename_agent", "forget_fact", "job_schedule", "job_cancel", "routine_create", "routine_pause", "routine_delete"]) {
      expect({ name, protectedWrite: policyFor(name)!.protectedWrite }).toEqual({ name, protectedWrite: true });
    }
    expect(policyFor("memory_write")!.protectedWrite).toBeUndefined();
  });
});

describe("what a search and a privileged command reach", () => {
  test("grep with no path searches scratch, so it names scratch: a refusal of a file inside it covers it", () => {
    rig = policyRig();
    const policy = policyFor("grep");
    const { resources } = assessCall(policy, { pattern: "secret" });
    expect(resources).toEqual([pathResource(".")]);
    expect(assessCall(policy, { pattern: "secret", path: "sub" }).resources).toEqual([pathResource("sub")]);

    recordDenial(rig.db, rig.run, { tool: "bash", operation: "read", cause: "denied", resources: [pathResource("sub/id_rsa")] });
    const decision = decide(rig.run, { tool: "grep", args: { pattern: "BEGIN" }, callID: "call_grep" });
    expect(decision).toMatchObject({ action: "refuse", code: "denied_resource" });
  });

  // `run_privileged` may run in the server's own folder (the OS-authorization path), not in scratch, so a relative word does not say which file.
  test("run_privileged: a relative operand is unresolved, an absolute one is read", () => {
    rig = policyRig();
    const policy = policyFor("run_privileged");
    for (const command of ["rm denied.txt", "rm sub/denied.txt", "rm -rf .", "cat ./a", "mv /tmp/x b"]) {
      const assessment = assessCall(policy, { command, purpose: "test" });
      expect({ command, unproven: assessment.unprovenShell === true, resources: assessment.resources }).toEqual({ command, unproven: true, resources: [] });
    }
    const absolute = join(rig.scratch, "denied.txt");
    const proven = assessCall(policy, { command: `rm ${absolute.replaceAll("\\", "/")}`, purpose: "test" });
    expect(proven.unprovenShell, "an absolute path is still read").toBeUndefined();
    expect(proven.resources).toEqual([pathResource(absolute)]);
  });

  test("bash keeps reading a relative operand against scratch, where the server runs it", () => {
    rig = policyRig();
    const assessment = assessCall(policyFor("bash"), { command: "rm denied.txt" });
    expect(assessment.unprovenShell).toBeUndefined();
    expect(assessment.resources).toEqual([pathResource("denied.txt")]);
  });
});
