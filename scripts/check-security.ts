/**
 * `bun run check:security` — the local security gates (Sprint 3, S3-11).
 *
 * Runs, in order:
 *   gitleaks-tree      secrets in the working tree        (gitleaks dir)
 *   gitleaks-history   secrets anywhere in git history    (gitleaks git)
 *   semgrep            the project rules in scripts/semgrep/rules
 *   audit              `bun audit` against the npm advisory feed
 *   osv                OSV-Scanner on bun.lock
 *   zizmor             GitHub Actions workflow audit
 *
 * The external tools (gitleaks, semgrep, osv-scanner, zizmor) are installed by
 * the owner, outside the repo; this script never downloads anything. Each is
 * looked for, in order, at:
 *   1. $GITLEAKS_BIN / $SEMGREP_BIN / $OSV_SCANNER_BIN / $ZIZMOR_BIN
 *      (a path, or a JSON array: a command plus leading arguments, for a
 *      wrapper such as ["wsl","semgrep"] or a test double)
 *   2. $AGNI_TOOLS_DIR, default ~/.agni-tools/bin
 *   3. PATH
 * A missing tool is reported as "not installed" with install instructions;
 * the run still exits 0 unless --strict is given. A finding, or a tool that
 * crashes, always exits non-zero.
 *
 *   bun run check:security
 *   bun run check:security -- --strict          missing tools fail the run
 *   bun run check:security -- --offline         skip checks that need the network
 *   bun run check:security -- --only semgrep,audit
 *   bun run check:security -- --audit-level moderate
 *
 * Findings print rule, file and line only; gitleaks runs with --redact and its
 * report fields that could hold a secret are never read.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export type ToolId = "gitleaks" | "semgrep" | "osv-scanner" | "zizmor";
export type Status = "pass" | "fail" | "skipped" | "error";
export type AuditLevel = "low" | "moderate" | "high" | "critical";

export interface Tool {
  name: ToolId;
  envVar: string;
  exe: string;
  install: string;
}

export interface Finding {
  id: string;
  where: string;
  message: string;
}

export interface CheckResult {
  id: string;
  title: string;
  status: Status;
  lines: string[];
}

export interface RunOutput {
  code: number;
  stdout: string;
  stderr: string;
}

export type Runner = (cmd: string[], opts: { cwd: string }) => Promise<RunOutput>;

export const TOOLS: Record<ToolId, Tool> = {
  gitleaks: {
    name: "gitleaks",
    envVar: "GITLEAKS_BIN",
    exe: "gitleaks",
    install: "gitleaks 8.25 or newer: https://github.com/gitleaks/gitleaks/releases (winget install Gitleaks.Gitleaks, scoop install gitleaks, or brew install gitleaks)",
  },
  semgrep: {
    name: "semgrep",
    envVar: "SEMGREP_BIN",
    exe: "semgrep",
    install:
      "semgrep: python -m pip install semgrep (Linux/macOS), or on Windows run it in WSL or Docker and point SEMGREP_BIN at a wrapper, e.g. SEMGREP_BIN='[\"wsl\",\"semgrep\"]'; https://semgrep.dev/docs/getting-started/",
  },
  "osv-scanner": {
    name: "osv-scanner",
    envVar: "OSV_SCANNER_BIN",
    exe: "osv-scanner",
    install: "osv-scanner 2.x: https://github.com/google/osv-scanner/releases (scoop install osv-scanner, or brew install osv-scanner)",
  },
  zizmor: {
    name: "zizmor",
    envVar: "ZIZMOR_BIN",
    exe: "zizmor",
    install: "zizmor 1.x: python -m pip install zizmor, or cargo install zizmor; https://docs.zizmor.sh/installation/",
  },
};

export interface ResolveContext {
  env: Record<string, string | undefined>;
  exists: (path: string) => boolean;
  which: (name: string) => string | null;
  home: string;
}

/** The command (plus leading arguments) that runs `tool`, or null when it is not installed. */
export function resolveTool(tool: Tool, ctx: ResolveContext): string[] | null {
  const override = ctx.env[tool.envVar];
  if (override) {
    if (override.trimStart().startsWith("[")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(override);
      } catch {
        throw new Error(`${tool.envVar} looks like a JSON array but does not parse`);
      }
      if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((part) => typeof part === "string")) {
        throw new Error(`${tool.envVar} must be a non-empty JSON array of strings`);
      }
      return parsed as string[];
    }
    return [override];
  }
  const dir = ctx.env.AGNI_TOOLS_DIR || join(ctx.home, ".agni-tools", "bin");
  for (const name of [tool.exe, `${tool.exe}.exe`]) {
    const candidate = join(dir, name);
    if (ctx.exists(candidate)) return [candidate];
  }
  const onPath = ctx.which(tool.exe);
  return onPath ? [onPath] : null;
}

