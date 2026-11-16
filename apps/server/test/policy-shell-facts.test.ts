/**
 * What the policy engine reads out of a shell line (policy/resources.ts `shellFacts`, on top of policy/shell-proof.ts).
 *
 * A proven command names the files it was given and nothing else; any other command names no file at all, so
 * nothing here can be dodged by how a line is written, and nothing is guessed. What the engine does with an
 * unproven command in a run that holds a refusal is in invariants/denial-shell-allowlist.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isReadOnlyCommand } from "../src/tools/bash";
import { foldPath, shellFacts, shellWorkingDir } from "../src/policy/resources";
import type { Operation } from "../src/policy/types";

let root: string;
let saved: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agni-shell-facts-"));
  mkdirSync(join(root, "scratch"), { recursive: true });
  saved = process.env.AGNI_SCRATCH_DIR;
  process.env.AGNI_SCRATCH_DIR = join(root, "scratch");
});
afterEach(() => {
  if (saved === undefined) delete process.env.AGNI_SCRATCH_DIR; else process.env.AGNI_SCRATCH_DIR = saved;
  rmSync(root, { recursive: true, force: true });
});

const HERE = (): string => shellWorkingDir(undefined);
const keyOf = (name: string): string => foldPath(resolve(HERE(), name));
const keys = (command: string): string[] => shellFacts(command, HERE()).resources.map((resource) => resource.value);

describe("a proven command names the files it was given", () => {
  test.each<[string, Operation, string[]]>([
    ["rm q1", "delete", ["q1"]],
    ["rm -rf sub/q1 other.txt", "delete", ["sub/q1", "other.txt"]],
    ["mv a b", "change", ["a", "b"]],
    ["touch a.txt", "change", ["a.txt"]],
    ["cat q1", "read", ["q1"]],
    ["echo hi", "run", []],
  ])("%s", (command, operation, names) => {
    const facts = shellFacts(command, HERE());
    expect(facts.proven).toBe(true);
    expect(facts.operation).toBe(operation);
    expect(keys(command)).toEqual(names.map(keyOf));
  });

  test("a program name is not a file, and an option is not a file", () => {
    expect(keys("touch a.txt")).not.toContain(keyOf("touch"));
    expect(keys("rm -rf a")).toEqual([keyOf("a")]);
  });
});

describe("any other command names no file and is a plain `run`", () => {
  test.each([
    "echo start ; touch a.txt",
    "sudo rm q1",
    "rm $F",
    "rm q*",
    "echo hi > q1",
    "> q1",
    "F=q1 true",
    "cd sub && rm ../q1",
    "echo hi 2>&1",
  ])("%s", (command) => {
    expect(shellFacts(command, HERE())).toEqual({ proven: false, operation: "run", resources: [] });
  });
});

describe("the allowlist covers what the free read-only gate frees, so a free command is never left unread", () => {
  test.each([
    "ls", "ls -la", "ls sub", "cat a.txt", "head -n 5 a.txt", "tail -5 a.txt", "wc -l a.txt", "pwd", "echo hi", "date", "date +%F",
    "whoami", "uname -a", "which ls", "file a.txt", "stat a.txt", "du -sh sub", "df -h",
  ])("%s", (command) => {
    expect(isReadOnlyCommand(command), `the gate no longer frees it: ${command}`).toBe(true);
    expect(shellFacts(command, HERE()).proven, `freed by the read-only gate but not provable: ${command}`).toBe(true);
  });
});

describe("the folder a command runs in", () => {
  test("a relative cwd is under scratch, like the folder the shell is started in", () => {
    const dir = shellWorkingDir("sub");
    expect(dir.endsWith(join("sub"))).toBe(true);
    expect(shellWorkingDir(undefined)).toBe(shellWorkingDir(""));
    expect(shellWorkingDir("sub").startsWith(shellWorkingDir(undefined))).toBe(true);
  });

  test("a relative path is read against that folder, not against scratch", () => {
    expect(shellFacts("rm q1", shellWorkingDir("sub")).resources.map((resource) => resource.value)).toEqual([foldPath(resolve(shellWorkingDir("sub"), "q1"))]);
  });
});
