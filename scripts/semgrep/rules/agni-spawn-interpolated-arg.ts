import { execFileSync, spawn } from "node:child_process";

export function positive(userValue: string, repo: string): void {
  // ruleid: agni-spawn-interpolated-arg
  spawn(`git clone ${repo}`);
  // ruleid: agni-spawn-interpolated-arg
  spawn("bash", ["-c", `echo ${userValue}`]);
  // ruleid: agni-spawn-interpolated-arg
  Bun.spawn(["git", "clone", `--depth=${userValue}`, repo]);
  // ruleid: agni-spawn-interpolated-arg
  Bun.spawn({ cmd: ["git", "log", "--author=" + userValue] });
  // ruleid: agni-spawn-interpolated-arg
  execFileSync("tool", ["--name", "prefix-" + userValue]);
  // ruleid: agni-spawn-interpolated-arg
  spawn("ls", ["-la"], { shell: true });
}

export function negative(userValue: string, repo: string): void {
  // ok: agni-spawn-interpolated-arg
  spawn("git", ["clone", "--", repo]);
  // ok: agni-spawn-interpolated-arg
  Bun.spawn(["git", "log", userValue], { stdout: "ignore" });
  // ok: agni-spawn-interpolated-arg
  Bun.spawn({ cmd: [process.execPath, "serve"], detached: true });
  // ok: agni-spawn-interpolated-arg
  execFileSync("icacls", [userValue, "/save", "out.txt"]);
}
