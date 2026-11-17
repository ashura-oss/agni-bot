import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { TOOLS, resolveTool } from "../check-security.ts";

/**
 * Each project rule has a rule file and a fixture beside it with the same name
 * (the layout `semgrep --test` expects). Two layers check them:
 *
 *  1. Always: the shape. Every rule parses, has an id that matches its file
 *     name, says why in its message, and its fixture holds at least one
 *     `ruleid:` line (must be reported) and one `ok:` line (must not be).
 *  2. When Semgrep is installed: `semgrep --test`, which runs every rule on
 *     its fixture and checks each annotation. Without Semgrep the rules'
 *     matching behaviour is NOT exercised by this file, and the run says so.
 */
const RULES_DIR = join(import.meta.dir, "rules");

interface Rule {
  id: string;
  languages: string[];
  severity: string;
  message: string;
  mode?: string;
  pattern?: string;
  patterns?: unknown[];
  "pattern-either"?: unknown[];
  "pattern-sources"?: unknown[];
  "pattern-sinks"?: unknown[];
}

const ruleFiles = readdirSync(RULES_DIR).filter((name) => name.endsWith(".yaml")).sort();

function loadRules(file: string): Rule[] {
  const doc = Bun.YAML.parse(readFileSync(join(RULES_DIR, file), "utf8")) as { rules?: Rule[] };
  return doc.rules ?? [];
}

