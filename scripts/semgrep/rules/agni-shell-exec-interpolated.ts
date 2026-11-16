import { exec, execFileSync, execSync } from "node:child_process";

export function positive(branch: string, name: string): void {
  // ruleid: agni-shell-exec-interpolated
  execSync(`git checkout ${branch}`);
  // ruleid: agni-shell-exec-interpolated
  exec("echo " + name, () => {});
  // ruleid: agni-shell-exec-interpolated
  exec(name + " --version", () => {});
}

export function negative(branch: string, db: { exec(sql: string): void }): void {
  // ok: agni-shell-exec-interpolated
  execFileSync("git", ["checkout", branch]);
  // ok: agni-shell-exec-interpolated
  execSync("git status --short");
  // ok: agni-shell-exec-interpolated
  db.exec(`PRAGMA user_version = ${Number(branch)}`);
}
