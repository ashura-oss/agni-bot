/**
 * S2-INT item 9: the per-user Git permission check is one PowerShell call for every path, runs in the
 * background at server start (not on the first shell command), and a "could not check" answer is looked at
 * again after five minutes instead of being kept for ever.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  UNVERIFIABLE_RECHECK_MS, cachedUserInstallCheck, findGitBash, gitBashReady, gitInstall, inspectPathsAcl, inspectPathsAclAsync, inspectUserInstall,
  parseAclReport, prepareGitBash, resetGitInstallCache, type AclRequest,
} from "../src/util/git-bash";
import { startupS2Shell } from "../src/startup/s2-shell";

process.env.SystemRoot ??= "C:\\Windows"; // the request builder needs it; off Windows the tests inject the runner
afterEach(() => resetGitInstallCache());

const OWN = "S-1-5-21-1-2-3-1001";
const line = (record: Record<string, unknown>): string => JSON.stringify({ me: OWN, ...record });
const OWNER_ONLY = `D:PAI(A;OICI;FA;;;${OWN})(A;OICI;FA;;;SY)`;
const USERS_WRITE = `D:PAI(A;OICI;FA;;;${OWN})(A;OICI;0x1301bf;;;BU)`;

describe("parseAclReport", () => {
  test("each path gets its own answer: ok, writable, wrong owner, and could-not-read", () => {
    const paths = ["C:\\u\\Git", "C:\\u\\Git\\bin", "C:\\u\\Git\\usr", "C:\\u\\Git\\gone"];
    const report = [
      line({ idx: 0, owner: OWN, dacl: OWNER_ONLY }),
      line({ idx: 1, owner: OWN, dacl: USERS_WRITE }),
      line({ idx: 2, owner: "S-1-5-21-9-9-9-1500", dacl: OWNER_ONLY }),
      line({ idx: 3, error: "Cannot find path" }),
    ].join("\r\n");
    const result = parseAclReport(report, paths, OWN);
    expect([...result.entries()]).toEqual([
      ["C:\\u\\Git", "ok"], ["C:\\u\\Git\\bin", "writable"], ["C:\\u\\Git\\usr", "owner"], ["C:\\u\\Git\\gone", "unverifiable"],
    ]);
  });

  test("a path the report does not mention, and output that is not a report, are unverifiable", () => {
    expect(parseAclReport("", ["C:\\a"], OWN).get("C:\\a")).toBe("unverifiable");
    expect(parseAclReport("garbage\nmore garbage", ["C:\\a"], OWN).get("C:\\a")).toBe("unverifiable");
    expect(parseAclReport(line({ idx: 5, owner: OWN, dacl: OWNER_ONLY }), ["C:\\a"], OWN).get("C:\\a")).toBe("unverifiable");
  });

  test("with no answer for who the owner is, nothing is trusted", () => {
    const noMe = JSON.stringify({ idx: 0, owner: OWN, dacl: OWNER_ONLY });
    expect(parseAclReport(noMe, ["C:\\a"], "").get("C:\\a")).toBe("unverifiable");
  });
});

describe("one PowerShell call for every path", () => {
  const paths = ["C:\\u\\Git", "C:\\u\\Git\\bin", "C:\\u\\Git\\usr\\bin", "C:\\u\\Git\\bin\\bash.exe", "C:\\u\\Git\\cmd"];
  const reportFor = (): string => paths.map((_, idx) => line({ idx, owner: OWN, dacl: OWNER_ONLY })).join("\n");

  test("five paths are checked with one process, and its request carries every path", () => {
    const requests: AclRequest[] = [];
    const result = inspectPathsAcl(paths, { run: (request) => { requests.push(request); return reportFor(); } });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.file.toLowerCase()).toContain("powershell");
    for (const path of paths) expect(requests[0]!.env.AGNI_ACL_PATHS).toContain(path);
    expect([...result.values()]).toEqual(["ok", "ok", "ok", "ok", "ok"]);
  });

  test("the same holds for the background version", async () => {
    let calls = 0;
    const result = await inspectPathsAclAsync(paths, { run: async () => { calls++; return reportFor(); } });
    expect(calls).toBe(1);
    expect(result.get(paths[0]!)).toBe("ok");
  });

  test("a call that fails or cannot start leaves every path unverifiable", () => {
    const result = inspectPathsAcl(paths, { run: () => { throw new Error("no PowerShell"); } });
    expect([...result.values()]).toEqual(Array(5).fill("unverifiable"));
  });

  test("a per-user install is checked in one call over its folders, and the worst finding wins", () => {
    let calls = 0;
    const exists = (): boolean => true;
    const answer = inspectUserInstall("C:\\u\\Git", "C:\\u\\Git\\bin\\bash.exe", {
      exists,
      run: (request) => {
        calls++;
        const count = request.env.AGNI_ACL_PATHS!.split("|").length;
        return Array.from({ length: count }, (_, idx) => line({ idx, owner: OWN, dacl: idx === 1 ? USERS_WRITE : OWNER_ONLY })).join("\n");
      },
    });
    expect(calls).toBe(1);
    expect(answer).toBe("writable");
  });
});

describe("on this machine", () => {
  test.skipIf(process.platform !== "win32")("a system folder and a missing one are answered together by the real PowerShell", () => {
    const programFiles = process.env.ProgramW6432 || process.env.ProgramFiles || "C:\\Program Files";
    const system = `${programFiles}\\Windows NT`;
    const missing = "C:\\definitely\\not\\here\\agni-test";
    const result = inspectPathsAcl([system, missing]);
    expect(result.get(system)).toBe("ok");
    expect(result.get(missing)).toBe("unverifiable");
  }, 30_000);
});

describe("a 'could not check' answer is looked at again after five minutes", () => {
  test("ok and writable are kept; unverifiable is kept for five minutes, then checked again", () => {
    resetGitInstallCache();
    const t0 = 1_000_000;
    let calls = 0;
    let next: "unverifiable" | "ok" = "unverifiable";
    const inspect = () => { calls++; return next; };
    expect(cachedUserInstallCheck("C:\\u\\Git", inspect, t0)).toBe("unverifiable");
    expect(cachedUserInstallCheck("C:\\u\\Git", inspect, t0 + UNVERIFIABLE_RECHECK_MS - 1)).toBe("unverifiable");
    expect(calls).toBe(1);
    next = "ok";
    expect(cachedUserInstallCheck("C:\\u\\Git", inspect, t0 + UNVERIFIABLE_RECHECK_MS)).toBe("ok");
    expect(calls).toBe(2);
    // A definite answer is not asked for again.
    expect(cachedUserInstallCheck("C:\\u\\Git", inspect, t0 + 10 * UNVERIFIABLE_RECHECK_MS)).toBe("ok");
    expect(calls).toBe(2);
  });

  test("the pause is five minutes", () => {
    expect(UNVERIFIABLE_RECHECK_MS).toBe(300_000);
  });
});

describe("the check runs at server start, not on the first shell command", () => {
  const ENV = { ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\o\\AppData\\Local", SystemRoot: "C:\\Windows" };
  const USER_BASH = "C:\\Users\\o\\AppData\\Local\\Programs\\Git\\bin\\bash.exe";
  const exists = (path: string): boolean => path.startsWith("C:\\Users\\o\\AppData\\Local\\Programs\\Git");

  test("preparing in the background finds the install, and the first command then needs no check of its own", async () => {
    resetGitInstallCache();
    let calls = 0;
    await prepareGitBash({
      env: ENV, exists,
      run: async (request) => {
        calls++;
        const count = request.env.AGNI_ACL_PATHS!.split("|").length;
        return Array.from({ length: count }, (_, idx) => line({ idx, owner: OWN, dacl: OWNER_ONLY })).join("\n");
      },
    });
    expect(calls).toBe(1);
    // The first shell command asks for the install: it is already known.
    expect(gitInstall().bash).toBe(USER_BASH);
    expect(calls).toBe(1);
    await gitBashReady();
    expect(calls).toBe(1);
  });

  test("a folder others can write to is refused after preparing, and is not looked at again by the first command", async () => {
    resetGitInstallCache();
    let calls = 0;
    await prepareGitBash({
      env: ENV, exists,
      run: async (request) => {
        calls++;
        const count = request.env.AGNI_ACL_PATHS!.split("|").length;
        return Array.from({ length: count }, (_, idx) => line({ idx, owner: OWN, dacl: USERS_WRITE })).join("\n");
      },
    });
    expect(calls).toBe(1);
    // What the first shell command does: find Git Bash. The answer is already known, with no second check.
    expect(() => findGitBash({ env: ENV, exists })).toThrow(/other accounts can change/);
    expect(calls).toBe(1);
  });

  test("the start-up hook does not wait for the check", () => {
    let started = 0;
    const never = new Promise<void>(() => undefined);
    startupS2Shell({ platform: "win32", prepare: () => { started++; return never; } });
    expect(started).toBe(1);
  });

  test("the start-up hook does nothing off Windows", () => {
    let started = 0;
    startupS2Shell({ platform: "darwin", prepare: () => { started++; return Promise.resolve(); } });
    expect(started).toBe(0);
  });

  test("a check that fails is logged, never thrown into the start-up", async () => {
    startupS2Shell({ platform: "win32", prepare: () => Promise.reject(new Error("boom")) });
    await Bun.sleep(5);
  });
});
