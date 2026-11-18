/**
 * HF-1 (Sprint 5 hotfix round 2): on Windows, asking the file system about `\\host\share\x` makes it look the host up and
 * open SMB to it with the owner's NTLM credentials. The gate asked during decide(), before any card. A path that names
 * another computer or a device namespace is now never touched: it is outside scratch, has no real path, and is refused.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessCall, policyFor } from "../src/policy/metadata";
import { namesRemoteOrDevice } from "../src/policy/path-key";
import { pathResource, shellFacts } from "../src/policy/resources";
import { approvalTarget } from "../src/stores/approval-rules";
import { bashCwdProblem } from "../src/tools/bash";
import { confineToScratch, isOutsideScratch, resolveWritePath, writeTargetExists } from "../src/tools/write-file";

const REMOTE = [
  "\\\\attacker.invalid\\share\\x.txt",
  "//attacker.invalid/share/x.txt",
  "\\\\?\\UNC\\attacker.invalid\\share\\x.txt",
  "\\\\.\\pipe\\agni-test",
  "\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\x.txt",
];

let home = "";
let scratch = "";
const savedEnv = { home: process.env.AGNI_HOME, scratch: process.env.AGNI_SCRATCH_DIR };
beforeEach(() => {
  home = fs.mkdtempSync(join(tmpdir(), "agni-r2-unc-"));
  scratch = join(home, "scratch");
  fs.mkdirSync(scratch);
  process.env.AGNI_HOME = home;
  process.env.AGNI_SCRATCH_DIR = scratch;
});
afterEach(() => {
  if (savedEnv.home === undefined) delete process.env.AGNI_HOME; else process.env.AGNI_HOME = savedEnv.home;
  if (savedEnv.scratch === undefined) delete process.env.AGNI_SCRATCH_DIR; else process.env.AGNI_SCRATCH_DIR = savedEnv.scratch;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("namesRemoteOrDevice", () => {
  test("is true on Windows for every network and device form", () => {
    for (const path of REMOTE) expect(namesRemoteOrDevice(path, "win32"), path).toBe(true);
  });
  test("is false for local paths, and for everything on other systems", () => {
    for (const path of ["C:\\Users\\x\\a.txt", "notes/a.txt", "..\\a.txt", "/c/x/a.txt"]) expect(namesRemoteOrDevice(path, "win32"), path).toBe(false);
    for (const path of REMOTE) expect(namesRemoteOrDevice(path, "linux"), path).toBe(false);
  });
});

// Windows only: the attack is Windows' own SMB lookup, and the helper is false elsewhere by design.
test.skipIf(process.platform !== "win32")("no gate-time path check touches the file system for a network or device path", () => {
  const touched: string[] = [];
  const record = (...args: unknown[]): void => {
    for (const arg of args) if (typeof arg === "string" && namesRemoteOrDevice(arg, "win32")) touched.push(arg);
  };
  const realpathNative = fs.realpathSync.native;
  const spies: Array<{ mockRestore(): void }> = [
    spyOn(fs.realpathSync, "native").mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => { record(String(path)); return (realpathNative as (...a: unknown[]) => string)(path, ...rest); }) as never),
  ];
  // `realpathSync` itself is not replaced: its `.native` (spied above) is what the code calls, and a mock would drop it.
  for (const name of ["lstatSync", "statSync", "existsSync", "readdirSync", "mkdirSync"] as const) {
    const original = fs[name] as (...a: unknown[]) => unknown;
    spies.push(spyOn(fs, name).mockImplementation(((...args: unknown[]) => { record(...args.map((arg) => (arg instanceof URL ? arg.href : arg))); return original(...args); }) as never));
  }
  try {
    for (const path of REMOTE) {
      expect(isOutsideScratch(path, scratch), path).toBe(true);
      expect(resolveWritePath(path), path).toBeNull();
      expect(writeTargetExists(path), path).toBe(true);
      expect(() => confineToScratch(path), path).toThrow();
      expect(bashCwdProblem(path), path).not.toBeNull();
      pathResource(path);
      expect(approvalTarget("write_file", { path, content: "x" }), path).toBeNull();
      expect(assessCall(policyFor("write_file"), { path, content: "x" }).tier, path).toBe(2);
      assessCall(policyFor("read_file"), { path });
      assessCall(policyFor("grep"), { pattern: "x", path });
      assessCall(policyFor("bash"), { command: "cat x.txt", cwd: path });
      shellFacts("cat x.txt", path);
    }
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  expect(touched).toEqual([]);
});
