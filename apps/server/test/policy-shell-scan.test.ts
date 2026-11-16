/**
 * What the policy engine reads out of a shell line (policy/shell-scan.ts, policy/resources.ts).
 * These extractors feed denials ("the owner said no to this file"), so they over-approximate:
 * every word is a candidate, and anything the server cannot resolve to a file name is said so.
 */
import { describe, expect, test } from "bun:test";
import type { Operation } from "../src/policy/types";
import { join, resolve } from "node:path";
import { scanShell } from "../src/policy/shell-scan";
import { commandOperation, commandResources, foldPath, shellCandidates, shellWorkingDir } from "../src/policy/resources";

const words = (command: string): string[] => scanShell(command).words;
const unresolved = (command: string): string[] => scanShell(command).unresolved;
const HERE = resolve("/work/area");
const keyOf = (name: string): string => foldPath(resolve(HERE, name));
const candidateKeys = (command: string): string[] => shellCandidates(command, HERE).map((resource) => resource.value);

describe("every word is a candidate; nothing is dropped", () => {
  test.each([
    ["a second command after a semicolon", "echo x;rm q1"],
    ["a command substitution", "echo $(rm q1)"],
    ["a command substitution as the first token", "$(rm q1)"],
    ["backticks", "echo `rm q1`"],
    ["output redirected with &>", "echo hi &> q1"],
    ["stderr to stdout, then a redirect", "echo hi 2>&1 > q1"],
    ["piped through tee with |&", "echo hi |& tee q1"],
    ["a redirect as the first token", "> q1"],
    ["a descriptor redirect as the first token", "2> q1"],
    ["an append redirect", "echo hi >> q1"],
    ["an input redirect", "wc < q1"],
    ["after a flag", "rm -f -- q1"],
    ["a quoted word", "rm 'q1'"],
    ["the name split by quotes", "rm q''1"],
    ["a leading assignment's own command", "X=1 rm q1"],
    ["inside a quoted string for another shell", "sh -c \"cd sub; rm q1\""],
    ["a flag with the path fused on", "cc -oq1 main.c"],
    ["a flag with the path after an equals sign", "tool --output=q1"],
    ["the value of an assignment", "F=q1"],
    ["a name with a backslash in it", "rm q\\1"],
  ])("%s names the file", (_id, command) => {
    expect(candidateKeys(command)).toContain(keyOf("q1"));
  });

  test("the program name is a candidate too: a file can be named like a program", () => {
    expect(candidateKeys("touch b.txt")).toContain(keyOf("touch"));
    expect(candidateKeys("./run.sh")).toContain(keyOf("run.sh"));
  });

  test("a line continuation joins the word", () => {
    expect(candidateKeys("rm q\\\n1")).toContain(keyOf("q1"));
  });
});

