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
