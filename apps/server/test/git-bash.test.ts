/**
 * S2-14: Git Bash is found at the fixed install locations, never through
 * PATH (`Bun.which("git")` let whatever sat first on PATH become the shell).
 * A per-user install is used only when no other account can write to it.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restrictToOwnerOnWindows, windowsSystemTool } from "../src/util/windows-acl";
import {
  cachedUserInstallCheck, findGitBash, gitInstallCandidates, inspectPathAcl, isOwnerSystemOnly, ownerSidTrusted, resetGitInstallCache, sddlWritableByOthers,
} from "../src/util/git-bash";

const ENV = {
  ProgramW6432: "C:\\Program Files",
  ProgramFiles: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  LOCALAPPDATA: "C:\\Users\\o\\AppData\\Local",
  PATH: "D:\\evil\\Git\\cmd;D:\\evil\\Git\\bin;.",
};
const MACHINE_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
const USER_BASH = "C:\\Users\\o\\AppData\\Local\\Programs\\Git\\bin\\bash.exe";

describe("gitInstallCandidates", () => {
  test("fixed locations in order, machine installs before the per-user one, duplicates folded", () => {
    expect(gitInstallCandidates(ENV)).toEqual([
      { root: "C:\\Program Files\\Git", scope: "machine" },
      { root: "C:\\Program Files (x86)\\Git", scope: "machine" },
      { root: "C:\\Users\\o\\AppData\\Local\\Programs\\Git", scope: "user" },
    ]);
  });

  test("a relative or empty base is dropped, never joined", () => {
    expect(gitInstallCandidates({ ProgramFiles: "Program Files", ProgramW6432: "", LOCALAPPDATA: ".\\x" })).toEqual([]);
  });

  test("PATH is never consulted", () => {
    expect(gitInstallCandidates({ PATH: "D:\\evil\\Git\\cmd" })).toEqual([]);
  });
});

describe("findGitBash", () => {
  test("picks the machine install and ignores a Git planted on PATH", () => {
    const exists = (path: string): boolean => path === MACHINE_BASH || path.startsWith("D:\\evil");
    const found = findGitBash({ env: ENV, exists, userInstallCheck: () => "ok" });
    expect(found).toEqual({ root: "C:\\Program Files\\Git", bash: MACHINE_BASH, scope: "machine" });
  });

  test("falls back to usr\\bin\\bash.exe when bin\\bash.exe is missing", () => {
    const usr = "C:\\Program Files\\Git\\usr\\bin\\bash.exe";
    expect(findGitBash({ env: ENV, exists: (path) => path === usr, userInstallCheck: () => "writable" }).bash).toBe(usr);
  });

  test("a per-user install is used only when its ACL is owner/system only", () => {
    const exists = (path: string): boolean => path === USER_BASH;
    expect(findGitBash({ env: ENV, exists, userInstallCheck: () => "ok" })).toEqual({
      root: "C:\\Users\\o\\AppData\\Local\\Programs\\Git", bash: USER_BASH, scope: "user",
    });
    expect(() => findGitBash({ env: ENV, exists, userInstallCheck: () => "writable" })).toThrow(/other accounts can change|writable by other/i);
  });

  test("the refusal names the folder and says how to fix it", () => {
    const exists = (path: string): boolean => path === USER_BASH;
    let message = "";
    try { findGitBash({ env: ENV, exists, userInstallCheck: () => "writable" }); } catch (error) { message = (error as Error).message; }
    expect(message).toContain("C:\\Users\\o\\AppData\\Local\\Programs\\Git");
    expect(message).toMatch(/for all users|Program Files/);
  });

  test("the three refusals say different things: writable, wrong owner, and could not check", () => {
    const exists = (path: string): boolean => path === USER_BASH;
    const messageFor = (status: "writable" | "owner" | "unverifiable"): string => {
      try { findGitBash({ env: ENV, exists, userInstallCheck: () => status }); } catch (error) { return (error as Error).message; }
      return "";
    };
    expect(messageFor("writable")).toMatch(/other accounts can change/);
    expect(messageFor("owner")).toMatch(/owned by another account/);
    const unverifiable = messageFor("unverifiable");
    expect(unverifiable).toMatch(/could not check/i);
    expect(unverifiable).not.toMatch(/other accounts can change/);
    expect(unverifiable).toContain("C:\\Users\\o\\AppData\\Local\\Programs\\Git");
  });

  test("no Git anywhere: the message says Git for Windows is required", () => {
    expect(() => findGitBash({ env: ENV, exists: () => false, userInstallCheck: () => "ok" })).toThrow(/Shell tools on Windows require Git Bash/);
  });
});

const OWN = "S-1-5-21-1-2-3-1001";
describe("sddlWritableByOthers", () => {
  test("the real default ACL of C:\\Program Files\\Git has no foreign writer", () => {
    const sddl = "D:AI(A;ID;FA;;;S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464)(A;CIIOID;GA;;;S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464)(A;ID;FA;;;SY)(A;OICIIOID;GA;;;SY)(A;ID;FA;;;BA)(A;OICIIOID;GA;;;BA)(A;ID;0x1200a9;;;BU)(A;OICIIOID;GXGR;;;BU)(A;OICIIOID;GA;;;CO)(A;ID;0x1200a9;;;AC)(A;OICIIOID;GXGR;;;AC)";
    expect(sddlWritableByOthers(sddl, OWN)).toBe(false);
  });

  test("a per-user folder: the owner, SYSTEM and Administrators write; another account only reads", () => {
    const sddl = `D:AI(A;OICIID;0x1200a9;;;S-1-5-21-1-2-3-1003)(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;${OWN})`;
    expect(sddlWritableByOthers(sddl, OWN)).toBe(false);
  });

  test("Everyone, Users or another account with write rights is a foreign writer", () => {
    expect(sddlWritableByOthers(`D:(A;;FA;;;${OWN})(A;;FA;;;WD)`, OWN)).toBe(true);
    expect(sddlWritableByOthers(`D:(A;;FA;;;${OWN})(A;;0x1301bf;;;BU)`, OWN)).toBe(true);
    expect(sddlWritableByOthers(`D:(A;;FA;;;${OWN})(A;;FRFW;;;S-1-5-21-1-2-3-1003)`, OWN)).toBe(true);
    expect(sddlWritableByOthers(`D:(A;;0x2;;;S-1-1-0)`, OWN)).toBe(true);
    expect(sddlWritableByOthers(`D:(A;;0x40000;;;BU)`, OWN)).toBe(true); // WRITE_DAC alone is enough
    expect(sddlWritableByOthers(`D:(A;;GW;;;AU)`, OWN)).toBe(true);
  });

  test("a deny entry never counts as a writer, a read-only grant never does", () => {
    expect(sddlWritableByOthers(`D:(D;;FA;;;WD)(A;;FA;;;${OWN})(A;;FRFX;;;WD)`, OWN)).toBe(false);
  });

  test("fails closed: an unknown right, no DACL, or garbage counts as writable", () => {
    expect(sddlWritableByOthers(`D:(A;;ZZ;;;BU)`, OWN)).toBe(true);
    expect(sddlWritableByOthers("", OWN)).toBe(true);
    expect(sddlWritableByOthers("garbage", OWN)).toBe(true);
    expect(sddlWritableByOthers("D:", OWN)).toBe(false); // an empty DACL grants nothing
  });
});

describe("ownerSidTrusted", () => {
  test("the current user, SYSTEM, Administrators and service accounts own a trusted install; anyone else does not", () => {
    for (const sid of [OWN, "S-1-5-18", "S-1-5-32-544", "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464", "SY", "BA"]) {
      expect(ownerSidTrusted(sid, OWN)).toBe(true);
    }
    for (const sid of ["S-1-5-21-1-2-3-1003", "S-1-1-0", "S-1-5-32-545", "WD", "BU", ""]) expect(ownerSidTrusted(sid, OWN)).toBe(false);
  });
});

describe("the per-user install check is remembered for the process", () => {
  test("a success is looked up once", () => {
    resetGitInstallCache();
    let calls = 0;
    const inspect = (): "ok" => { calls++; return "ok"; };
    expect(cachedUserInstallCheck("C:\\u\\Git", inspect)).toBe("ok");
    expect(cachedUserInstallCheck("C:\\u\\Git", inspect)).toBe("ok");
    expect(cachedUserInstallCheck("c:\\U\\git", inspect)).toBe("ok"); // Windows paths ignore case
    expect(calls).toBe(1);
  });

  test("a failure, including 'could not check', is remembered too", () => {
    resetGitInstallCache();
    let calls = 0;
    const inspect = (): "unverifiable" => { calls++; return "unverifiable"; };
    expect(cachedUserInstallCheck("C:\\u\\Git", inspect)).toBe("unverifiable");
    expect(cachedUserInstallCheck("C:\\u\\Git", inspect)).toBe("unverifiable");
    expect(calls).toBe(1);
  });

  test("a different folder is checked on its own", () => {
    resetGitInstallCache();
    let calls = 0;
    const inspect = (): "ok" => { calls++; return "ok"; };
    cachedUserInstallCheck("C:\\u\\Git", inspect);
    cachedUserInstallCheck("D:\\other\\Git", inspect);
    expect(calls).toBe(2);
  });
});

describe("inspectPathAcl on this machine", () => {
  test.skipIf(process.platform !== "win32")("a path that cannot be read is 'unverifiable', not 'writable'", () => {
    expect(inspectPathAcl("C:\\definitely\\not\\here\\agni-test")).toBe("unverifiable");
  });

  test.skipIf(process.platform !== "win32")("a system folder is ok (its owner is TrustedInstaller)", () => {
    const programFiles = process.env.ProgramW6432 || process.env.ProgramFiles || "C:\\Program Files";
    expect(inspectPathAcl(`${programFiles}\\Windows NT`)).toBe("ok");
  });

  test.skipIf(process.platform !== "win32")("a folder only its owner can use is ok; once Users may write to it, it is writable", () => {
    const dir = mkdtempSync(join(tmpdir(), "agni-acl-probe-"));
    try {
      restrictToOwnerOnWindows(dir, true);
      expect(inspectPathAcl(dir)).toBe("ok");
      execFileSync(windowsSystemTool("icacls"), [dir, "/grant", "*S-1-5-32-545:(OI)(CI)M", "/q"], { stdio: "pipe", windowsHide: true });
      expect(inspectPathAcl(dir)).toBe("writable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("isOwnerSystemOnly on this machine", () => {
  test.skipIf(process.platform !== "win32")("a system folder passes", () => {
    const programFiles = process.env.ProgramW6432 || process.env.ProgramFiles || "C:\\Program Files";
    expect(isOwnerSystemOnly(`${programFiles}\\Windows NT`)).toBe(true);
  });

  test.skipIf(process.platform !== "win32")("a path that does not exist is not trusted", () => {
    expect(isOwnerSystemOnly("C:\\definitely\\not\\here\\agni-test")).toBe(false);
  });
});
