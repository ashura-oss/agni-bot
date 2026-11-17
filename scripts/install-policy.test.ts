import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The install policy: no dependency runs install scripts.
 *
 *  - root package.json carries an empty `trustedDependencies`, so Bun's built-in
 *    list of default-trusted names does not apply either;
 *  - bunfig.toml sets `[install] ignoreScripts = true`. That is a real Bun
 *    1.4.3 key (documented at bun.sh/docs/runtime/bunfig), and the last test
 *    proves it on this machine: a trusted dependency with a postinstall runs it
 *    without the key and does not with it.
 */
const ROOT = join(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as Record<string, unknown>;
const bunfig = Bun.TOML.parse(readFileSync(join(ROOT, "bunfig.toml"), "utf8")) as { install?: Record<string, unknown> };

describe("install policy", () => {
  test("root package.json trusts no dependency", () => {
    expect(pkg.trustedDependencies).toEqual([]);
  });

  test("bunfig.toml keeps the release-age gate and turns install scripts off", () => {
    expect(bunfig.install?.minimumReleaseAge).toBe(14 * 24 * 3600);
    expect(bunfig.install?.ignoreScripts).toBe(true);
  });
});

/** An environment built from an allowlist: the test never hands its own environment to a child. */
function installEnv(cache: string): Record<string, string> {
  const env: Record<string, string> = { BUN_INSTALL_CACHE_DIR: cache, CI: "1" };
  for (const name of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "ComSpec", "USERPROFILE", "HOME", "TEMP", "TMP", "TMPDIR", "LOCALAPPDATA", "APPDATA"]) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
}

function run(cmd: string[], cwd: string, env: Record<string, string>): { code: number; out: string } {
  const proc = Bun.spawnSync(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" });
  return { code: proc.exitCode ?? -1, out: proc.stdout.toString() + proc.stderr.toString() };
}

describe("install policy: behaviour of ignoreScripts in this Bun", () => {
  test("a trusted dependency's postinstall runs without the key and is skipped with it", () => {
    const base = mkdtempSync(join(tmpdir(), "agni-install-policy-"));
    try {
      const env = installEnv(join(base, "cache"));
      const dep = join(base, "dep");
      mkdirSync(dep, { recursive: true });
      writeFileSync(
        join(dep, "package.json"),
        JSON.stringify({ name: "postdep", version: "1.0.0", scripts: { postinstall: "node -e \"require('fs').writeFileSync('MARKER.txt','ran')\"" } }),
      );
      const packed = run([process.execPath, "pm", "pack"], dep, env);
      expect(packed.code).toBe(0);
      const tarball = join(dep, "postdep-1.0.0.tgz");
      expect(existsSync(tarball)).toBe(true);

      const install = (name: string, bunfigText: string): boolean => {
        const dir = join(base, name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", dependencies: { postdep: `file:${tarball.replaceAll("\\", "/")}` }, trustedDependencies: ["postdep"] }));
        if (bunfigText) writeFileSync(join(dir, "bunfig.toml"), bunfigText);
        const result = run([process.execPath, "install"], dir, env);
        expect(result.code).toBe(0);
        return existsSync(join(dir, "node_modules", "postdep", "MARKER.txt"));
      };

      // Control: without the key the trusted dependency's script runs, so the test can tell the difference.
      expect(install("control", "")).toBe(true);
      expect(install("ignoring", "[install]\nignoreScripts = true\n")).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 120_000);
});
