/**
 * Round 2: a padded argument the gate judges was refused only by the handler, after the owner had approved the card. Each
 * tool's validate hook (run with the schema, before any card) now refuses it; the handlers keep their own check. The fetch
 * tools no longer trim Unicode whitespace from a URL, and link_save is checked to pass the routine's host allowlist.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db";
import { decide } from "../src/policy/engine";
import { resetPolicyHooks } from "../src/policy/hooks";
import { noopAuditSink, setAuditSink } from "../src/policy/audit-sink";
import { registerSecureExecTool } from "../src/tools/secure-exec-tool";
import { buildTaskToolRegistry } from "../src/tools/task-registry";
import { exactProblem } from "../src/tools/exact-arg";
import { policyRig, type PolicyRig } from "./policy-fixture";

const PADS = [(v: string) => ` ${v}`, (v: string) => `${v} `, (v: string) => `\t${v}`, (v: string) => `${v}\n`, (v: string) => ` ${v}`, (v: string) => `${v} `, (v: string) => `﻿${v}`];
const PADDED = /must not start or end with spaces or line breaks/;
const REFUSED_URL = /must not start or end with spaces or line breaks|must be a valid URI/;
const CASES: Array<{ tool: string; args: Record<string, unknown>; field: string }> = [
  { tool: "write_file", args: { path: "out.txt", content: "hi" }, field: "path" },
  { tool: "read_file", args: { path: "out.txt" }, field: "path" },
  { tool: "grep", args: { pattern: "x", path: "sub" }, field: "path" },
  { tool: "glob", args: { pattern: "*.md", path: "sub" }, field: "path" },
  { tool: "bash", args: { command: "echo hi", cwd: "sub" }, field: "cwd" },
  { tool: "bash", args: { command: "echo hi" }, field: "command" },
  { tool: "run_privileged", args: { command: "sudo true", purpose: "test" }, field: "command" },
  { tool: "web_fetch", args: { url: "https://example.com/page" }, field: "url" },
  { tool: "link_save", args: { url: "https://example.com/page" }, field: "url" },
];

let home = "";
const savedEnv = { home: process.env.AGNI_HOME, scratch: process.env.AGNI_SCRATCH_DIR };
let db: Database | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agni-r2-val-"));
  mkdirSync(join(home, "scratch"));
  process.env.AGNI_HOME = home;
  process.env.AGNI_SCRATCH_DIR = join(home, "scratch");
});
afterEach(() => {
  db?.close();
  db = undefined;
  if (savedEnv.home === undefined) delete process.env.AGNI_HOME; else process.env.AGNI_HOME = savedEnv.home;
  if (savedEnv.scratch === undefined) delete process.env.AGNI_SCRATCH_DIR; else process.env.AGNI_SCRATCH_DIR = savedEnv.scratch;
  rmSync(home, { recursive: true, force: true });
});

describe("exactProblem", () => {
  test("names the first padded field, and nothing for exact or absent fields", () => {
    expect(exactProblem({ path: "a.txt" }, ["path"])).toBeNull();
    expect(exactProblem({}, ["path"])).toBeNull();
    expect(exactProblem({ path: 3 }, ["path"])).toBeNull();
    expect(exactProblem({ command: "ls", cwd: " sub" }, ["command", "cwd"])).toBe("cwd must not start or end with spaces or line breaks");
  });
});

describe("the validate hook refuses a padded judged argument before any card", () => {
  for (const { tool, args, field } of CASES) {
    test(`${tool}.${field}`, () => {
      db = openDatabase(":memory:");
      const registry = buildTaskToolRegistry(db);
      registerSecureExecTool(registry, { emit: () => undefined, threadID: "thr_r2" });
      expect(registry.validateArgs(tool, args), "the plain call is refused").toBeNull();
      for (const pad of PADS) expect(registry.validateArgs(tool, { ...args, [field]: pad(String(args[field])) }) ?? "").toMatch(field === "url" ? REFUSED_URL : PADDED);
    });
  }
});

describe("decide() refuses a padded write path instead of raising a card", () => {
  let rig: PolicyRig;
  beforeEach(() => { rig = policyRig(); });
  afterEach(() => { rig.close(); resetPolicyHooks(); setAuditSink(noopAuditSink); });
  test("write_file ' ../x' is refused as invalid arguments", () => {
    const decision = decide(rig.run, { tool: "write_file", args: { path: " ../x.txt", content: "x" }, callID: "c_r2" });
    expect(decision.action).toBe("refuse");
    if (decision.action === "refuse") expect(decision.code).toBe("invalid_arguments");
  });
});

describe("the fetch handlers", () => {
  const ctx = { threadID: "thr_r2", turnID: "trn_r2", signal: new AbortController().signal };
  test("refuse a URL padded with Unicode whitespace instead of trimming it", async () => {
    db = openDatabase(":memory:");
    const registry = buildTaskToolRegistry(db);
    for (const name of ["web_fetch", "link_save"]) {
      const handler = registry.get(name)!.handler as (args: unknown, ctx: unknown) => Promise<unknown>;
      // NBSP in front is not a URI at all: the schema refuses it before the handler runs.
      await expect(handler({ url: "\u00a0https://example.com/page" }, ctx), name).rejects.toThrow(REFUSED_URL);
      // A trailing U+2028 is a valid URI (percent-encoded), so only the handler's own exact check refuses it.
      await expect(handler({ url: "https://example.com/page\u2028" }, ctx), name).rejects.toThrow(PADDED);
    }
  });
  test("link_save passes the routine's host allowlist to the save", async () => {
    db = openDatabase(":memory:");
    const handler = buildTaskToolRegistry(db).get("link_save")!.handler as (args: unknown, ctx: unknown) => Promise<unknown>;
    await expect(handler({ url: "https://blocked.invalid/page" }, { ...ctx, hostAllowed: () => false })).rejects.toThrow("host outside the allowlist");
    expect(db.query("SELECT COUNT(*) AS n FROM links").get()).toEqual({ n: 0 });
  });
});
