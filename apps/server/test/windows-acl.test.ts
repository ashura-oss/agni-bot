import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { icaclsArgs, parseSid, windowsSystemTool } from "../src/util/windows-acl";

describe("windowsSystemTool", () => {
  test("resolves under SystemRoot\\System32 from the environment", () => {
    expect(windowsSystemTool("whoami", { SystemRoot: "D:\\Win" })).toBe("D:\\Win\\System32\\whoami.exe");
    expect(windowsSystemTool("icacls", { windir: "E:\\NT" })).toBe("E:\\NT\\System32\\icacls.exe");
  });

  test("refuses to guess a system root when the environment is missing or not an absolute drive path", () => {
    for (const env of [{}, { SystemRoot: "" }, { SystemRoot: "Windows" }, { SystemRoot: "..\\evil" }, { SystemRoot: "\\\\host\\share" }]) {
      expect(() => windowsSystemTool("whoami", env)).toThrow(/SystemRoot/);
    }
  });
});

describe("icaclsArgs", () => {
  test.skipIf(process.platform !== "win32")("never hands icacls a leading-slash path it would read as a switch", () => {
    for (const path of ["/tmp/x", "\\tmp\\x", "relative\\dir"]) {
      expect(icaclsArgs(path, "S-1-5-21-1-2-3-1001", true)[0]).toMatch(/^[A-Za-z]:\\/);
    }
    expect(icaclsArgs("C:\\a\\b", "S-1-5-21-1-2-3-1001", true)).toEqual(["C:\\a\\b", "/inheritance:r", "/grant:r", "*S-1-5-21-1-2-3-1001:(OI)(CI)F"]);
    expect(icaclsArgs("C:\\a\\f.txt", "S-1-5-21-1-2-3-1001", false).at(-1)).toBe("*S-1-5-21-1-2-3-1001:F");
  });
});

describe("parseSid", () => {
  test("reads the SID from whoami's csv output", () => {
    expect(parseSid('"desktop\\owner","S-1-5-21-111-222-333-1001"\r\n')).toBe("S-1-5-21-111-222-333-1001");
  });
  test("takes the SID from the second field, not an account name that looks like one", () => {
    expect(parseSid('"S-1-1-0","S-1-5-21-111-222-333-1001"\r\n')).toBe("S-1-5-21-111-222-333-1001");
  });
  test("rejects output without a SID", () => {
    expect(() => parseSid("desktop\n")).toThrow(/owner/);
  });
  test("rejects a SID-shaped text that is not the second field", () => {
    expect(() => parseSid('"S-1-1-0"\r\n')).toThrow(/owner/);
    expect(() => parseSid('"desktop\\owner","not a sid S-1-1-0"\r\n')).toThrow(/owner/);
  });
});

describe("no bare-name calls to Windows system tools", () => {
  test("whoami and icacls are never passed to a spawn by bare name", () => {
    const root = join(import.meta.dir, "..", "src");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name) && /\b(?:execFile|execFileSync|spawn|spawnSync|runFile)\(\s*["'`](?:whoami|icacls)\b/.test(readFileSync(path, "utf8"))) {
          offenders.push(relative(root, path));
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
