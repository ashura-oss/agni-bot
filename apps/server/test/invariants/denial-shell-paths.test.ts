/**
 * INV-07 (what an operand reaches): the shell opens `link/../x` through the link, so the server cannot say
 * what it reaches by reading the words. In the allowlist grammar (policy/shell-proof.ts) an operand is
 * unresolved, and the command with it is unproven, when
 *   - it has a `..` segment, or
 *   - any part of it that exists is a symbolic link (a junction on Windows).
 * An unproven command in a run that holds a refusal asks, naming the refusal; it never runs on its own.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { scenarioTest, useScenarios, say, type Scenario } from "../scenarios/harness";
import { proveShell } from "../../src/policy/shell-proof";
import { call, playTurn, scripted, type CallRecord } from "./support";

const WINDOWS = process.platform === "win32";
const scenarios = useScenarios();
const shell = (path: string): string => path.replaceAll("\\", "/");

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

/** A folder link (a junction on Windows, which needs no privilege), or false when this account cannot make one. */
function linkFolder(target: string, at: string): boolean {
  try { symlinkSync(target, at, WINDOWS ? "junction" : "dir"); return true; } catch { return false; }
}

function tempFolder(): string {
  const root = mkdtempSync(join(tmpdir(), "agni-shell-paths-"));
  roots.push(root);
  return root;
}

describe("INV-07 an operand with a `..` segment is unresolved", () => {
  const cwd = tempFolder();
  test.each([
    "rm x/../denied",
    "rm ../denied",
    "cat sub/../denied",
    "rm ..",
    "ls ..",
    "mv a b/../c",
    "rm -rf -- x/../denied",
  ])("%s", (command) => {
    const proof = proveShell(command, cwd);
    expect(proof.proven, `${command} was proven; the shell may open a different file than the words say`).toBe(false);
  });

  test.each(["rm ./denied", "rm x/./denied", "ls .", "rm denied..txt", "rm ..denied", "touch a..b/c"])("a dot that is not a `..` segment is still proven: %s", (command) => {
    expect(proveShell(command, cwd).proven, command).toBe(true);
  });

  if (WINDOWS) {
    test("a Git Bash spelling with `..` is unresolved too", () => {
      expect(proveShell("rm /c/x/../denied", cwd, "win32").proven).toBe(false);
    });
  }
});

describe("INV-07 an operand whose existing part contains a symbolic link is unresolved", () => {
  const root = tempFolder();
  mkdirSync(join(root, "real", "inner"), { recursive: true });
  writeFileSync(join(root, "real", "denied"), "original");
  const linked = linkFolder(join(root, "real"), join(root, "link"));

  if (!linked) {
    test("(skipped: this account cannot make a folder link)", () => { expect(linked).toBe(false); });
    return;
  }

  test.each(["rm link/denied", "cat link/denied", "rm link/inner/new", "mkdir link/new", "rm link", "rm -rf link/inner"])("%s", (command) => {
    expect(proveShell(command, root).proven, `${command} was proven through a link`).toBe(false);
  });

  test("an absolute operand through a link is unresolved", () => {
    expect(proveShell(`rm ${shell(join(root, "link", "denied"))}`, root).proven).toBe(false);
  });

  test("the same file by its real name is proven, and so is a name that does not exist", () => {
    expect(proveShell("rm real/denied", root).proven).toBe(true);
    expect(proveShell("rm real/not-there-yet", root).proven).toBe(true);
    expect(proveShell("touch fresh.txt", root).proven).toBe(true);
  });

  test("a link in the working folder's own path is not held against the operands inside it", () => {
    // The server chose the folder (it may sit behind a link the owner set up): only what is below it can be a surprise.
    expect(proveShell("rm denied", join(root, "link")).proven).toBe(true);
    expect(proveShell("rm inner/x", join(root, "link")).proven).toBe(true);
  });
});

describe("INV-07 in a run that holds a refusal, such an operand asks, naming the refusal", () => {
  async function refuseThenTry(s: Scenario, denied: string, command: string): Promise<CallRecord> {
    s.model.queue(...scripted(true, [
      call("bash", { command: `rm ${shell(denied)}` }, "call_rm"),
      call("bash", { command }, "call_route"),
      say("Done."),
    ]));
    const a = await s.connect({ label: "A" });
    const report = await playTurn(s, a, "clean up", { answer: () => "reject" });
    const record = report.calls.find((entry) => entry.callID === "call_route");
    expect(record, "the bot never tried the route; the script is out of step").toBeDefined();
    return record!;
  }

  function expectNamedCard(record: CallRecord, route: string): void {
    expect(record.card && record.card.preview !== "", `${route} was refused or run with no card`).toBeTruthy();
    expect(record.card!.preview, route).toContain("You said no to deleting");
    expect(record.card!.buttons, route).not.toContain("always");
  }

  scenarioTest("rm sub/../denied: not read as `denied`, so not refused blind and not run alone", async () => {
    const s = await scenarios.start();
    mkdirSync(join(s.scratch, "sub"), { recursive: true });
    const denied = join(s.scratch, "denied.txt");
    writeFileSync(denied, "original");
    const record = await refuseThenTry(s, denied, "rm sub/../denied.txt");
    expectNamedCard(record, "rm sub/../denied.txt");
    expect(readFileSync(denied, "utf8")).toBe("original");
  });

  scenarioTest("rm link/denied through a folder link: not run alone", async () => {
    const s = await scenarios.start();
    mkdirSync(join(s.scratch, "real"), { recursive: true });
    const denied = join(s.scratch, "real", "denied.txt");
    writeFileSync(denied, "original");
    if (!linkFolder(join(s.scratch, "real"), join(s.scratch, "link"))) return; // no privilege to link here
    const record = await refuseThenTry(s, denied, "rm link/denied.txt");
    expectNamedCard(record, "rm link/denied.txt");
    expect(existsSync(denied)).toBe(true);
  });
});
