import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * zizmor is not run on this machine, so these tests hold the workflow to the
 * rules zizmor would enforce, by construction: pinned actions, least
 * permissions, no template injection, no persisted credentials, no `latest`.
 * They read the file as text and as YAML; they do not run the workflow.
 */
const FILE = join(import.meta.dir, "..", ".github", "workflows", "security.yml");
const text = readFileSync(FILE, "utf8");

interface Step { name?: string; uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, unknown> }
interface Job { name?: string; "runs-on": string; permissions?: Record<string, string>; "timeout-minutes"?: number; steps: Step[]; env?: Record<string, unknown> }
interface Workflow { name?: string; on: Record<string, unknown> | string[]; permissions?: Record<string, string>; jobs: Record<string, Job>; env?: Record<string, unknown> }
const workflow = Bun.YAML.parse(text) as Workflow;

const allSteps = Object.values(workflow.jobs).flatMap((job) => job.steps);

describe(".github/workflows/security.yml", () => {
  test("has a name, and every job has a name and a timeout", () => {
    expect(workflow.name).toBeTruthy();
    for (const job of Object.values(workflow.jobs)) {
      expect(job.name).toBeTruthy();
      expect(job["timeout-minutes"]).toBeGreaterThan(0);
    }
  });

  test("every action is pinned to a full commit SHA with a version comment", () => {
    const uses = allSteps.filter((step) => step.uses).map((step) => step.uses!);
    expect(uses.length).toBeGreaterThan(0);
    for (const ref of uses) expect(ref).toMatch(/^[\w.-]+\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40}$/);
    for (const line of text.split(/\r?\n/).filter((l) => /^\s*-?\s*uses:/.test(l))) expect(line).toMatch(/@[0-9a-f]{40}\s+#\s*v\d/);
  });

  test("permissions are denied at the top and a job asks only to read contents", () => {
    expect(workflow.permissions).toEqual({});
    for (const job of Object.values(workflow.jobs)) expect(job.permissions).toEqual({ contents: "read" });
  });

  test("it never runs on pull_request_target or workflow_run, and does not use secrets", () => {
    const triggers = Array.isArray(workflow.on) ? workflow.on : Object.keys(workflow.on);
    expect(triggers).not.toContain("pull_request_target");
    expect(triggers).not.toContain("workflow_run");
    expect(text).not.toMatch(/\bsecrets\./);
  });

  test("no expression is expanded inside a run script (template injection)", () => {
    for (const step of allSteps) if (step.run) expect(step.run).not.toContain("${{");
  });

  test("checkout drops its credentials and fetches full history for the history scan", () => {
    const checkout = allSteps.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout).toBeDefined();
    expect(checkout!.with?.["persist-credentials"]).toBe(false);
    expect(checkout!.with?.["fetch-depth"]).toBe(0);
  });

  test("nothing is unpinned: no latest, no floating versions, tool versions are exact", () => {
    expect(text).not.toMatch(/\blatest\b/i);
    expect(text).toMatch(/semgrep==\d+\.\d+\.\d+/);
    expect(text).toMatch(/zizmor==\d+\.\d+\.\d+/);
    // Each downloaded binary is verified against a SHA-256 written in this file.
    expect(text.match(/[0-9a-f]{64}\s+\S+"\s*\|\s*sha256sum --check --strict -/g)?.length).toBe(2);
    const bun = allSteps.find((step) => step.uses?.startsWith("oven-sh/setup-bun@"));
    expect(String(bun?.with?.["bun-version"])).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("it runs the gates strictly (the default), so a missing tool fails instead of passing silently", () => {
    expect(text).toMatch(/run:\s*bun run check:security\s*$/m);
    expect(text).not.toMatch(/--allow-missing/);
  });

  test("it does not push, publish or deploy", () => {
    expect(text).not.toMatch(/git push|npm publish|gh release|docker push|upload-artifact|deploy/i);
  });
});

/**
 * .github/workflows/ci.yml predates the security work. It is held to the same
 * rules (pinned actions, no default permissions, no persisted credentials) and
 * to keeping what it ran before: the same checks in the same order.
 */
describe(".github/workflows/ci.yml", () => {
  const ciText = readFileSync(join(import.meta.dir, "..", ".github", "workflows", "ci.yml"), "utf8");
  const ci = Bun.YAML.parse(ciText) as Workflow;
  const ciSteps = Object.values(ci.jobs).flatMap((job) => job.steps);

  test("every action is pinned to a full commit SHA with a version comment", () => {
    const uses = ciSteps.filter((step) => step.uses).map((step) => step.uses!);
    expect(uses.length).toBeGreaterThan(0);
    for (const ref of uses) expect(ref).toMatch(/^[\w.-]+\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40}$/);
    for (const line of ciText.split(/\r?\n/).filter((l) => /^\s*-?\s*uses:/.test(l))) expect(line).toMatch(/@[0-9a-f]{40}\s+#\s*v\d/);
  });

  test("permissions are denied at the top and each job asks only to read contents", () => {
    expect(ci.permissions).toEqual({});
    for (const job of Object.values(ci.jobs)) expect(job.permissions).toEqual({ contents: "read" });
  });

  test("checkout drops its credentials", () => {
    const checkout = ciSteps.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout).toBeDefined();
    expect(checkout!.with?.["persist-credentials"]).toBe(false);
  });

  test("no expression is expanded inside a run script, no secrets, no risky triggers", () => {
    for (const step of ciSteps) if (step.run) expect(step.run).not.toContain("${{");
    const triggers = Array.isArray(ci.on) ? ci.on : Object.keys(ci.on);
    expect(triggers).not.toContain("pull_request_target");
    expect(triggers).not.toContain("workflow_run");
    expect(ciText).not.toMatch(/\bsecrets\./);
    expect(ciText).not.toMatch(/\blatest\b/i);
    expect(ciText).not.toMatch(/git push|npm publish|gh release|docker push|upload-artifact|deploy/i);
  });

  test("it still runs the same checks in the same order, on the same triggers", () => {
    expect(ciSteps.filter((step) => step.run).map((step) => step.run)).toEqual([
      "bun install --frozen-lockfile",
      "bun run typecheck",
      "bun run test:web",
      "bun run test",
      "bun run web:build",
      "bun infra/npm/build.ts && cd dist/npm && npm pack --dry-run",
      "bash -n infra/install.sh",
    ]);
    const setup = ciSteps.find((step) => step.uses?.startsWith("oven-sh/setup-bun@"));
    expect(setup?.with?.["bun-version-file"]).toBe("package.json");
    expect(Object.keys(ci.on as Record<string, unknown>).sort()).toEqual(["pull_request", "push"]);
    expect(Object.values(ci.jobs).map((job) => job["runs-on"])).toEqual(["ubuntu-24.04"]);
  });
});