describe("project Semgrep rules: shape", () => {
  test("the required rules are all present", () => {
    const ids = ruleFiles.map((file) => file.replace(/\.yaml$/, ""));
    for (const wanted of [
      "agni-env-spread-to-child",
      "agni-fetch-without-ssrf-guard",
      "agni-shell-exec-interpolated",
      "agni-spawn-interpolated-arg",
      "agni-model-json-into-sql",
      "agni-secret-in-log",
    ]) {
      expect(ids).toContain(wanted);
    }
  });

  for (const file of ruleFiles) {
    const name = file.replace(/\.yaml$/, "");

    test(`${name}: one rule, id equals file name, with a reason and a match condition`, () => {
      const rules = loadRules(file);
      expect(rules).toHaveLength(1);
      const rule = rules[0]!;
      expect(rule.id).toBe(name);
      expect(rule.id.startsWith("agni-")).toBe(true);
      expect(rule.languages).toContain("typescript");
      expect(["ERROR", "WARNING"]).toContain(rule.severity);
      expect(rule.message.length).toBeGreaterThan(80);
      const hasMatcher = rule.pattern || rule.patterns || rule["pattern-either"] || (rule.mode === "taint" && rule["pattern-sources"] && rule["pattern-sinks"]);
      expect(Boolean(hasMatcher)).toBe(true);
    });

    test(`${name}: the fixture has a positive and a negative case`, () => {
      const fixture = join(RULES_DIR, `${name}.ts`);
      expect(existsSync(fixture)).toBe(true);
      const text = readFileSync(fixture, "utf8");
      const positives = text.match(new RegExp(`//\\s*ruleid:\\s*${name}\\s*$`, "gm")) ?? [];
      const negatives = text.match(new RegExp(`//\\s*ok:\\s*${name}\\s*$`, "gm")) ?? [];
      expect(positives.length).toBeGreaterThanOrEqual(1);
      expect(negatives.length).toBeGreaterThanOrEqual(1);
      // An annotation must be followed by the line it describes.
      const lines = text.split(/\r?\n/);
      lines.forEach((line, index) => {
        if (new RegExp(`//\\s*(ruleid|ok):\\s*${name}\\s*$`).test(line)) {
          expect(lines[index + 1]?.trim() ?? "").not.toBe("");
          expect(lines[index + 1]).not.toMatch(/^\s*\/\//);
        }
      });
    });
  }

  test("every fixture belongs to a rule", () => {
    const fixtures = readdirSync(RULES_DIR).filter((name) => name.endsWith(".ts"));
    for (const fixture of fixtures) expect(ruleFiles).toContain(fixture.replace(/\.ts$/, ".yaml"));
  });
});

/**
 * Review-round coverage (S3-2 fix round). Semgrep is not required to run these:
 * they hold each rule and its fixture to the cases the review found missing, by
 * reading the YAML and the annotated fixture lines. They do not replace
 * `semgrep --test` below, which is the only thing that exercises matching.
 */
function ruleOf(name: string): Rule {
  return loadRules(`${name}.yaml`)[0]!;
}

function fixtureText(name: string): string {
  return readFileSync(join(RULES_DIR, `${name}.ts`), "utf8");
}

/** The code line that follows each `// <kind>: <name>` annotation in the fixture. */
function annotatedLines(name: string, kind: "ruleid" | "ok"): string[] {
  const lines = fixtureText(name).split(/\r?\n/);
  const out: string[] = [];
  lines.forEach((line, index) => {
    if (new RegExp(`//\\s*${kind}:\\s*${name}\\s*$`).test(line)) out.push(lines[index + 1] ?? "");
  });
  return out;
}

const CHILD_CALL = /\b(Bun\.)?(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\(/;

describe("project Semgrep rules: review-round coverage", () => {
  test("agni-env-spread-to-child: a child started with no env option is a positive, never a negative", () => {
    const positives = annotatedLines("agni-env-spread-to-child", "ruleid").filter((line) => CHILD_CALL.test(line) && !/\benv\b/.test(line));
    // node spawn, Bun.spawn and an exec* call, each with no env at all.
    expect(positives.some((line) => /(^|[^.\w])spawn\(/.test(line))).toBe(true);
    expect(positives.some((line) => /Bun\.spawn(Sync)?\(/.test(line))).toBe(true);
    expect(positives.some((line) => /\bexec(Sync|File|FileSync)?\(/.test(line))).toBe(true);
    const negatives = annotatedLines("agni-env-spread-to-child", "ok").filter((line) => CHILD_CALL.test(line));
    for (const line of negatives) expect(line).toMatch(/\benv\b/);
  });

  test("agni-env-spread-to-child: the rule has a branch for 'no env option'", () => {
    const text = JSON.stringify(ruleOf("agni-env-spread-to-child"));
    expect(text).toContain("pattern-not");
    expect(text).toContain("env: $E");
    // no options object at all, and an options object that lacks env
    expect(text).toContain("$F($CMD)");
    expect(text).toContain("$F(..., {...}, ...)");
  });

  test("agni-model-json-into-sql: tool handler arguments are a source, with a positive fixture", () => {
    const sources = JSON.stringify(ruleOf("agni-model-json-into-sql")["pattern-sources"]);
    expect(sources).toContain("handler");
    expect(sources).toContain("$ARGS");
    expect(fixtureText("agni-model-json-into-sql")).toMatch(/handler:\s*async\s*\(\s*args/);
    expect(annotatedLines("agni-model-json-into-sql", "ruleid").length).toBeGreaterThanOrEqual(3);
  });

  test("agni-model-json-into-sql: parsed tool-call args and arguments are sources", () => {
    const sources = JSON.stringify(ruleOf("agni-model-json-into-sql")["pattern-sources"]);
    expect(sources).toMatch(/\bargs\b/);
    expect(sources).toContain("arguments");
    expect(fixtureText("agni-model-json-into-sql")).toContain("JSON.parse(call.args)");
  });

  test("agni-fetch-without-ssrf-guard: every guard names the same URL value as the fetch", () => {
    const rule = ruleOf("agni-fetch-without-ssrf-guard") as unknown as { patterns: Record<string, string>[] };
    const guards = rule.patterns.filter((entry) => entry["pattern-not-inside"] !== undefined);
    expect(guards.length).toBeGreaterThanOrEqual(4);
    for (const guard of guards) expect(guard["pattern-not-inside"]).toContain("$URL");
  });

  test("agni-fetch-without-ssrf-guard: a guard on a different value does not clear the fetch", () => {
    const fixture = fixtureText("agni-fetch-without-ssrf-guard");
    expect(fixture).toContain("positiveGuardOnAnotherValue");
    expect(fixture).toContain("negativeGuardedUrlObject");
  });
});

const semgrep = resolveTool(TOOLS.semgrep, { env: process.env, exists: existsSync, which: (name) => Bun.which(name), home: process.env.USERPROFILE || process.env.HOME || homedir() });

describe("project Semgrep rules: matching", () => {
  if (!semgrep) console.warn("semgrep is not installed: rule matching is NOT tested here (shape only). Install: " + TOOLS.semgrep.install);

  test.skipIf(!semgrep)("semgrep --test passes: every ruleid line is reported and every ok line is not", () => {
    const proc = Bun.spawnSync([...semgrep!, "--test", "--metrics=off", RULES_DIR], { stdout: "pipe", stderr: "pipe" });
    const out = proc.stdout.toString() + proc.stderr.toString();
    expect(out).toMatch(/All tests passed|✓/);
    expect(proc.exitCode).toBe(0);
  });
});
