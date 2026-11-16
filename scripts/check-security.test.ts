import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TOOLS,
  childEnv,
  exitCodeFor,
  formatReport,
  parseAudit,
  parseGitleaks,
  parseOsv,
  parseSemgrep,
  parseZizmor,
  resolveTool,
  runChecks,
  type CheckResult,
  type Runner,
} from "./check-security.ts";

const SCRIPT = join(import.meta.dir, "check-security.ts");

function tempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `agni-${label}-`));
}

const noExist = () => false;
const noWhich = () => null;

describe("resolveTool", () => {
  test("an env override wins; a JSON array carries a command plus leading args", () => {
    const cmd = resolveTool(TOOLS.semgrep, { env: { SEMGREP_BIN: '["C:\\\\a b\\\\bun.exe","C:\\\\x y\\\\fake.ts"]' }, exists: noExist, which: noWhich, home: "/h" });
    expect(cmd).toEqual(["C:\\a b\\bun.exe", "C:\\x y\\fake.ts"]);
  });

  test("a plain env override is one executable path, spaces and all", () => {
    const cmd = resolveTool(TOOLS.gitleaks, { env: { GITLEAKS_BIN: "C:\\Program Files\\gl\\gitleaks.exe" }, exists: noExist, which: noWhich, home: "/h" });
    expect(cmd).toEqual(["C:\\Program Files\\gl\\gitleaks.exe"]);
  });

  test("the documented tools directory is searched before PATH", () => {
    const wanted = join("/tools", "osv-scanner.exe");
    const cmd = resolveTool(TOOLS["osv-scanner"], { env: { AGNI_TOOLS_DIR: "/tools" }, exists: (p) => p === wanted, which: () => "/usr/bin/osv-scanner", home: "/h" });
    expect(cmd).toEqual([wanted]);
  });

  test("the default tools directory is under the home folder, not .agni", () => {
    const wanted = join("/h", ".agni-tools", "bin", "zizmor");
    const cmd = resolveTool(TOOLS.zizmor, { env: {}, exists: (p) => p === wanted, which: noWhich, home: "/h" });
    expect(cmd).toEqual([wanted]);
  });

  test("PATH is the last place to look, and nothing found is null", () => {
    expect(resolveTool(TOOLS.gitleaks, { env: {}, exists: noExist, which: () => "/usr/bin/gitleaks", home: "/h" })).toEqual(["/usr/bin/gitleaks"]);
    expect(resolveTool(TOOLS.gitleaks, { env: {}, exists: noExist, which: noWhich, home: "/h" })).toBeNull();
  });

  test("a malformed JSON-array override is refused rather than guessed", () => {
    expect(() => resolveTool(TOOLS.gitleaks, { env: { GITLEAKS_BIN: "[not json" }, exists: noExist, which: noWhich, home: "/h" })).toThrow(/GITLEAKS_BIN/);
  });
});

