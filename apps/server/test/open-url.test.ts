import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { browserOpenCommand } from "../src/util/open-url";

const URL_WITH_CODE = "http://127.0.0.1:8787/#code=ABCD-1234";

describe("browserOpenCommand", () => {
  test("Windows runs the system's url.dll handler by absolute path, never a bare name", () => {
    const [program, ...rest] = browserOpenCommand(URL_WITH_CODE, "win32", { SystemRoot: "D:\\Win" });
    expect(program).toBe("D:\\Win\\System32\\rundll32.exe");
    expect(rest).toEqual(["url.dll,FileProtocolHandler", URL_WITH_CODE]);
  });

  test("Windows refuses to guess a system root", () => {
    expect(() => browserOpenCommand(URL_WITH_CODE, "win32", {})).toThrow(/SystemRoot/);
  });

  test("macOS keeps open and everything else keeps xdg-open", () => {
    expect(browserOpenCommand(URL_WITH_CODE, "darwin")).toEqual(["open", URL_WITH_CODE]);
    expect(browserOpenCommand(URL_WITH_CODE, "linux")).toEqual(["xdg-open", URL_WITH_CODE]);
  });

  test("only http and https addresses are opened (the handler would open a file path or program too)", () => {
    for (const bad of ["file:///C:/Windows/System32/calc.exe", "calc.exe", "C:\\Windows\\notepad.exe", "javascript:alert(1)", "ms-msdt:/id", ""]) {
      expect(() => browserOpenCommand(bad, "win32", { SystemRoot: "C:\\Windows" })).toThrow(/http/);
      expect(() => browserOpenCommand(bad, "linux")).toThrow(/http/);
    }
  });

  test.skipIf(process.platform !== "win32")("on this machine the Windows opener exists", () => {
    expect(existsSync(browserOpenCommand(URL_WITH_CODE, "win32")[0]!)).toBe(true);
  });
});

describe("the open and setup commands", () => {
  test("index.ts opens the browser through browserOpenCommand and no longer picks xdg-open for every non-Mac platform", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");
    expect(source).toContain("browserOpenCommand(");
    expect(source).not.toMatch(/\?\s*"open"\s*:\s*"xdg-open"/);
  });
});
