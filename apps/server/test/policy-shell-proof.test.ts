/**
 * The shell allowlist contract (policy/shell-proof.ts).
 *
 * A shell command is "proven" only when it is exactly one simple command, its program is in a small
 * known set, and every word is a plain literal. What a proven command touches is its literal path
 * arguments against the folder the server chose. Everything else is "unresolved": it is never read
 * for file names, and a run that holds a refusal asks the owner about it every time.
 */
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { hostPathOf, proveShell } from "../src/policy/shell-proof";
import type { Operation } from "../src/policy/types";

const HERE = resolve("/work/area");
const proofOf = (command: string, platform: NodeJS.Platform = process.platform) => proveShell(command, HERE, platform);

describe("a command is proven when it is one allowlisted program with plain literal words", () => {
  test.each<[string, Operation, string[]]>([
    ["rm q1", "delete", ["q1"]],
    ["rm -f -- q1", "delete", ["q1"]],
    ["rm -rf sub/q1 other.txt", "delete", ["sub/q1", "other.txt"]],
    ["   rm    q1   ", "delete", ["q1"]],
    ["rm ../q1", "delete", ["../q1"]],
    ["rm -rf .", "delete", ["."]],
    ["mv a b", "change", ["a", "b"]],
    ["cp -r a b", "change", ["a", "b"]],
    ["mkdir -p a/b", "change", ["a/b"]],
    ["touch a.txt", "change", ["a.txt"]],
    ["ls -la sub", "read", ["sub"]],
    ["ls", "read", []],
    ["cat a b", "read", ["a", "b"]],
    ["head -n 5 a", "read", ["a"]],
    ["head -n5 a", "read", ["a"]],
    ["tail -5 a", "read", ["a"]],
    ["wc -l a", "read", ["a"]],
    ["pwd", "read", []],
    ["date", "read", []],
    ["date +%Y-%m-%d", "read", []],
    ["echo hello world", "run", []],
    ["echo -n hi", "run", []],
  ])("%s", (command, operation, operands) => {
    const proof = proofOf(command);
    expect(proof.proven, `not proven: ${command}`).toBe(true);
    if (!proof.proven) return;
    expect(proof.operation).toBe(operation);
    expect(proof.paths).toEqual(operands.map((operand) => resolve(HERE, operand)));
  });
});

describe("everything else is unresolved", () => {
  test.each([
    // wrappers, with and without options that take a value
    ["a wrapper", "sudo rm q1"],
    ["a wrapper option taking a value (sudo -u)", "sudo -u x rm q1"],
    ["a wrapper option taking a value (env -u)", "env -u X rm q1"],
    ["a wrapper option taking a value (timeout -s)", "timeout -s KILL 5 rm q1"],
    ["a wrapper option taking a value (nice -n)", "nice -n 5 rm q1"],
    ["env with assignments", "env FOO=1 rm q1"],
    ["nohup", "nohup rm q1"],
    ["command", "command rm q1"],
    ["time", "time rm q1"],
    ["xargs", "ls | xargs rm"],
    ["doas", "doas rm q1"],
    // options that change the folder
    ["env -C", "env -C /tmp rm q1"],
    ["sudo -D", "sudo -D sub rm q1"],
    ["git -C", "git -C sub rm q1"],
    ["make -C", "make -C sub"],
    ["tar -C", "tar -C sub -xf a.tar"],
    ["cd", "cd sub"],
    ["cd then a path", "cd sub && rm ../q1"],
    ["pushd", "pushd sub"],
    ["cp -t (a folder named by an option)", "cp -t sub a"],
    ["cp -tsub fused", "cp -tsub a"],
    ["a long option", "rm --recursive q1"],
    ["a long option naming a folder", "ls --directory=sub"],
    ["an option the server does not know", "rm -x q1"],
    // structure
    ["a semicolon", "echo x;rm q1"],
    ["a semicolon with spaces", "echo x ; rm q1"],
    ["&&", "echo x && rm q1"],
    ["||", "false || rm q1"],
    ["a pipe", "ls | wc -l"],
    ["a pipe with stderr", "echo hi |& tee q1"],
    ["a background job", "rm q1 &"],
    ["a subshell", "(rm q1)"],
    ["a newline", "echo x\nrm q1"],
    ["a carriage return", "echo x\rrm q1"],
    // redirects
    ["an output redirect", "echo hi > q1"],
    ["an output redirect as the first word", "> q1"],
    ["a descriptor redirect", "2> q1"],
    ["&>", "echo hi &> q1"],
    ["an append redirect", "echo hi >> q1"],
    ["an input redirect", "wc < q1"],
    ["a descriptor copy", "echo hi 2>&1"],
    ["a here-document", "cat <<EOF\nhi\nEOF"],
    ["a here-string", "cat <<< hi"],
    ["a process substitution", "cat <(ls)"],
    // expansions and quoting
    ["a variable", "rm $F"],
    ["a braced variable", "rm ${F}"],
    ["a quoted variable", "rm \"$F\""],
    ["a positional parameter", "rm $1"],
    ["a command substitution", "echo $(rm q1)"],
    ["a command substitution as the program", "$(rm q1)"],
    ["backticks", "echo `rm q1`"],
    ["arithmetic", "echo $((1+1))"],
    ["a star glob", "rm q*"],
    ["a question-mark glob", "rm ./q?"],
    ["a bracket glob", "rm [q]1"],
    ["a glob in a folder", "rm */../q1"],
    ["brace expansion", "rm q{1,2}"],
    ["a brace range", "rm q{1..3}"],
    ["the home folder", "rm ~/old.txt"],
    ["another user's home", "rm ~root/q1"],
    ["single quotes", "rm 'q1'"],
    ["double quotes", "rm \"q1\""],
    ["a name split by quotes", "rm q''1"],
    ["a backslash", "rm q\\1"],
    ["a line continuation", "rm q\\\n1"],
    ["ANSI-C quoting", "rm $'q\\x31'"],
    ["a comment", "rm q1 #"],
    ["history expansion", "rm !$"],
    // assignments
    ["a leading assignment", "A=q rm q1"],
    ["an assignment alone", "F=q1"],
    ["a word with an equals sign", "rm a=b"],
    // programs
    ["a program that is not on the list", "make"],
    ["git", "git rm q1"],
    ["a program given by path", "/bin/rm q1"],
    ["a program in this folder", "./run.sh --flag"],
    ["a program with an extension", "rm.exe q1"],
    ["an upper-case spelling", "RM q1"],
    ["eval", "eval 'rm q1'"],
    ["source", "source ./go.sh"],
    ["a dot-sourced script", ". ./go.sh"],
    ["a second shell", "bash -c 'rm q1'"],
    ["a Windows shell", "cmd /c del q1"],
    ["PowerShell", "powershell -Command Remove-Item q1"],
    ["find with -delete", "find . -delete"],
    ["an interpreter with code", "python3 -c \"import os; os.remove('q1')\""],
    ["date setting the clock", "date -s tomorrow"],
    ["date with a time to set", "date 010100002027"],
    ["head with a value that is not a number", "head -n x a"],
    ["an empty command", ""],
    ["only blanks", "   "],
  ])("%s: %s", (_id, command) => {
    expect(proofOf(command).proven, `proven: ${JSON.stringify(command)}`).toBe(false);
  });

  test("an unresolved command carries no file names", () => {
    expect(proofOf("sudo rm q1")).toEqual({ proven: false, why: expect.any(String) as unknown as string });
  });
});

