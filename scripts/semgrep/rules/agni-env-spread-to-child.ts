import { exec, execSync, spawn, execFileSync } from "node:child_process";
import { scrubbedShellEnv } from "../../../apps/server/src/util/scrubbed-env";

export function positive(command: string, entry: string): void {
  // ruleid: agni-env-spread-to-child
  Bun.spawn({ cmd: [process.execPath, entry], env: process.env });
  // ruleid: agni-env-spread-to-child
  spawn(command, ["-c", "ls"], { env: { ...process.env, EXTRA: "1" } });
  // ruleid: agni-env-spread-to-child
  Bun.spawn(["git", "status"], { env: { ...Bun.env } });
  // ruleid: agni-env-spread-to-child
  execFileSync("git", ["status"], { env: Object.assign({}, process.env, { A: "1" }) });
}

export function positiveThroughAVariable(command: string): void {
  const childEnv = { ...process.env, FORCE_COLOR: "0" };
  // ruleid: agni-env-spread-to-child
  spawn(command, [], { env: childEnv, stdio: "ignore" });
}

/** No env option at all: the child inherits the whole environment. */
export function positiveNoEnv(command: string, entry: string): void {
  // ruleid: agni-env-spread-to-child
  spawn(command, [], { stdio: "ignore" });
  // ruleid: agni-env-spread-to-child
  spawn(command, ["-c", "ls"]);
  // ruleid: agni-env-spread-to-child
  Bun.spawn([process.execPath, entry]);
  // ruleid: agni-env-spread-to-child
  Bun.spawn({ cmd: [process.execPath, entry], stdout: "pipe" });
  // ruleid: agni-env-spread-to-child
  Bun.spawnSync(["git", "status"], { stdout: "pipe", stderr: "pipe" });
  // ruleid: agni-env-spread-to-child
  execSync("git status --short");
  // ruleid: agni-env-spread-to-child
  exec("git status", () => {});
  // ruleid: agni-env-spread-to-child
  execFileSync("git", ["status"], { encoding: "utf8", windowsHide: true });
}

export function negative(command: string): void {
  // ok: agni-env-spread-to-child
  spawn(command, ["-c", "ls"], { env: scrubbedShellEnv() });
  // ok: agni-env-spread-to-child
  Bun.spawn(["git", "status"], { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } });
  // ok: agni-env-spread-to-child
  spawn(command, [], { stdio: "ignore", env: scrubbedShellEnv() });
  // ok: agni-env-spread-to-child
  Bun.spawn({ cmd: [command], env: { PATH: process.env.PATH ?? "" } });
  // ok: agni-env-spread-to-child
  execFileSync("git", ["status"], { encoding: "utf8", env: scrubbedShellEnv() });
  // ok: agni-env-spread-to-child
  const loaded = loadConfig({ env: process.env });
  void loaded;
}

declare function loadConfig(options: { env: unknown }): unknown;
