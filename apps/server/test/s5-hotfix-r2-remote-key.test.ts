/**
 * HF-1 review (round 2): a network or device path was keyed by its raw spelling, so a refusal of `\\host\share\x` did not
 * cover `\\?\UNC\host\share\x` or `//HOST./share/x`. Every such path now has one key, and a "no" to one covers all. A long
 * local path (`\\?\C:\x`) is keyed as the plain local path it names.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetPolicyHooks } from "../src/policy/hooks";
import { noopAuditSink, setAuditSink } from "../src/policy/audit-sink";
import { findDenial, recordDenial } from "../src/policy/denials";
import { REMOTE_PATH_KEY, withoutLongPrefix } from "../src/policy/path-key";
import { pathResource, pathsOverlap } from "../src/policy/resources";
import { policyRig, type PolicyRig } from "./policy-fixture";

const SPELLINGS = [
  "\\\\attacker.invalid\\share\\x.txt",
  "\\\\?\\UNC\\attacker.invalid\\share\\x.txt",
  "//ATTACKER.invalid./share/x.txt",
  "\\\\.\\pipe\\agni-test",
  "\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\x.txt",
];

let home = "";
const savedEnv = { home: process.env.AGNI_HOME, scratch: process.env.AGNI_SCRATCH_DIR };
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agni-r2-key-"));
  mkdirSync(join(home, "scratch"));
  process.env.AGNI_HOME = home;
  process.env.AGNI_SCRATCH_DIR = join(home, "scratch");
});
afterEach(() => {
  if (savedEnv.home === undefined) delete process.env.AGNI_HOME; else process.env.AGNI_HOME = savedEnv.home;
  if (savedEnv.scratch === undefined) delete process.env.AGNI_SCRATCH_DIR; else process.env.AGNI_SCRATCH_DIR = savedEnv.scratch;
  rmSync(home, { recursive: true, force: true });
});

describe("withoutLongPrefix", () => {
  test("maps a long local path to the plain one on Windows, and leaves everything else", () => {
    expect(withoutLongPrefix("\\\\?\\C:\\Users\\x\\a.txt", "win32")).toBe("C:\\Users\\x\\a.txt");
    expect(withoutLongPrefix("//?/C:/Users/x/a.txt", "win32")).toBe("C:/Users/x/a.txt");
    expect(withoutLongPrefix("\\\\?\\UNC\\host\\share", "win32")).toBe("\\\\?\\UNC\\host\\share");
    expect(withoutLongPrefix("\\\\?\\C:\\x", "linux")).toBe("\\\\?\\C:\\x");
  });
});

describe("pathsOverlap and the remote key", () => {
  test("the remote key overlaps itself and nothing local", () => {
    expect(pathsOverlap(REMOTE_PATH_KEY, REMOTE_PATH_KEY)).toBe(true);
    expect(pathsOverlap(REMOTE_PATH_KEY, "c:\\users\\x")).toBe(false);
    expect(pathsOverlap("c:\\users\\x", REMOTE_PATH_KEY)).toBe(false);
  });
});

// Windows only: these spellings name network and device paths only there; elsewhere they are ordinary relative names.
describe.skipIf(process.platform !== "win32")("every spelling of a network or device path", () => {
  let rig: PolicyRig;
  beforeEach(() => { rig = policyRig(); });
  afterEach(() => { rig.close(); resetPolicyHooks(); setAuditSink(noopAuditSink); });

  test("has the one remote key", () => {
    for (const path of SPELLINGS) expect(pathResource(path).value, path).toBe(REMOTE_PATH_KEY);
  });

  test("a refusal of any one covers every other", () => {
    for (const [index, refused] of SPELLINGS.entries()) {
      // A run of its own per refusal, so each spelling is tested against one stored "no" only.
      const run = rig.another({ turnID: `t-remote-${index}`, rootTurnID: `t-remote-${index}` });
      recordDenial(rig.db, run, { tool: "write_file", operation: "change", cause: "denied", resources: [pathResource(refused)] });
      for (const attempt of SPELLINGS) expect(findDenial(rig.db, run, "change", [pathResource(attempt)]), `${refused} -> ${attempt}`).not.toBeNull();
    }
  });

  test("a long local path has the same key as the plain path", () => {
    const plain = join(home, "scratch", "a.txt");
    expect(pathResource(`\\\\?\\${plain}`).value).toBe(pathResource(plain).value);
    expect(pathResource(`\\\\?\\${plain}`).value).not.toBe(REMOTE_PATH_KEY);
  });
});
