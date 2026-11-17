/**
 * S2-INT item 7: the shell tool stops with the turn, a refused working directory raises no card, and the
 * operating system's authorization path takes one short simple command, by absolute path, in a clean environment.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { ChildProcess, ExecFileOptions } from "node:child_process";
import { decide } from "../src/policy/engine";
import { buildAppleScript, isCompoundCommand, OSASCRIPT_PATH, runPrivilegedWithOSAuth } from "../src/tools/privileged-os";
import { childEnv } from "../src/util/child-env";
import { policyRig, type PolicyRig } from "./policy-fixture";

let rig: PolicyRig | undefined;
afterEach(() => { rig?.close(); rig = undefined; });

describe("bash stops with the turn", () => {
  test("the turn's abort signal reaches the command and ends it", async () => {
    rig = policyRig();
    const bash = rig.registry.get("bash")!;
    const controller = new AbortController();
    const started = Date.now();
    const pending = (bash.handler as unknown as (args: unknown, ctx: unknown) => Promise<{ aborted: boolean }>)(
      { command: "sleep 30" },
      { threadID: "t", turnID: "u", signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 300);
    const result = await pending;
    expect(result.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);
});

describe("a refused working directory raises no card", () => {
  test("a cwd outside scratch is refused as an invalid call, with the reason", () => {
    rig = policyRig();
    const outside = resolve(rig.scratch, "..");
    const decision = decide(rig.run, { tool: "bash", args: { command: "rm -rf build", cwd: outside }, callID: "c1" });
    expect(decision.action).toBe("refuse");
    if (decision.action === "refuse") {
      expect(decision.code).toBe("invalid_arguments");
      expect(decision.error).toContain("outside the scratch directory");
    }
  });

  test("a cwd inside scratch is still judged as before (an unsafe command asks)", () => {
    rig = policyRig();
    const decision = decide(rig.run, { tool: "bash", args: { command: "rm -rf build", cwd: "project" }, callID: "c2" });
    expect(decision.action).toBe("ask");
  });
});

describe("the OS authorization path", () => {
  test("a command with & < > ${ or more than 300 characters is not a simple command", () => {
    for (const command of ["sudo a & b", "sudo a < /etc/passwd", "sudo a > /tmp/x", "sudo echo ${HOME}", `sudo ${"a".repeat(300)}`]) {
      expect({ command: command.slice(0, 30), compound: isCompoundCommand(command) }).toEqual({ command: command.slice(0, 30), compound: true });
    }
    // The old shapes still count, and a short plain command still does not.
    for (const command of ["sudo a; b", "sudo a && b", "sudo a | b", "sudo `b`", "sudo $(b)", "sudo a\nb"]) expect(isCompoundCommand(command)).toBe(true);
    expect(isCompoundCommand("sudo launchctl list")).toBe(false);
    expect(isCompoundCommand(`sudo ${"a".repeat(295)}`)).toBe(false); // 300 characters exactly
  });

  test("a command that is too long is refused, not cut", async () => {
    const result = await runPrivilegedWithOSAuth(`sudo ${"a".repeat(400)}`);
    expect(result).toMatchObject({ exitCode: 1, usedOSAuth: false });
    expect(result.stderr).toContain("one simple command");
    expect(result.stderr).toContain("300");
  });

  test("osascript is run by absolute path, in the shell child's clean environment", async () => {
    const seen: Array<{ file: string; args: readonly string[]; options: ExecFileOptions }> = [];
    const exec = ((file: string, args: readonly string[], options: ExecFileOptions, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      seen.push({ file, args, options });
      callback(null, "ok", "");
      return {} as ChildProcess;
    }) as unknown as NonNullable<Parameters<typeof runPrivilegedWithOSAuth>[1]>["exec"];
    const result = await runPrivilegedWithOSAuth("sudo launchctl list", { exec });
    expect(result).toMatchObject({ stdout: "ok", exitCode: 0, usedOSAuth: true });
    expect(OSASCRIPT_PATH).toBe("/usr/bin/osascript");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.file).toBe(OSASCRIPT_PATH);
    expect(seen[0]!.args[0]).toBe("-e");
    expect(seen[0]!.args[1]).toBe(buildAppleScript("sudo launchctl list"));
    expect(seen[0]!.options.env).toEqual(childEnv("shell"));
  });
});
