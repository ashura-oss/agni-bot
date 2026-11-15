import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadPluginsFile, savePluginsFile } from "../src/plugins/config";
import { windowsSystemTool } from "../src/util/windows-acl";
import { expectPrivate } from "./acl-helper";

const dir = () => mkdtempSync(join(tmpdir(), "agni-plugins-config-"));

describe("plugins.json", () => {
  test("a corrupt file loads empty but is never saved over", () => {
    const path = join(dir(), "plugins.json");
    writeFileSync(path, '{"version":1,"plugins":{"gmail":{"auth":{"pass":"se');
    const config = loadPluginsFile(path);
    expect(config.plugins).toEqual({});
    expect(() => savePluginsFile(path, config)).toThrow(/refusing/);
    expect(readFileSync(path, "utf-8")).toContain('"pass":"se');
    expect(readFileSync(`${path}.corrupt`, "utf-8")).toContain('"pass":"se');
  });

  test("save creates a private dir and forces the file to owner-only, even if it was readable by others", () => {
    const path = join(dir(), "nested", "plugins.json");
    savePluginsFile(path, { version: 1, plugins: {} });
    // POSIX: mode 0700 dir. Windows: an ACL that grants only the current user.
    expectPrivate(dirname(path), 0o700);
    writeFileSync(path, "{}", { mode: 0o644 });
    chmodSync(path, 0o644);
    if (process.platform === "win32") {
      // The Windows equivalent of 0644: give Everyone read access to the file.
      execFileSync(windowsSystemTool("icacls"), [path, "/grant", "*S-1-1-0:R"], { stdio: "pipe", windowsHide: true });
    }
    savePluginsFile(path, { version: 1, plugins: {} });
    expectPrivate(path, 0o600);
    expect(loadPluginsFile(path).version).toBe(1);
  });
});