describe("report parsers", () => {
  test("gitleaks: findings carry rule, file and line, and never the secret", () => {
    const report = JSON.stringify([{ RuleID: "generic-api-key", File: "apps/x.ts", StartLine: 12, Secret: "REDACTED", Match: "key = REDACTED", Description: "Generic API Key" }]);
    const findings = parseGitleaks(report);
    expect(findings).toEqual([{ id: "generic-api-key", where: "apps/x.ts:12", message: "Generic API Key" }]);
    const hostile = parseGitleaks(JSON.stringify([{ RuleID: "r", File: "f", StartLine: 1, Secret: "sk-LIVE-1234567890", Match: "sk-LIVE-1234567890", Description: "d" }]));
    expect(JSON.stringify(hostile)).not.toContain("sk-LIVE");
  });

  test("gitleaks: an empty or missing report is no findings", () => {
    expect(parseGitleaks("[]")).toEqual([]);
    expect(parseGitleaks("")).toEqual([]);
  });

  test("bun audit: advisories at or above the level count, lower ones are listed as below", () => {
    const body = JSON.stringify({
      lodash: [{ id: 1, url: "https://github.com/advisories/GHSA-aaaa", title: "Prototype pollution", severity: "high", vulnerable_versions: "<4.17.21" }],
      minimist: [{ id: 2, url: "https://github.com/advisories/GHSA-bbbb", title: "Minor thing", severity: "low", vulnerable_versions: "<1.2.6" }],
    });
    const high = parseAudit(body, "high");
    expect(high.failing.map((f) => f.id)).toEqual(["GHSA-aaaa"]);
    expect(high.below).toBe(1);
    expect(parseAudit(body, "low").failing).toHaveLength(2);
    expect(parseAudit("{}", "high")).toEqual({ failing: [], below: 0 });
  });

  test("bun audit: a non-JSON body is an error, not a pass", () => {
    expect(() => parseAudit("<html>502</html>", "high")).toThrow();
  });

  test("osv-scanner: lists each vulnerable package once per vulnerability", () => {
    const body = JSON.stringify({
      results: [{ source: { path: "/r/bun.lock", type: "lockfile" }, packages: [{ package: { name: "left-pad", version: "1.0.0", ecosystem: "npm" }, vulnerabilities: [{ id: "GHSA-1", summary: "bad" }, { id: "GHSA-2" }] }, { package: { name: "ok", version: "1.0.0", ecosystem: "npm" }, vulnerabilities: [] }] }],
    });
    expect(parseOsv(body)).toEqual([
      { id: "GHSA-1", where: "left-pad@1.0.0", message: "bad" },
      { id: "GHSA-2", where: "left-pad@1.0.0", message: "" },
    ]);
    expect(parseOsv(JSON.stringify({ results: [] }))).toEqual([]);
  });

  test("semgrep: results map to findings and rule errors are reported separately", () => {
    const body = JSON.stringify({
      results: [{ check_id: "scripts.semgrep.rules.agni-x", path: "apps/server/src/a.ts", start: { line: 3 }, extra: { message: "do not", severity: "ERROR" } }],
      errors: [{ type: "RuleParseError", message: "bad yaml", level: "error" }],
    });
    const parsed = parseSemgrep(body);
    expect(parsed.findings).toEqual([{ id: "agni-x", where: "apps/server/src/a.ts:3", message: "do not" }]);
    expect(parsed.errors).toEqual(["RuleParseError: bad yaml"]);
  });

  test("zizmor: json-v1 rows are 0-based and become 1-based lines", () => {
    const body = JSON.stringify([
      { ident: "unpinned-uses", desc: "action is not pinned", determinations: { severity: "High" }, locations: [{ symbolic: { key: { Local: { given_path: ".github/workflows/ci.yml" } } }, concrete: { location: { start_point: { row: 9 } } } }] },
    ]);
    expect(parseZizmor(body)).toEqual([{ id: "unpinned-uses", where: ".github/workflows/ci.yml:10", message: "action is not pinned" }]);
    expect(parseZizmor("[]")).toEqual([]);
  });
});

describe("childEnv", () => {
  test("a tool gets the names it needs (any letter case, as on Windows) and none of the secrets", () => {
    const env = childEnv({ Path: "C:\bin", SystemRoot: "C:\Windows", HTTPS_PROXY: "http://p:1", BUN_CONFIG_REGISTRY: "r", OPENROUTER_API_KEY: "sk-SECRET", GITHUB_TOKEN: "ghp_SECRET", AGNI_HOME: "C:\h" });
    expect(env.Path).toBe("C:\bin");
    expect(env.SystemRoot).toBe("C:\Windows");
    expect(env.HTTPS_PROXY).toBe("http://p:1");
    expect(env.BUN_CONFIG_REGISTRY).toBe("r");
    expect(JSON.stringify(env)).not.toContain("SECRET");
    expect(env.AGNI_HOME).toBeUndefined();
  });
});

describe("exit codes and report", () => {
  const pass: CheckResult = { id: "a", title: "A", status: "pass", lines: [] };
  const skipped: CheckResult = { id: "b", title: "B", status: "skipped", lines: ["not installed"] };
  const fail: CheckResult = { id: "c", title: "C", status: "fail", lines: ["1 finding"] };
  const error: CheckResult = { id: "d", title: "D", status: "error", lines: ["tool crashed"] };

  const missing: CheckResult = { id: "e", title: "E", status: "missing", lines: ["not installed: gitleaks"] };

  test("a missing tool fails the run unless missing tools are allowed", () => {
    expect(exitCodeFor([pass, missing], false)).toBe(1);
    expect(exitCodeFor([pass, missing], true)).toBe(0);
  });

  test("a check skipped on purpose (--offline) is not a missing tool", () => {
    expect(exitCodeFor([pass, skipped], false)).toBe(0);
  });

  test("allowing missing tools never hides a finding or a crash", () => {
    expect(exitCodeFor([missing, fail], true)).toBe(1);
    expect(exitCodeFor([missing, error], true)).toBe(1);
  });

  test("findings and tool errors always fail", () => {
    expect(exitCodeFor([pass, fail], false)).toBe(1);
    expect(exitCodeFor([pass, error], false)).toBe(1);
  });

  test("the report names every check with its status", () => {
    const text = formatReport([pass, skipped, fail, error]);
    for (const word of ["PASS", "SKIP", "FAIL", "ERROR", "tool crashed"]) expect(text).toContain(word);
  });
});

