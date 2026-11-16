/**
 * Stop a child and everything it started. A shell command is a tree: `bash`
 * runs the real program, which may start more. Killing only the first process
 * (the old `child.kill()`) left the rest running, holding the output pipes
 * open, after a timeout or a stopped turn.
 *
 * `trackTree(child)` is called right after the spawn and returns a handle:
 *
 *  - POSIX: the child was spawned as its own process group leader
 *    (`TREE_SPAWN_OPTIONS`), and the signal goes to the whole group.
 *  - Windows: the child is put in a Job Object (kernel32, through `bun:ffi`),
 *    and `TerminateJobObject` ends every process in it, however it was
 *    started. A plain `taskkill /T` is not enough on its own: Git Bash's MSYS
 *    runtime starts programs through fork/exec, which leaves a program whose
 *    parent process is already gone, and `taskkill /T` follows parent links.
 *    The job also has `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so closing the
 *    handle (`release()`, or the server exiting) ends whatever is left.
 *    If the job cannot be made, the handle falls back to `taskkill /T /F`,
 *    called by absolute path under `%SystemRoot%\System32` so PATH cannot
 *    choose it.
 *
 * This is housekeeping, not containment. It ends what a command started the
 * ordinary way (background jobs, `nohup`, helpers) so nothing lingers after
 * the command or a timeout. A process can still leave on purpose: a
 * scheduled task (`schtasks`), WMI, a service, `setsid` or a second process
 * group, or a job breakaway. Stopping that needs the Sprint 7 sandbox. Nothing
 * here may be read as a reason to relax an approval gate.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";
import { spawn } from "node:child_process";
import { win32 } from "node:path";
import { envValue, isWindowsDrivePath } from "./env-lookup";

export interface KillableChild {
  pid?: number | undefined;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface TreeHandle {
  /** Stop the child and its descendants. Resolves once the last signal has been sent. */
  kill(): Promise<void>;
  /** Let go of the OS handle. The processes keep running; call it when the command is over. */
  release(): void;
}

/** Spawn options that make `trackTree` work on this platform. */
export const TREE_SPAWN_OPTIONS = { detached: process.platform !== "win32" } as const;

/** A Windows HANDLE, as bun:ffi returns it. */
type Handle = number | bigint;

interface Kernel32 {
  CreateJobObjectW(attributes: null, name: null): Handle | null;
  SetInformationJobObject(job: Handle, infoClass: number, info: number, size: number): number;
  OpenProcess(access: number, inherit: number, pid: number): Handle | null;
  AssignProcessToJobObject(job: Handle, process: Handle): number;
  TerminateJobObject(job: Handle, exitCode: number): number;
  CloseHandle(handle: Handle): number;
}

let kernel32: Kernel32 | null | undefined;

/** kernel32 through bun:ffi, loaded once. Null off Windows or if it cannot be loaded. */
function loadKernel32(): Kernel32 | null {
  if (kernel32 !== undefined) return kernel32;
  kernel32 = null;
  if (process.platform !== "win32") return kernel32;
  try {
    const { symbols } = dlopen("kernel32.dll", {
      CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
      SetInformationJobObject: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
      AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      TerminateJobObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
    });
    kernel32 = symbols as unknown as Kernel32;
  } catch {
    kernel32 = null;
  }
  return kernel32;
}

const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;
/** JOBOBJECT_EXTENDED_LIMIT_INFORMATION on 64-bit Windows: 144 bytes, with LimitFlags (a DWORD) at offset 16. */
const EXTENDED_LIMIT_INFORMATION_SIZE = 144;
const LIMIT_FLAGS_OFFSET = 16;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

/** A new Job Object holding `pid`, or null when any step fails (the caller falls back to taskkill). */
function jobFor(pid: number): Handle | null {
  const api = loadKernel32();
  if (!api) return null;
  let job: Handle | null = null;
  let processHandle: Handle | null = null;
  try {
    job = api.CreateJobObjectW(null, null);
    if (!job) return null;
    // Closing the last handle ends every process still in the job. If this fails the job still
    // works for an explicit TerminateJobObject; only the end-of-command cleanup is weaker.
    const limits = new Uint8Array(EXTENDED_LIMIT_INFORMATION_SIZE);
    new DataView(limits.buffer).setUint32(LIMIT_FLAGS_OFFSET, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, true);
    api.SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS, ptr(limits), limits.length);
    processHandle = api.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
    if (!processHandle || api.AssignProcessToJobObject(job, processHandle) === 0) {
      api.CloseHandle(job);
      return null;
    }
    return job;
  } catch {
    return null;
  } finally {
    if (processHandle) api.CloseHandle(processHandle);
  }
}

function taskkillPath(): string | null {
  const root = ["SystemRoot", "windir"].map((name) => envValue(process.env, name)).find(isWindowsDrivePath);
  return root ? win32.join(root, "System32", "taskkill.exe") : null;
}

function taskkillTree(pid: number): Promise<boolean> {
  const exe = taskkillPath();
  if (!exe) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      const killer = spawn(exe, ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, env: { SystemRoot: win32.dirname(win32.dirname(exe)) } });
      killer.on("error", () => resolve(false));
      killer.on("close", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone.
  }
}

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Track `child` and its descendants so they can be stopped together. Call it
 * immediately after spawning. POSIX: SIGTERM to the group, then SIGKILL to it
 * if members are still there after `graceMs` (the group is signalled even if
 * its leader already exited, because a member may have outlived it).
 */
export function trackTree(child: KillableChild, graceMs = 2_000): TreeHandle {
  const pid = child.pid;
  if (process.platform === "win32") {
    const job = pid ? jobFor(pid) : null;
    return {
      async kill(): Promise<void> {
        if (job) {
          const api = loadKernel32();
          if (api && api.TerminateJobObject(job, 1) !== 0) return;
        }
        if (pid && !(await taskkillTree(pid))) {
          try { child.kill("SIGKILL"); } catch { /* already gone */ }
        }
      },
      release(): void {
        if (job) try { loadKernel32()?.CloseHandle(job); } catch { /* best effort */ }
      },
    };
  }
  return {
    async kill(): Promise<void> {
      if (!pid) return;
      signalGroup(pid, "SIGTERM");
      // Wait for the group to empty, up to the grace period; only then escalate. An empty
      // group (the normal case at the end of a command) costs no wait.
      const deadline = Date.now() + graceMs;
      while (groupExists(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      if (groupExists(pid)) signalGroup(pid, "SIGKILL");
    },
    release(): void {},
  };
}
