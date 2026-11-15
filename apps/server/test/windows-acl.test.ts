import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseSid, windowsSystemTool } from "../src/util/windows-acl";

describe("windowsSystemTool", () => {
  test("resolves under SystemRoot\\System32 from the environment", () => {
    expect(windowsSystemTool("whoami", { SystemRoot: "D:\\Win" })).toBe("D:\\Win\\System32\\whoami.exe");
    expect(windowsSystemTool("icacls", { windir: "E:\\NT" })).toBe("E:\\NT\\System32\\icacls.exe");
  });

  test("falls back to C:\\Windows when the environment is missing or not an absolute drive path", () => {
    for (const env of [{}, { SystemRoot: "" }, { SystemRoot: "Windows" }, { SystemRoot: "..\\evil" }, { SystemRoot: "\\\\host\\share" }]) {
      expect(windowsSystemTool("whoami", env)).toBe("C:\\Windows\\System32\\whoami.exe");
    }
  });
});

describe("parseSid", () => {
  test("reads the SID from whoami's csv output", () => {
    expect(parseSid('"desktop\\owner","S-1-5-21-111-222-333-1001"\r\n')).toBe("S-1-5-21-111-222-333-1001");
  });
  test("rejects output without a SID", () => {
    expect(() => parseSid("desktop\n")).toThrow(/owner/);
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