describe("runChecks with a fake runner", () => {
  const base = { root: "C:\\r", allowMissing: false, offline: false, auditLevel: "high" as const, which: noWhich, exists: noExist, home: "/h", env: {} };

  test("a missing external tool is reported as missing with install instructions and the runner is never called", async () => {
    const calls: string[][] = [];
    const run: Runner = async (cmd) => (calls.push(cmd), { code: 0, stdout: "", stderr: "" });
    const results = await runChecks({ ...base, only: ["gitleaks-tree", "semgrep", "osv", "zizmor"], run });
    expect(calls).toEqual([]);
    for (const r of results) {
      expect(r.status).toBe("missing");
      expect(r.lines.join("\n")).toMatch(/not installed/i);
      expect(r.lines.join("\n")).toMatch(/install/i);
    }
  });

  test("offline mode skips the checks that need the network", async () => {
    const run: Runner = async () => { throw new Error("must not run"); };
    const results = await runChecks({ ...base, offline: true, only: ["audit", "osv"], run, env: { OSV_SCANNER_BIN: "osv" } });
    expect(results.map((r) => r.status)).toEqual(["skipped", "skipped"]);
    expect(results[0]!.lines.join(" ")).toMatch(/offline/i);
  });

  test("gitleaks: the tree scan passes the project config, redaction, and reads findings from the report file", async () => {
    let seen: string[] = [];
    const run: Runner = async (cmd) => {
      seen = cmd;
      const path = cmd[cmd.indexOf("--report-path") + 1]!;
      writeFileSync(path, JSON.stringify([{ RuleID: "aws-access-token", File: "a.ts", StartLine: 2, Secret: "x", Description: "AWS" }]));
      return { code: 1, stdout: "", stderr: "" };
    };
    const [r] = await runChecks({ ...base, only: ["gitleaks-tree"], run, env: { GITLEAKS_BIN: "gitleaks" } });
    expect(r!.status).toBe("fail");
    expect(r!.lines.join("\n")).toContain("a.ts:2");
    expect(seen.slice(0, 2)).toEqual(["gitleaks", "dir"]);
    expect(seen).toContain("--redact");
    expect(seen).toContain("--no-banner");
    expect(seen[seen.indexOf("--config") + 1]).toMatch(/\.gitleaks\.toml$/);
  });

  test("gitleaks history uses the git subcommand", async () => {
    let seen: string[] = [];
    const run: Runner = async (cmd) => ((seen = cmd), { code: 0, stdout: "", stderr: "" });
    const [r] = await runChecks({ ...base, only: ["gitleaks-history"], run, env: { GITLEAKS_BIN: "gitleaks" } });
    expect(r!.status).toBe("pass");
    expect(seen.slice(0, 2)).toEqual(["gitleaks", "git"]);
  });

  test("gitleaks: a non-zero exit with no report is an error, not a pass", async () => {
    const run: Runner = async () => ({ code: 2, stdout: "", stderr: "unknown flag" });
    const [r] = await runChecks({ ...base, only: ["gitleaks-tree"], run, env: { GITLEAKS_BIN: "gitleaks" } });
    expect(r!.status).toBe("error");
    expect(r!.lines.join("\n")).toContain("unknown flag");
  });

  test("semgrep: metrics off, project rules, fixtures and tests excluded; a rule error is an error", async () => {
    let seen: string[] = [];
    const run: Runner = async (cmd) => {
      seen = cmd;
      return { code: 2, stdout: JSON.stringify({ results: [], errors: [{ type: "RuleParseError", message: "bad", level: "error" }] }), stderr: "" };
    };
    const [r] = await runChecks({ ...base, only: ["semgrep"], run, env: { SEMGREP_BIN: "semgrep" } });
    expect(r!.status).toBe("error");
    expect(seen).toContain("--metrics=off");
    expect(seen[seen.indexOf("--config") + 1]).toMatch(/semgrep[\\/]rules$/);
    expect(seen.join(" ")).toMatch(/--exclude \*\.test\.ts/);
  });

  test("semgrep: a finding fails the check", async () => {
    const run: Runner = async () => ({ code: 0, stdout: JSON.stringify({ results: [{ check_id: "x.agni-env-spread-to-child", path: "apps/server/src/d.ts", start: { line: 5 }, extra: { message: "spread", severity: "ERROR" } }], errors: [] }), stderr: "" });
    const [r] = await runChecks({ ...base, only: ["semgrep"], run, env: { SEMGREP_BIN: "semgrep" } });
    expect(r!.status).toBe("fail");
    expect(r!.lines.join("\n")).toContain("agni-env-spread-to-child");
  });

  test("bun audit: runs the same bun, reads JSON, and an unreachable registry is an error", async () => {
    const run: Runner = async () => ({ code: 1, stdout: "", stderr: "error: failed to fetch advisories" });
    const [r] = await runChecks({ ...base, only: ["audit"], run });
    expect(r!.status).toBe("error");
    let seen: string[] = [];
    const run2: Runner = async (cmd) => ((seen = cmd), { code: 0, stdout: "{}", stderr: "" });
    const [ok] = await runChecks({ ...base, only: ["audit"], run: run2 });
    expect(ok!.status).toBe("pass");
    expect(seen).toContain("audit");
    expect(seen).toContain("--json");
  });

  test("osv-scanner: scans bun.lock with the scan source command", async () => {
    let seen: string[] = [];
    const run: Runner = async (cmd) => ((seen = cmd), { code: 0, stdout: JSON.stringify({ results: [] }), stderr: "" });
    const [r] = await runChecks({ ...base, only: ["osv"], run, env: { OSV_SCANNER_BIN: "osv-scanner" } });
    expect(r!.status).toBe("pass");
    expect(seen.slice(0, 3)).toEqual(["osv-scanner", "scan", "source"]);
    expect(seen.join(" ")).toMatch(/bun\.lock/);
    expect(seen).toContain("--format");
  });

  test("zizmor: runs offline against the workflows directory", async () => {
    let seen: string[] = [];
    const run: Runner = async (cmd) => ((seen = cmd), { code: 0, stdout: "[]", stderr: "" });
    const [r] = await runChecks({ ...base, only: ["zizmor"], run, env: { ZIZMOR_BIN: "zizmor" } });
    expect(r!.status).toBe("pass");
    expect(seen).toContain("--offline");
    expect(seen.join(" ")).toMatch(/\.github[\\/]workflows/);
  });
});

