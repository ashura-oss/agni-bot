import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadPluginsFile, savePluginsFile } from "../src/plugins/config";
import { windowsSystemTool } from "../src/util/windows-acl";
import { expectPrivate, withFailingAcl } from "./acl-helper";

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

  test("a directory deleted and recreated while the server runs is secured again", () => {
    const parent = dir();
    const path = join(parent, "private", "plugins.json");
    savePluginsFile(path, { version: 1, plugins: {} });
    rmSync(dirname(path), { recursive: true, force: true });
    savePluginsFile(path, { version: 1, plugins: { gmail: { account: "owner", enabled: true, auth: { kind: "api-key", key: "k" } } } });
    expectPrivate(dirname(path), 0o700);
    expectPrivate(path, 0o600);
  });

  // Windows only: elsewhere the ACL step is a no-op, so there is nothing to fail.
  test.skipIf(process.platform !== "win32")("when the ACL cannot be set, the log does not claim a .corrupt copy that was not made", () => {
    const path = join(dir(), "plugins.json");
    writeFileSync(path, '{"version":1,"plugins":{"gmail":{"auth":{"pass":"se');
    const lines: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.join(" ")); };
    try {
      withFailingAcl(() => loadPluginsFile(path));
    } finally {
      console.error = realError;
    }
    expect(existsSync(`${path}.corrupt`)).toBe(false);
    const message = lines.join("\n");
    expect(message).toContain("unreadable");
    expect(message).not.toContain("kept a copy");
  });
});