describe("what the server cannot resolve to file names is said so", () => {
  test.each([
    ["a variable", "rm $F"],
    ["a braced variable", "rm ${F}"],
    ["a variable in double quotes", "rm \"$F\""],
    ["a positional or special parameter", "rm $1"],
    ["a command substitution", "echo $(rm q1)"],
    ["arithmetic", "echo $((1+1))"],
    ["backticks", "echo `rm q1`"],
    ["backticks in double quotes", "echo \"`rm q1`\""],
    ["a star glob", "rm q*"],
    ["a question-mark glob", "rm ./q?"],
    ["a bracket glob", "rm [q]1"],
    ["a glob in a folder component", "rm */../q1"],
    ["brace expansion", "rm q{1,2}"],
    ["a numeric brace range", "rm q{1..3}"],
    ["a home folder of another user", "rm ~root/q1"],
    ["ANSI-C quoting", "rm $'q\\x31'"],
    ["eval", "eval 'rm q1'"],
    ["source", "source ./go.sh"],
    ["a dot-sourced script", ". ./go.sh"],
    ["an alias", "alias gone='rm q1'; gone"],
    ["xargs", "ls | xargs rm"],
    ["find -exec", "find . -name q1 -exec rm {} \\;"],
    ["find -execdir", "find . -execdir rm {} +"],
    ["find -delete", "find . -name q1 -delete"],
    ["a here-document", "cat <<EOF\nhi\nEOF"],
    ["a here-string", "cat <<< hi"],
    ["a process substitution", "diff <(ls) q1"],
    ["cd before a path", "cd sub && rm ../q1"],
    ["pushd", "pushd sub"],
    ["a second shell", "bash -c 'rm q1'"],
    ["a second shell by path", "/bin/sh script.sh"],
    ["a Windows shell", "cmd /c del q1"],
    ["PowerShell", "powershell -Command Remove-Item q1"],
    ["an interpreter with inline code", "python3 -c \"import os; os.remove('q1')\""],
    ["node with inline code", "node -e \"require('fs').rmSync('q1')\""],
    ["awk, which can run commands", "awk 'BEGIN{system(\"rm q1\")}'"],
  ])("%s", (_id, command) => {
    expect(unresolved(command).length, `nothing flagged in: ${command}`).toBeGreaterThan(0);
  });

  test.each([
    ["a plain delete", "rm q1"],
    ["a quoted name with a space", "rm \"a b\""],
    ["single quotes keep a dollar literal", "echo 'a $X * ? `no`'"],
    ["double quotes keep a star literal", "rm \"*\""],
    ["a redirect to a plain file", "echo hi > out.txt"],
    ["a descriptor copy", "echo hi 2>&1"],
    ["the home folder", "rm ~/old.txt"],
    ["a pipeline of plain programs", "ls -la | wc -l"],
    ["a curly brace without a list", "echo {}"],
    ["an absolute path", "rm /tmp/some/file.txt"],
    ["a script run by path", "./run.sh --flag value"],
  ])("a plain line is not flagged: %s", (_id, command) => {
    expect(unresolved(command)).toEqual([]);
  });
});

describe("the operation a command performs, wherever it hides", () => {
  test.each<[string, Operation]>([
    ["rm q1", "delete"],
    ["echo x;rm q1", "delete"],
    ["$(rm q1)", "delete"],
    ["echo `rm q1`", "delete"],
    ["X=1 rm q1", "delete"],
    ["sudo rm q1", "delete"],
    ["env FOO=1 rm q1", "delete"],
    ["echo a | xargs rm", "delete"],
    ["mv a b", "change"],
    ["echo hi > q1", "change"],
    ["echo hi &> q1", "change"],
    ["echo hi 2> q1", "change"],
    ["echo hi |& tee q1", "change"],
    ["> q1", "change"],
    ["echo hi >> q1", "change"],
    ["echo hi", "run"],
    ["echo hi 2>&1", "run"],
    ["wc < q1", "run"],
  ])("%s is a %s", (command, operation) => {
    expect(commandOperation(command)).toBe(operation);
  });
});

describe("what a command is recorded as working on (the denied thing)", () => {
  test("a refused `echo start ; touch a.txt` names a.txt and no program", () => {
    const keys = commandResources("echo start ; touch a.txt", HERE).map((resource) => resource.value);
    expect(keys).toContain(keyOf("a.txt"));
    expect(keys).not.toContain(keyOf("touch"));
    expect(keys).not.toContain(keyOf("echo"));
  });

  test("a redirect target is recorded even as the first token", () => {
    expect(commandResources("> q1", HERE).map((resource) => resource.value)).toContain(keyOf("q1"));
  });

  test("a redirect target after &> is recorded", () => {
    expect(commandResources("echo hi &> q1", HERE).map((resource) => resource.value)).toContain(keyOf("q1"));
  });

  test("an assignment value is recorded", () => {
    expect(commandResources("F=q1 true", HERE).map((resource) => resource.value)).toContain(keyOf("q1"));
  });

  test("a file descriptor copy is not recorded as a file", () => {
    expect(commandResources("echo hi 2>&1", HERE).map((resource) => resource.value)).not.toContain(keyOf("1"));
  });
});

describe("the folder a command runs in", () => {
  test("a relative cwd is under scratch, like the folder the shell is started in", () => {
    const dir = shellWorkingDir("sub");
    expect(dir.endsWith(join("sub"))).toBe(true);
    expect(shellWorkingDir(undefined)).toBe(shellWorkingDir(""));
    expect(shellWorkingDir("sub").startsWith(shellWorkingDir(undefined))).toBe(true);
  });
});
