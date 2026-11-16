import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { win32 } from "node:path";

const runFile = promisify(execFile);

/**
 * Absolute path of a Windows system tool under `%SystemRoot%\System32`.
 *
 * System tools are never called by bare name: PATH order decides what runs
 * (Git Bash puts GNU `whoami`, which rejects `/user`, ahead of the Windows
 * one) and a planted executable earlier on PATH would run with the owner's
 * rights. `SystemRoot` (or `windir`) must be an absolute drive path. If
 * neither is, this throws rather than guess `C:\Windows`: a guessed path on a
 * drive that is not the system drive could hold a planted executable.
 */
export function windowsSystemTool(
  name: "whoami" | "icacls" | "rundll32",
  env: Record<string, string | undefined> = process.env,
): string {
  const root = [env.SystemRoot, env.windir, env.SYSTEMROOT, env.WINDIR].find((value) => value && /^[A-Za-z]:[\\/]/.test(value));
  if (!root) throw new Error("Cannot locate the Windows system directory: SystemRoot is not set to an absolute drive path.");
  return win32.join(root, "System32", `${name}.exe`);
}

/**
 * The SID in `whoami /user /fo csv /nh` output: the second field of
 * `"domain\user","S-1-..."`. The first field is an account name the user
 * chose, and could itself look like a SID.
 */
export function parseSid(output: string): string {
  const sid = output.match(/^\s*"[^"]*","(S-1-\d+(?:-\d+)+)"\s*$/m)?.[1];
  if (!sid) throw new Error("Could not identify the owner of the private path.");
  return sid;
}

const WHOAMI_ARGS = ["/user", "/fo", "csv", "/nh"];

export function currentUserSid(): string {
  return parseSid(execFileSync(windowsSystemTool("whoami"), WHOAMI_ARGS, { encoding: "utf8", windowsHide: true }));
}

export async function currentUserSidAsync(): Promise<string> {
  const { stdout } = await runFile(windowsSystemTool("whoami"), WHOAMI_ARGS, { windowsHide: true });
  return parseSid(stdout);
}

/** Drop inherited access and grant full control to the current user only. */
export function icaclsArgs(path: string, sid: string, isDirectory: boolean): string[] {
  // icacls reads a leading "/" as a switch ("/tmp" is not a path to it), so
  // the target is always a drive-absolute path.
  // (OI)(CI) makes files created later in a directory inherit owner-only access.
  return [win32.resolve(path), "/inheritance:r", "/grant:r", `*${sid}:${isDirectory ? "(OI)(CI)" : ""}F`];
}

/** Windows: owner-only ACL on `path`. Elsewhere: nothing (callers keep their chmod). */
export function restrictToOwnerOnWindows(path: string, isDirectory: boolean): void {
  if (process.platform !== "win32") return;
  execFileSync(windowsSystemTool("icacls"), icaclsArgs(path, currentUserSid(), isDirectory), { stdio: "pipe", windowsHide: true });
}

export async function restrictToOwnerOnWindowsAsync(path: string, isDirectory: boolean): Promise<void> {
  if (process.platform !== "win32") return;
  await runFile(windowsSystemTool("icacls"), icaclsArgs(path, await currentUserSidAsync(), isDirectory), { windowsHide: true });
}
