import { spawn, execFileSync } from "node:child_process";
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

export function negative(command: string): void {
  // ok: agni-env-spread-to-child
  spawn(command, ["-c", "ls"], { env: scrubbedShellEnv() });
  // ok: agni-env-spread-to-child
  Bun.spawn(["git", "status"], { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } });
  // ok: agni-env-spread-to-child
  spawn(command, [], { stdio: "ignore" });
  // ok: agni-env-spread-to-child
  const loaded = loadConfig({ env: process.env });
  void loaded;
}

declare function loadConfig(options: { env: unknown }): unknown;
