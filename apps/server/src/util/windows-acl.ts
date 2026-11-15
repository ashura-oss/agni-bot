import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { win32 } from "node:path";

const runFile = promisify(execFile);

const DEFAULT_SYSTEM_ROOT = "C:\\Windows";

/**
 * Absolute path of a Windows system tool under `%SystemRoot%\System32`.
 *
 * System tools are never called by bare name: PATH order decides what runs
 * (Git Bash puts GNU `whoami`, which rejects `/user`, ahead of the Windows
 * one) and a planted executable earlier on PATH would run with the owner's
 * rights. `SystemRoot` (or `windir`) must be an absolute drive path; anything
 * else falls back to `C:\Windows`.
 */
export function windowsSystemTool(
  name: "whoami" | "icacls",
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env.SystemRoot || env.windir || env.SYSTEMROOT || env.WINDIR;
  const root = configured && /^[A-Za-z]:[\\/]/.test(configured) ? configured : DEFAULT_SYSTEM_ROOT;
  return win32.join(root, "System32", `${name}.exe`);
}

/** The SID in `whoami /user /fo csv /nh` output. */
export function parseSid(output: string): string {
  const sid = output.match(/S-1-\d+(?:-\d+)+/)?.[0];
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
function icaclsArgs(path: string, sid: string, isDirectory: boolean): string[] {
  // (OI)(CI) makes files created later in a directory inherit owner-only access.
  return [path, "/inheritance:r", "/grant:r", `*${sid}:${isDirectory ? "(OI)(CI)" : ""}F`];
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
