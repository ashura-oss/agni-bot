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
let linked = false;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "agni-ro-gate-"));
  scratch = join(root, "scratch");
  mkdirSync(join(scratch, "sub"), { recursive: true });
  mkdirSync(join(root, "outside", "deep"), { recursive: true });
  mkdirSync(join(root, "outside", ".ssh"), { recursive: true });
  writeFileSync(join(root, "outside", ".ssh", "id_rsa"), "PRIVATE KEY");
  writeFileSync(join(scratch, "notes.txt"), "notes");
  try { symlinkSync(join(root, "outside", "deep"), join(scratch, "l"), WINDOWS ? "junction" : "dir"); linked = true; } catch { linked = false; }
  saved = process.env.AGNI_SCRATCH_DIR;
  process.env.AGNI_SCRATCH_DIR = scratch;
});
afterAll(() => {
  if (saved === undefined) delete process.env.AGNI_SCRATCH_DIR; else process.env.AGNI_SCRATCH_DIR = saved;
  rmSync(root, { recursive: true, force: true });
});

describe("a command the shell proof cannot read is not free", () => {
  test("`cat l/../.ssh/id_rsa` through a link in scratch needs a card", () => {
    if (!linked) return; // this account cannot make a folder link
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
