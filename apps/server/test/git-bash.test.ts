/**
 * S2-14: Git Bash is found at the fixed install locations, never through
 * PATH (`Bun.which("git")` let whatever sat first on PATH become the shell).
 * A per-user install is used only when no other account can write to it.
 */
import { describe, expect, test } from "bun:test";
import { findGitBash, gitInstallCandidates, isOwnerSystemOnly, sddlWritableByOthers } from "../src/util/git-bash";

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
    const found = findGitBash({ env: ENV, exists, userInstallTrusted: () => true });
    expect(found).toEqual({ root: "C:\\Program Files\\Git", bash: MACHINE_BASH, scope: "machine" });
  });

  test("falls back to usr\\bin\\bash.exe when bin\\bash.exe is missing", () => {
    const usr = "C:\\Program Files\\Git\\usr\\bin\\bash.exe";
    expect(findGitBash({ env: ENV, exists: (path) => path === usr, userInstallTrusted: () => false }).bash).toBe(usr);
  });

  test("a per-user install is used only when its ACL is owner/system only", () => {
    const exists = (path: string): boolean => path === USER_BASH;
    expect(findGitBash({ env: ENV, exists, userInstallTrusted: () => true })).toEqual({
      root: "C:\\Users\\o\\AppData\\Local\\Programs\\Git", bash: USER_BASH, scope: "user",
    });
    expect(() => findGitBash({ env: ENV, exists, userInstallTrusted: () => false })).toThrow(/other accounts can change|writable by other/i);
  });

  test("the refusal names the folder and says how to fix it", () => {
    const exists = (path: string): boolean => path === USER_BASH;
    let message = "";
    try { findGitBash({ env: ENV, exists, userInstallTrusted: () => false }); } catch (error) { message = (error as Error).message; }
    expect(message).toContain("C:\\Users\\o\\AppData\\Local\\Programs\\Git");
    expect(message).toMatch(/for all users|Program Files/);
  });

  test("no Git anywhere: the message says Git for Windows is required", () => {
    expect(() => findGitBash({ env: ENV, exists: () => false, userInstallTrusted: () => true })).toThrow(/Shell tools on Windows require Git Bash/);
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

describe("isOwnerSystemOnly on this machine", () => {
  test.skipIf(process.platform !== "win32")("the system Git install passes and the shared Windows temp folder fails", () => {
    const programFiles = process.env.ProgramW6432 || process.env.ProgramFiles || "C:\\Program Files";
    expect(isOwnerSystemOnly(`${programFiles}\\Windows NT`)).toBe(true);
    const shared = `${process.env.SystemRoot ?? "C:\\Windows"}\\Temp`;
    expect(isOwnerSystemOnly(shared)).toBe(false);
  });

  test.skipIf(process.platform !== "win32")("a path that does not exist is not trusted", () => {
    expect(isOwnerSystemOnly("C:\\definitely\\not\\here\\agni-test")).toBe(false);
  });
});
