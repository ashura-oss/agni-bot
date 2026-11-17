/**
 * The free read-only gate (`isReadOnlyCommand`, tools/bash.ts) and the shell allowlist (policy/shell-proof.ts) are one list:
 * a command the gate runs without a card is one the policy can read file names from. A command the proof cannot read
 * (`l/../x` through a link, an option it does not name) is never free, so a clean run does not read what a refusal run would ask about.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { isReadOnlyCommand } from "../src/tools/bash";
import { proveShell, READ_ONLY_PROGRAMS } from "../src/policy/shell-proof";

const WINDOWS = process.platform === "win32";
let root = "";
let scratch = "";
let saved: string | undefined;

/** Can this account make a folder link? Asked once with a throwaway folder, so the test that needs one is reported as skipped for want of one, not passed. */
const CAN_LINK = (() => {
  const probe = mkdtempSync(join(tmpdir(), "agni-ro-gate-probe-"));
  try {
    mkdirSync(join(probe, "target"));
    symlinkSync(join(probe, "target"), join(probe, "link"), WINDOWS ? "junction" : "dir");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "agni-ro-gate-"));
  scratch = join(root, "scratch");
  mkdirSync(join(scratch, "sub"), { recursive: true });
  mkdirSync(join(root, "outside", "deep"), { recursive: true });
  mkdirSync(join(root, "outside", ".ssh"), { recursive: true });
  writeFileSync(join(root, "outside", ".ssh", "id_rsa"), "PRIVATE KEY");
  writeFileSync(join(scratch, "notes.txt"), "notes");
  if (CAN_LINK) symlinkSync(join(root, "outside", "deep"), join(scratch, "l"), WINDOWS ? "junction" : "dir");
  saved = process.env.AGNI_SCRATCH_DIR;
  process.env.AGNI_SCRATCH_DIR = scratch;
});
afterAll(() => {
  if (saved === undefined) delete process.env.AGNI_SCRATCH_DIR; else process.env.AGNI_SCRATCH_DIR = saved;
  rmSync(root, { recursive: true, force: true });
});

describe("a command the shell proof cannot read is not free", () => {
  test.skipIf(!CAN_LINK)("`cat l/../.ssh/id_rsa` through a link in scratch needs a card (needs an account that can make a folder link)", () => {
    expect(isReadOnlyCommand("cat l/../.ssh/id_rsa")).toBe(false);
    expect(isReadOnlyCommand("cat l/deep-file")).toBe(false);
  });

  test("an operand with `..` needs a card even when it climbs back inside scratch", () => {
    expect(isReadOnlyCommand("cat sub/../notes.txt")).toBe(false);
    expect(isReadOnlyCommand("cat sub/notes.txt")).toBe(true);
  });

  test("an option the proof does not name needs a card", () => {
    expect(isReadOnlyCommand("ls --all")).toBe(false);
    expect(isReadOnlyCommand("cat --help")).toBe(false);
    expect(isReadOnlyCommand("ls -Z")).toBe(false);
  });
});

describe("the gate and the proof are one list", () => {
  test("every program on the read-only list is free bare, and proven", () => {
    for (const program of READ_ONLY_PROGRAMS) {
      expect({ program, free: isReadOnlyCommand(program), proven: proveShell(program, scratch).proven }).toEqual({ program, free: true, proven: true });
    }
  });

  test("`ls -1` is free and proven: the option is on the list, so the regex must read it", () => {
    expect(isReadOnlyCommand("ls -1")).toBe(true);
    expect(proveShell("ls -1", scratch).proven).toBe(true);
    expect(isReadOnlyCommand("ls -1 sub")).toBe(true);
  });

  test("`date` is free exactly when the proof proves it: one definition of what reads the clock and what sets it", () => {
    const free = ["date", "date -u", "date +%F", "date -u +%F", "date +%F -u"];
    const needsCard = ["date -s tomorrow", "date 010100002027", "date +%F +%T", "date -u -s tomorrow", "date -d yesterday", "date --set=tomorrow"];
    for (const command of free) expect({ command, free: isReadOnlyCommand(command), proven: proveShell(command, scratch).proven }).toEqual({ command, free: true, proven: true });
    for (const command of needsCard) expect({ command, free: isReadOnlyCommand(command), proven: proveShell(command, scratch).proven }).toEqual({ command, free: false, proven: false });
  });

  test("a mutating program is not on the list", () => {
    for (const program of ["rm", "cp", "mv", "mkdir", "touch"]) expect(READ_ONLY_PROGRAMS.has(program), program).toBe(false);
  });

  test("whatever the gate frees, the proof proves: no free command is left unread", () => {
    const programs = [...READ_ONLY_PROGRAMS, "rm", "cp", "date"];
    const words = ["", "-1", "-a", "-la", "-n 5", "-5", "-c3", "--all", "-Z", "notes.txt", "sub", "sub/../notes.txt", "..", "+%F", "-u", "-s", "x%y", "-lh", "-d", "."];
    let freed = 0;
    for (const program of programs) {
      for (const first of words) for (const second of ["", ...words.slice(0, 8)]) {
        const command = [program, first, second].filter(Boolean).join(" ");
        if (!isReadOnlyCommand(command)) continue;
        freed += 1;
        expect(proveShell(command, scratch).proven, `freed but not proven: ${command}`).toBe(true);
      }
    }
    expect(freed, "the sample freed nothing, so it proves nothing").toBeGreaterThan(30);
  });
});