describe("the script end to end", () => {
  function runScript(args: string[], env: Record<string, string>): { code: number; out: string } {
    const proc = Bun.spawnSync([process.execPath, SCRIPT, ...args], { env: { ...env }, stdout: "pipe", stderr: "pipe" });
    return { code: proc.exitCode ?? -1, out: proc.stdout.toString() + proc.stderr.toString() };
  }

  test("with no external tools it says so, installs nothing, and fails unless --allow-missing", () => {
    const empty = tempDir("nopath");
    try {
      const env = { PATH: empty, AGNI_TOOLS_DIR: empty, USERPROFILE: empty, HOME: empty, SystemRoot: process.env.SystemRoot ?? "" };
      const only = ["--offline", "--only", "gitleaks-tree,gitleaks-history,semgrep,osv,zizmor"];
      const strict = runScript(only, env);
      expect(strict.out).toMatch(/not installed/i);
      expect(strict.code).toBe(1);
      const lenient = runScript([...only, "--allow-missing"], env);
      expect(lenient.out).toMatch(/not installed/i);
      expect(lenient.code).toBe(0);
      // The old opt-in flag is gone: strict is the default, and an argument nobody reads must not look like it works.
      expect(runScript([...only, "--strict"], env).code).toBe(2);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("a fake gitleaks that finds a secret fails the run and the secret is never printed", () => {
    const dir = tempDir("fakegl");
    try {
      const fake = join(dir, "fake-gitleaks.ts");
      writeFileSync(
        fake,
        `import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const path = args[args.indexOf("--report-path") + 1];
writeFileSync(path, JSON.stringify([{ RuleID: "generic-api-key", File: "leak.ts", StartLine: 4, Secret: "sk-LIVE-SHOULD-NEVER-PRINT", Match: "sk-LIVE-SHOULD-NEVER-PRINT", Description: "Generic API Key" }]));
process.exit(1);`,
      );
      const env = { PATH: dir, AGNI_TOOLS_DIR: dir, USERPROFILE: dir, HOME: dir, SystemRoot: process.env.SystemRoot ?? "", GITLEAKS_BIN: JSON.stringify([process.execPath, fake]) };
      const result = runScript(["--offline", "--only", "gitleaks-tree"], env);
      expect(result.code).toBe(1);
      expect(result.out).toContain("leak.ts:4");
      expect(result.out).not.toContain("SHOULD-NEVER-PRINT");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unknown --only name is refused", () => {
    const result = runScript(["--only", "nonsense"], { PATH: "", SystemRoot: process.env.SystemRoot ?? "" });
    expect(result.code).toBe(2);
    expect(result.out).toMatch(/unknown check/i);
  });
});