describe("on Windows a POSIX-style absolute path is unresolved unless the one normaliser converts it", () => {
  test.each([
    ["/c/Users/a/q1", "C:\\Users\\a\\q1"],
    ["/C/Users/a/q1", "C:\\Users\\a\\q1"],
    ["/d/data/q1", "D:\\data\\q1"],
    ["/c", "C:\\"],
    ["/c/", "C:\\"],
    ["/cygdrive/c/Users/a/q1", "C:\\Users\\a\\q1"],
    ["/mnt/c/Users/a/q1", "C:\\Users\\a\\q1"],
    ["//?/C:/Users/a/q1", "C:\\Users\\a\\q1"],
    ["//?/c:/Users/a/q1", "C:\\Users\\a\\q1"],
    ["C:/Users/a/q1", "C:/Users/a/q1"],
    ["sub/q1", "sub/q1"],
    ["../q1", "../q1"],
    ["q1", "q1"],
    [".", "."],
  ])("%s becomes %s", (word, expected) => {
    expect(hostPathOf(word, "win32")).toBe(expected);
  });

  test.each([
    ["a POSIX path with no drive", "/tmp/q1"],
    ["the root", "/"],
    ["a UNC share", "//server/share/q1"],
    ["a UNC share in the long form", "//?/UNC/server/share/q1"],
    ["a device path", "//./C:/q1"],
    ["a name that only starts like a mount", "/cygdrive"],
    ["a mount with a long name", "/cdrive/x"],
    ["a drive with no slash", "C:q1"],
    ["a data stream", "q1:stream"],
    ["a trailing dot, which Windows drops", "q1."],
    ["a trailing dot inside a path", "sub./q1"],
    ["a drive letter in the middle", "sub/C:/q1"],
    ["a backslash", "C:\\Users\\q1"],
  ])("%s is unresolved", (_id, word) => {
    expect(hostPathOf(word, "win32")).toBeNull();
  });

  test("elsewhere a path is what it says", () => {
    expect(hostPathOf("/tmp/q1", "linux")).toBe("/tmp/q1");
    expect(hostPathOf("/c/q1", "darwin")).toBe("/c/q1");
  });

  test("a command with a Git Bash path is proven only through the normaliser", () => {
    expect(proofOf("rm /c/Users/a/q1", "win32").proven).toBe(true);
    expect(proofOf("rm /cygdrive/c/Users/a/q1", "win32").proven).toBe(true);
    expect(proofOf("rm //?/C:/Users/a/q1", "win32").proven).toBe(true);
    expect(proofOf("rm /mnt/c/Users/a/q1", "win32").proven).toBe(true);
    expect(proofOf("rm /tmp/q1", "win32").proven).toBe(false);
    expect(proofOf("rm /tmp/q1", "linux").proven).toBe(true);
  });

  test("the long-path prefix is the only place a `?` is let through, and only on Windows", () => {
    expect(proofOf("rm //?/C:/x", "win32").proven).toBe(true);
    expect(proofOf("rm //?/C:/x?", "win32").proven).toBe(false);
    expect(proofOf("rm //?/x", "win32").proven).toBe(false);
    expect(proofOf("rm /c?/x", "win32").proven).toBe(false);
    // Elsewhere `//?/C:/x` is a pattern that can match a one-letter folder.
    expect(proofOf("rm //?/C:/x", "linux").proven).toBe(false);
  });

  test.skipIf(process.platform !== "win32")("its path is the C:\\ one the denials use", () => {
    const proof = proofOf("rm /c/Users/a/q1");
    expect(proof.proven && proof.paths).toEqual([resolve("C:\\Users\\a\\q1")]);
  });
});