// ---------------------------------------------------------------- parsers

/** Findings from a gitleaks JSON report. Secret and Match are never read. */
export function parseGitleaks(json: string): Finding[] {
  if (!json.trim()) return [];
  const rows = JSON.parse(json) as Array<{ RuleID?: string; File?: string; StartLine?: number; Description?: string }>;
  return rows.map((row) => ({
    id: row.RuleID ?? "unknown-rule",
    where: `${row.File ?? "?"}:${row.StartLine ?? 0}`,
    message: row.Description ?? "",
  }));
}

const SEVERITY_RANK: Record<AuditLevel, number> = { low: 1, moderate: 2, high: 3, critical: 4 };

/** Advisories from `bun audit --json`: those at or above `level`, and a count of the lower ones. */
export function parseAudit(json: string, level: AuditLevel): { failing: Finding[]; below: number } {
  if (!json.trim()) throw new Error("bun audit printed nothing");
  let body: unknown;
  try {
    body = JSON.parse(json);
  } catch {
    throw new Error("bun audit did not return JSON (registry unreachable or an error page)");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("bun audit returned an unexpected JSON shape");
  const failing: Finding[] = [];
  let below = 0;
  for (const [pkg, advisories] of Object.entries(body as Record<string, unknown>)) {
    if (!Array.isArray(advisories)) continue;
    for (const advisory of advisories as Array<{ id?: number | string; url?: string; title?: string; severity?: string; vulnerable_versions?: string }>) {
      const rank = SEVERITY_RANK[(advisory.severity ?? "") as AuditLevel];
      // An unknown severity counts: better a false alarm than a silent pass.
      if (rank !== undefined && rank < SEVERITY_RANK[level]) {
        below += 1;
        continue;
      }
      const tail = advisory.url?.split("/").pop() ?? "";
      failing.push({
        id: /^GHSA-/i.test(tail) ? tail : String(advisory.id ?? "unknown-advisory"),
        where: `${pkg}${advisory.vulnerable_versions ? ` (${advisory.vulnerable_versions})` : ""}`,
        message: `${advisory.severity ?? "unknown severity"}: ${advisory.title ?? ""}`.trim(),
      });
    }
  }
  return { failing, below };
}

/** Vulnerabilities from an `osv-scanner --format json` report. */
export function parseOsv(json: string): Finding[] {
  const body = JSON.parse(json) as {
    results?: Array<{ packages?: Array<{ package?: { name?: string; version?: string }; vulnerabilities?: Array<{ id?: string; summary?: string }> }> }>;
  };
  const findings: Finding[] = [];
  for (const result of body.results ?? []) {
    for (const pkg of result.packages ?? []) {
      for (const vuln of pkg.vulnerabilities ?? []) {
        findings.push({ id: vuln.id ?? "unknown-vulnerability", where: `${pkg.package?.name ?? "?"}@${pkg.package?.version ?? "?"}`, message: vuln.summary ?? "" });
      }
    }
  }
  return findings;
}

/** Findings and rule/engine errors from `semgrep --json`. */
export function parseSemgrep(json: string): { findings: Finding[]; errors: string[] } {
  const body = JSON.parse(json) as {
    results?: Array<{ check_id?: string; path?: string; start?: { line?: number }; extra?: { message?: string } }>;
    errors?: Array<{ type?: string; level?: string; message?: string; long_msg?: string; short_msg?: string }>;
  };
  const findings = (body.results ?? []).map((row) => ({
    // check_id is prefixed with the rules' directory path; the id is the last segment.
    id: (row.check_id ?? "unknown-rule").split(".").pop() ?? "unknown-rule",
    where: `${row.path ?? "?"}:${row.start?.line ?? 0}`,
    message: row.extra?.message ?? "",
  }));
  const errors = (body.errors ?? [])
    .filter((error) => error.level === "error")
    .map((error) => `${error.type ?? "error"}: ${error.message ?? error.long_msg ?? error.short_msg ?? ""}`.trim());
  return { findings, errors };
}

/** Findings from `zizmor --format json` (json-v1: rows are 0-based). */
export function parseZizmor(json: string): Finding[] {
  const rows = JSON.parse(json) as Array<{
    ident?: string;
    desc?: string;
    locations?: Array<{
      symbolic?: { key?: { Local?: { given_path?: string; prefix?: string } } };
      concrete?: { location?: { start_point?: { row?: number } } };
    }>;
  }>;
  return rows.map((row) => {
    const location = row.locations?.[0];
    const path = location?.symbolic?.key?.Local?.given_path ?? "?";
    const rowNumber = location?.concrete?.location?.start_point?.row;
    return { id: row.ident ?? "unknown-audit", where: rowNumber === undefined ? path : `${path}:${rowNumber + 1}`, message: row.desc ?? "" };
  });
}

// ---------------------------------------------------------------- report

export function exitCodeFor(results: CheckResult[], strict: boolean): number {
  for (const result of results) {
    if (result.status === "fail" || result.status === "error") return 1;
    if (result.status === "skipped" && strict) return 1;
  }
  return 0;
}

const LABEL: Record<Status, string> = { pass: "PASS ", fail: "FAIL ", skipped: "SKIP ", error: "ERROR" };

export function formatReport(results: CheckResult[]): string {
  const out: string[] = [];
  for (const result of results) {
    out.push(`[${LABEL[result.status]}] ${result.title}`);
    for (const line of result.lines) out.push(`        ${line}`);
  }
  const count = (status: Status) => results.filter((result) => result.status === status).length;
  out.push("", `${count("pass")} passed, ${count("fail")} failed, ${count("error")} errored, ${count("skipped")} skipped`);
  return out.join("\n");
}

// ---------------------------------------------------------------- checks

const CHECK_IDS = ["gitleaks-tree", "gitleaks-history", "semgrep", "audit", "osv", "zizmor"] as const;
type CheckId = (typeof CHECK_IDS)[number];

const TITLES: Record<CheckId, string> = {
  "gitleaks-tree": "secrets in the working tree (gitleaks dir)",
  "gitleaks-history": "secrets in git history (gitleaks git)",
  semgrep: "project Semgrep rules (scripts/semgrep/rules)",
  audit: "dependency advisories (bun audit)",
  osv: "dependency vulnerabilities (OSV-Scanner on bun.lock)",
  zizmor: "GitHub Actions workflows (zizmor)",
};

/** Directories the Semgrep rules scan. Extend here when another tree needs the rules. */
const SEMGREP_TARGETS = ["apps/server/src"];

export interface RunOptions {
  root: string;
  strict: boolean;
  offline: boolean;
  auditLevel: AuditLevel;
  only?: string[];
  run: Runner;
  which: (name: string) => string | null;
  exists: (path: string) => boolean;
  home: string;
  env: Record<string, string | undefined>;
}

function tail(text: string, lines = 8): string[] {
  return text.trim().split(/\r?\n/).filter(Boolean).slice(-lines);
}

function show(findings: Finding[]): string[] {
  return findings.map((finding) => `${finding.where}  ${finding.id}${finding.message ? `  ${finding.message}` : ""}`);
}

export async function runChecks(options: RunOptions): Promise<CheckResult[]> {
  const selected = options.only ?? [...CHECK_IDS];
  for (const id of selected) if (!(CHECK_IDS as readonly string[]).includes(id)) throw new Error(`unknown check "${id}" (known: ${CHECK_IDS.join(", ")})`);
  const ctx: ResolveContext = { env: options.env, exists: options.exists, which: options.which, home: options.home };
  const results: CheckResult[] = [];
  for (const id of CHECK_IDS) {
    if (!selected.includes(id)) continue;
    const title = TITLES[id];
    const done = (status: Status, lines: string[] = []) => results.push({ id, title, status, lines });
    const missing = (tool: Tool) => done("skipped", [`not installed: ${tool.name}`, `looked at $${tool.envVar}, $AGNI_TOOLS_DIR (default ~/.agni-tools/bin), then PATH`, `install: ${tool.install}`]);
    try {
      switch (id) {
        case "gitleaks-tree":
        case "gitleaks-history": {
          const command = resolveTool(TOOLS.gitleaks, ctx);
          if (!command) { missing(TOOLS.gitleaks); break; }
          const work = mkdtempSync(join(tmpdir(), "agni-gitleaks-"));
          try {
            const report = join(work, "report.json");
            const cmd = [...command, id === "gitleaks-tree" ? "dir" : "git", options.root, "--config", join(options.root, ".gitleaks.toml"), "--redact", "--no-banner", "--report-format", "json", "--report-path", report, "--exit-code", "1"];
            const out = await options.run(cmd, { cwd: options.root });
            const findings = existsSync(report) ? parseGitleaks(readFileSync(report, "utf8")) : [];
            if (findings.length > 0) done("fail", [`${findings.length} finding(s); values are redacted, open the file and line to inspect`, ...show(findings)]);
            else if (out.code === 0) done("pass");
            else done("error", [`gitleaks exited ${out.code} with no report`, ...tail(out.stderr || out.stdout)]);
          } finally {
            rmSync(work, { recursive: true, force: true });
          }
          break;
        }
        case "semgrep": {
          const command = resolveTool(TOOLS.semgrep, ctx);
          if (!command) { missing(TOOLS.semgrep); break; }
          const cmd = [...command, "scan", "--config", join(options.root, "scripts", "semgrep", "rules"), "--metrics=off", "--disable-version-check", "--json", "--quiet", "--exclude", "*.test.ts", "--exclude", "node_modules", ...SEMGREP_TARGETS];
          const out = await options.run(cmd, { cwd: options.root });
          let parsed: ReturnType<typeof parseSemgrep>;
          try {
            parsed = parseSemgrep(out.stdout);
          } catch {
            done("error", [`semgrep exited ${out.code} without JSON output`, ...tail(out.stderr || out.stdout)]);
            break;
          }
          if (parsed.errors.length > 0) done("error", ["semgrep reported errors; a broken rule means a silent gap, so this fails", ...parsed.errors]);
          else if (parsed.findings.length > 0) done("fail", [`${parsed.findings.length} finding(s)`, ...show(parsed.findings)]);
          else if (out.code >= 2) done("error", [`semgrep exited ${out.code}`, ...tail(out.stderr)]);
          else done("pass");
          break;
        }
        case "audit": {
          if (options.offline) { done("skipped", ["skipped: --offline (bun audit needs the npm advisory endpoint)"]); break; }
          const out = await options.run([process.execPath, "audit", "--json"], { cwd: options.root });
          let parsed: ReturnType<typeof parseAudit>;
          try {
            parsed = parseAudit(out.stdout, options.auditLevel);
          } catch (error) {
            done("error", [error instanceof Error ? error.message : String(error), ...tail(out.stderr)]);
            break;
          }
          const note = parsed.below > 0 ? [`${parsed.below} advisory(ies) below "${options.auditLevel}" not counted`] : [];
          if (parsed.failing.length > 0) done("fail", [`${parsed.failing.length} advisory(ies) at "${options.auditLevel}" or above`, ...show(parsed.failing), ...note]);
          else done("pass", note);
          break;
        }
        case "osv": {
          if (options.offline) { done("skipped", ["skipped: --offline (OSV-Scanner queries osv.dev)"]); break; }
          const command = resolveTool(TOOLS["osv-scanner"], ctx);
          if (!command) { missing(TOOLS["osv-scanner"]); break; }
          const out = await options.run([...command, "scan", "source", "-L", join(options.root, "bun.lock"), "--format", "json"], { cwd: options.root });
          if (out.code === 127 || out.code === 128) { done("error", [`osv-scanner exited ${out.code}${out.code === 128 ? " (no packages found in bun.lock; needs osv-scanner 2.x)" : ""}`, ...tail(out.stderr)]); break; }
          let findings: Finding[];
          try {
            findings = parseOsv(out.stdout);
          } catch {
            done("error", [`osv-scanner exited ${out.code} without JSON output`, ...tail(out.stderr || out.stdout)]);
            break;
          }
          if (findings.length > 0) done("fail", [`${findings.length} vulnerability(ies)`, ...show(findings)]);
          else done("pass");
          break;
        }
        case "zizmor": {
          const command = resolveTool(TOOLS.zizmor, ctx);
          if (!command) { missing(TOOLS.zizmor); break; }
          const out = await options.run([...command, "--format", "json", "--offline", join(options.root, ".github", "workflows")], { cwd: options.root });
          // 0 clean; 11-14 findings (by highest severity); 1-3 are errors.
          if (out.code === 1 || out.code === 2 || out.code === 3) { done("error", [`zizmor exited ${out.code}`, ...tail(out.stderr)]); break; }
          let findings: Finding[];
          try {
            findings = parseZizmor(out.stdout);
          } catch {
            done("error", [`zizmor exited ${out.code} without JSON output`, ...tail(out.stderr || out.stdout)]);
            break;
          }
          if (findings.length > 0) done("fail", [`${findings.length} finding(s)`, ...show(findings)]);
          else done("pass");
          break;
        }
      }
    } catch (error) {
      done("error", [error instanceof Error ? error.message : String(error)]);
    }
  }
  return results;
}

// ---------------------------------------------------------------- CLI

/** Names a child tool may inherit. Not the whole environment: provider keys stay out. */
const CHILD_ENV_NAMES = new Set([
  "PATH", "PATHEXT", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR",
  "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "USERNAME", "LANG", "LC_ALL", "TERM",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "NODE_EXTRA_CA_CERTS",
  "WSLENV", "WSL_DISTRO_NAME",
]);

/** Windows spells names in mixed case (Path, SystemRoot), so names are compared upper-cased. */
export function childEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = { PYTHONUTF8: "1" };
  for (const [name, value] of Object.entries(env)) {
    const upper = name.toUpperCase();
    if (value !== undefined && (CHILD_ENV_NAMES.has(upper) || upper.startsWith("BUN_") || upper.startsWith("NPM_CONFIG_"))) out[name] = value;
  }
  return out;
}

