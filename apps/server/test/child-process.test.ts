/**
 * S2-14: what a shell child may see and do. Server-chosen working directory,
 * the whole process tree dies on timeout or abort, output is capped in bytes,
 * and the daemon's own child gets the allowlisted environment. Every value
 * is made up; every home is a throwaway folder.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BashRefusal, bashCwdProblem, isReadOnlyCommand, MAX_OUTPUT_BYTES, runBash } from "../src/tools/bash";
import { isProcessAlive, startDaemon } from "../src/daemon";
import type { Config } from "../src/config";

const FAKE = "fake-key-value-do-not-use-0123456789";
const created: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
let home = "";
let scratch = "";
const spawnedPids: number[] = [];

function setEnv(name: string, value: string): void {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name];
  process.env[name] = value;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agni-child-proc-")); created.push(home);
  scratch = join(home, "scratch");
  mkdirSync(scratch, { recursive: true });
  setEnv("AGNI_HOME", home);
  setEnv("AGNI_SCRATCH_DIR", scratch);
});

afterEach(() => {
  for (const pid of spawnedPids.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
    delete savedEnv[name];
  }
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});

const sh = (path: string): string => path.replaceAll("\\", "/");

/** A shell command that starts a long-lived grandchild (Bun) which records its own OS pid, then waits for it. */
function grandchildCommand(pidFile: string): string {
  const script = `require("fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)`;
  return `'${sh(process.execPath)}' -e '${script}' '${sh(pidFile)}' & wait`;
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await Bun.sleep(50);
  }
  return check();
}

const readPid = (pidFile: string): number => Number(readFileSync(pidFile, "utf8"));

describe("server-chosen working directory", () => {
  test("a cwd outside scratch is refused with a structured error and the command never runs", async () => {
    const outside = mkdtempSync(join(tmpdir(), "agni-child-outside-")); created.push(outside);
    const marker = join(outside, "ran.txt");
    const error = await runBash({ command: `echo hi > '${sh(marker)}'`, cwd: outside }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BashRefusal);
    expect((error as BashRefusal).code).toBe("cwd_outside_scratch");
    expect((error as BashRefusal).message).toContain(scratch);
    expect(existsSync(marker)).toBe(false);
  });

  test("dot-dot, an absolute path elsewhere, and a link out of scratch are all outside", async () => {
    const outside = mkdtempSync(join(tmpdir(), "agni-child-outside-")); created.push(outside);
    symlinkSync(outside, join(scratch, "escape"), "junction");
    for (const cwd of ["..", join("sub", "..", ".."), outside, "escape", join("escape", "deeper")]) {
      expect(bashCwdProblem(cwd)).not.toBeNull();
      await expect(runBash({ command: "pwd", cwd })).rejects.toBeInstanceOf(BashRefusal);
    }
  });

  test("no cwd, an empty cwd, and a path inside scratch are accepted; a relative one means under scratch", async () => {
    const plain = await runBash({ command: "pwd" });
    expect(plain.exitCode).toBe(0);
    const blank = await runBash({ command: "pwd", cwd: "  " });
    expect(blank.stdout).toBe(plain.stdout);
    const nested = await runBash({ command: "pwd", cwd: join("a", "b") });
    expect(nested.exitCode).toBe(0);
    expect(nested.stdout.endsWith("/a/b")).toBe(true);
    expect(existsSync(join(scratch, "a", "b"))).toBe(true);
    const absolute = await runBash({ command: "pwd", cwd: join(scratch, "a") });
    expect(absolute.stdout.endsWith("/a")).toBe(true);
    expect(bashCwdProblem(undefined)).toBeNull();
    expect(bashCwdProblem(join(scratch, "a"))).toBeNull();
  });
});

describe("isReadOnlyCommand and date", () => {
  test("bare date and date +FORMAT are read-only", () => {
    expect(isReadOnlyCommand("date")).toBe(true);
    expect(isReadOnlyCommand("date +%Y-%m-%d")).toBe(true);
    expect(isReadOnlyCommand("date +%s")).toBe(true);
  });

  test("any option can set the clock or read files, so it needs the owner's click", () => {
    for (const command of ["date -s 2030-01-01", "date --set=2030-01-01", "date -u", "date -d tomorrow", "date --date=tomorrow", "date -r somefile", "date --utc", "date -I", "date -f dates.txt", "date -u +%s", "date +%s -s x", "date 010112002030", "date +%Y %m"]) {
      expect(isReadOnlyCommand(command)).toBe(false);
    }
  });

  test("the other read-only programs keep working", () => {
    expect(isReadOnlyCommand("pwd")).toBe(true);
    expect(isReadOnlyCommand("ls -la")).toBe(true);
    expect(isReadOnlyCommand("cat /etc/passwd")).toBe(false);
  });
});

describe("process-tree kill", () => {
  test("a timeout kills the grandchild too", async () => {
    const pidFile = join(scratch, "grandchild.pid");
    const started = Date.now();
    const result = await runBash({ command: grandchildCommand(pidFile), timeoutMs: 3_000 });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(12_000);
    expect(existsSync(pidFile)).toBe(true);
    const pid = readPid(pidFile);
    spawnedPids.push(pid);
    expect(await waitFor(() => !isProcessAlive(pid), 5_000)).toBe(true);
  }, 20_000);

  test("an abort kills the grandchild too and says it was aborted", async () => {
    const pidFile = join(scratch, "grandchild-abort.pid");
    const controller = new AbortController();
    const running = runBash({ command: grandchildCommand(pidFile), timeoutMs: 60_000, signal: controller.signal });
    expect(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").length > 0, 10_000)).toBe(true);
    const pid = readPid(pidFile);
    spawnedPids.push(pid);
    expect(isProcessAlive(pid)).toBe(true);
    controller.abort();
    const result = await running;
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(await waitFor(() => !isProcessAlive(pid), 5_000)).toBe(true);
  }, 25_000);

  test("a Git Bash (MSYS) grandchild is killed too, even though MSYS breaks the parent links", async () => {
    // `sleep` here is an MSYS program started through MSYS fork/exec: on Windows its
    // parent process is already gone, so a tree walk from the shell never finds it.
    // The command records the real (OS) pid of the background sleep.
    const pidFile = join(scratch, "msys-sleep.pid");
    const seconds = 700 + Math.floor(Math.random() * 200);
    const command = `sleep ${seconds} & sleep 0.5; (cat /proc/$!/winpid 2>/dev/null || echo $!) > '${sh(pidFile)}'; wait`;
    const started = Date.now();
    const result = await runBash({ command, timeoutMs: 3_000 });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000); // not the 5 s give-up after the kill
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(pid).toBeGreaterThan(0);
    spawnedPids.push(pid);
    expect(await waitFor(() => !isProcessAlive(pid), 5_000)).toBe(true);
  }, 25_000);

  test("a background process does not outlive the command that started it (nohup, with the pipes still inherited)", async () => {
    const pidFile = join(scratch, "nohup-sleep.pid");
    const seconds = 600 + Math.floor(Math.random() * 100);
    const command = `nohup sleep ${seconds} & sleep 0.5; (cat /proc/$!/winpid 2>/dev/null || echo $!) > '${sh(pidFile)}'; echo done`;
    const started = Date.now();
    const result = await runBash({ command, timeoutMs: 30_000 });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toContain("done");
    expect(Date.now() - started).toBeLessThan(15_000); // not held open by the sleeper's copy of the pipe
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(pid).toBeGreaterThan(0);
    spawnedPids.push(pid);
    expect(await waitFor(() => !isProcessAlive(pid), 5_000)).toBe(true);
  }, 40_000);

  test("a background process with its output redirected away does not survive either", async () => {
    const pidFile = join(scratch, "bg-quiet.pid");
    const seconds = 700 + Math.floor(Math.random() * 100);
    const command = `sleep ${seconds} > /dev/null 2>&1 & sleep 0.5; (cat /proc/$!/winpid 2>/dev/null || echo $!) > '${sh(pidFile)}'`;
    const result = await runBash({ command, timeoutMs: 30_000 });
    expect(result.exitCode).toBe(0);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    spawnedPids.push(pid);
    expect(await waitFor(() => !isProcessAlive(pid), 5_000)).toBe(true);
  }, 40_000);

  test("a signal that is already aborted runs nothing", async () => {
    const marker = join(scratch, "should-not-exist.txt");
    const controller = new AbortController();
    controller.abort();
    const result = await runBash({ command: `echo hi > '${sh(marker)}'`, signal: controller.signal });
    expect(result.aborted).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("output caps", () => {
  test("stdout is cut at the byte cap with a marker and the result says so", async () => {
    const result = await runBash({ command: "head -c 50000 /dev/zero | tr '\\0' 'a'", maxOutputBytes: 1_000 });
    expect(result.outputTruncated).toBe(true);
    expect(result.stdout.startsWith("a".repeat(1_000))).toBe(true);
    expect(result.stdout).toMatch(/\[output truncated at 1000 bytes\]$/);
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(1_000 + 100);
  });

  test("stderr has its own cap", async () => {
    const result = await runBash({ command: "head -c 50000 /dev/zero | tr '\\0' 'b' >&2; echo out", maxOutputBytes: 1_000 });
    expect(result.stdout).toBe("out");
    expect(result.stderr).toMatch(/\[output truncated at 1000 bytes\]$/);
    expect(result.outputTruncated).toBe(true);
  });

  test("the cap counts bytes, and a multi-byte character is never split", async () => {
    const result = await runBash({ command: "i=0; while [ $i -lt 2000 ]; do printf '\\303\\251'; i=$((i+1)); done", maxOutputBytes: 1_001 });
    expect(result.stdout).not.toContain("�");
    const body = result.stdout.replace(/\n\[output truncated at 1001 bytes\]$/, "");
    expect(body).toBe("é".repeat(500));
  });

  test("output under the cap is returned whole, untouched", async () => {
    const result = await runBash({ command: "printf 'one\\ntwo'", maxOutputBytes: 1_000 });
    expect(result.stdout).toBe("one\ntwo");
    expect(result.outputTruncated).toBe(false);
  });

  test("the default cap is MAX_OUTPUT_BYTES per stream and the stream is still drained", async () => {
    expect(MAX_OUTPUT_BYTES).toBe(1024 * 1024);
    const result = await runBash({ command: "head -c 3000000 /dev/zero | tr '\\0' 'c'; echo done >&2" });
    expect(result.exitCode).toBe(0);
    expect(result.outputTruncated).toBe(true);
    expect(result.stdout.startsWith("c".repeat(MAX_OUTPUT_BYTES))).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(MAX_OUTPUT_BYTES + 100);
    expect(result.stderr).toBe("done");
  });
});

describe("the shell child's environment", () => {
  test("only allowlisted variables reach the command; a stranger and a secret do not", async () => {
    setEnv("OPENROUTER_API_KEY", FAKE);
    setEnv("CHILD_TEST_STRANGER", "visible-if-leaked");
    setEnv("AGNI_TOKEN", FAKE);
    const result = await runBash({ command: "env" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(FAKE);
    expect(result.stdout).not.toContain("visible-if-leaked");
    expect(result.stdout).not.toMatch(/CHILD_TEST_STRANGER|OPENROUTER_API_KEY|AGNI_TOKEN|AGNI_HOME/);
  });

  test("PATH is the fixed one: a directory on the server's PATH is not on the child's", async () => {
    const planted = join(home, "planted-bin");
    mkdirSync(planted, { recursive: true });
    writeFileSync(join(planted, "ls"), "#!/bin/sh\necho planted\n", { mode: 0o755 });
    setEnv("PATH", `${planted}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`);
    const result = await runBash({ command: 'echo "$PATH"; ls /' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toLowerCase()).not.toContain("planted-bin");
    expect(result.stdout).not.toContain("planted\n");
  });

  test.skipIf(process.platform !== "win32")("Windows: Git's own tools come first and git still works", async () => {
    const result = await runBash({ command: "command -v sort; git --version" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^\/usr\/bin\/sort$/m);
    expect(result.stdout).toMatch(/git version/);
  });
});

describe("the daemon's child", () => {
  test("`serve` is spawned with the allowlisted environment only", async () => {
    setEnv("CHILD_TEST_STRANGER", "visible-if-leaked");
    setEnv("GITHUB_TOKEN", FAKE);
    setEnv("AGNI_CHILD_TEST_MARKER", "kept");
    setEnv("OPENROUTER_API_KEY", FAKE);
    const out = join(home, "env-keys.json");
    const entry = join(home, "probe-entry.ts");
    writeFileSync(entry, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(out)}, JSON.stringify(process.env));\n`);
    const config = { host: "127.0.0.1", port: 1, pidPath: join(home, "agni.pid"), logPath: join(home, "agni.log") } as Config;
    const outcome = await startDaemon(config, { entryPath: entry, readyTimeoutMs: 3_000 });
    expect(outcome.ok).toBe(false); // the probe exits at once: it is not a server
    expect(await waitFor(() => existsSync(out), 5_000)).toBe(true);
    const seen = JSON.parse(readFileSync(out, "utf8")) as Record<string, string>;
    expect(seen.AGNI_CHILD_TEST_MARKER).toBe("kept");
    expect(seen.OPENROUTER_API_KEY).toBe(FAKE); // the server itself needs its provider keys
    expect(seen.CHILD_TEST_STRANGER).toBeUndefined();
    expect(seen.GITHUB_TOKEN).toBeUndefined();
  }, 20_000);
});