function realRunner(env: Record<string, string | undefined>): Runner {
  return async (cmd, { cwd }) => {
    const proc = Bun.spawn(cmd, { cwd, env: childEnv(env), stdout: "pipe", stderr: "pipe", timeout: 600_000 });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    return { code: proc.exitCode ?? -1, stdout, stderr: proc.exitCode === null ? `${stderr}\ntimed out or killed` : stderr };
  };
}

function usage(): string {
  return [
    "usage: bun run check:security -- [--strict] [--offline] [--only a,b] [--audit-level low|moderate|high|critical] [--list]",
    `checks: ${CHECK_IDS.join(", ")}`,
    "external tools are found at $<TOOL>_BIN, $AGNI_TOOLS_DIR (default ~/.agni-tools/bin), then PATH; a missing tool is skipped, and fails only with --strict",
  ].join("\n");
}

export async function main(argv: string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  let strict = false;
  let offline = false;
  let only: string[] | undefined;
  let auditLevel: AuditLevel = "high";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = (name: string): string | undefined => (arg === name ? argv[++i] : arg.startsWith(`${name}=`) ? arg.slice(name.length + 1) : undefined);
    if (arg === "--strict") strict = true;
    else if (arg === "--offline") offline = true;
    else if (arg === "--help" || arg === "-h") { console.log(usage()); return 0; }
    else if (arg === "--list") {
      for (const id of CHECK_IDS) console.log(`${id.padEnd(17)} ${TITLES[id]}`);
      return 0;
    } else if (arg === "--only" || arg.startsWith("--only=")) only = (value("--only") ?? "").split(",").map((part) => part.trim()).filter(Boolean);
    else if (arg === "--audit-level" || arg.startsWith("--audit-level=")) {
      const level = value("--audit-level") ?? "";
      if (!(level in SEVERITY_RANK)) { console.error(`bad --audit-level "${level}"\n${usage()}`); return 2; }
      auditLevel = level as AuditLevel;
    } else { console.error(`unknown argument "${arg}"\n${usage()}`); return 2; }
  }
  const root = join(import.meta.dir, "..");
  let results: CheckResult[];
  try {
    results = await runChecks({
      root, strict, offline, auditLevel, only,
      run: realRunner(env),
      which: (name) => Bun.which(name, { PATH: env.PATH ?? "" }),
      exists: existsSync,
      home: env.USERPROFILE || env.HOME || homedir(),
      env,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  console.log(formatReport(results));
  return exitCodeFor(results, strict);
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
