/**
 * S2-08: an approval rule may name a resource pattern instead of one exact
 * target. It is still one bot and one tool, it never matches a shell tool or a
 * write outside scratch, and every resource of a call must fit the pattern.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db";
import type { ToolResource } from "../src/policy/tool-meta";
import {
  addApprovalRule,
  listApprovalRules,
  matchApprovalRule,
  matchResourcePattern,
  revokeApprovalRule,
  validateResourcePattern,
} from "../src/stores/approval-rules";

let db: Database;
let root: string;
let savedScratch: string | undefined;

beforeEach(() => {
  db = openDatabase(":memory:");
  root = mkdtempSync(join(tmpdir(), "agni-s2-rules-"));
  mkdirSync(join(root, "scratch"), { recursive: true });
  savedScratch = process.env.AGNI_SCRATCH_DIR;
  process.env.AGNI_SCRATCH_DIR = join(root, "scratch");
});

afterEach(() => {
  db.close();
  if (savedScratch === undefined) delete process.env.AGNI_SCRATCH_DIR;
  else process.env.AGNI_SCRATCH_DIR = savedScratch;
  rmSync(root, { recursive: true, force: true });
});

const recipient = (value: string): ToolResource => ({ kind: "recipient", value });
const host = (value: string): ToolResource => ({ kind: "host", value });
const path = (value: string): ToolResource => ({ kind: "path", value });

describe("matchResourcePattern", () => {
  test("a pattern with no star is an exact match", () => {
    expect(matchResourcePattern("ann@example.com", recipient("ann@example.com"))).toBe(true);
    expect(matchResourcePattern("ann@example.com", recipient("bob@example.com"))).toBe(false);
  });

  test("a star stands for part of one segment, never across a slash", () => {
    const base = join(root, "scratch").replace(/\\/g, "/");
    expect(matchResourcePattern(`${base}/reports/*.txt`, path(`${base}/reports/q3.txt`))).toBe(true);
    expect(matchResourcePattern(`${base}/reports/*.txt`, path(`${base}/reports/sub/q3.txt`))).toBe(false);
    expect(matchResourcePattern(`${base}/reports/*.txt`, path(`${base}/reports/q3.txt.exe`))).toBe(false);
  });

  test("the whole value must match: a pattern is not a prefix or a substring", () => {
    expect(matchResourcePattern("*@example.com", recipient("a@example.com.attacker.net"))).toBe(false);
    expect(matchResourcePattern("*@example.com", recipient("a@evilexample.com"))).toBe(false);
    expect(matchResourcePattern("*@example.com", recipient("a@example.com"))).toBe(true);
  });

  test("the domain of an address is compared without case, the local part is exact", () => {
    expect(matchResourcePattern("ann@Example.COM", recipient("ann@example.com"))).toBe(true);
    expect(matchResourcePattern("*@example.com", recipient("Ann@EXAMPLE.com"))).toBe(true);
    expect(matchResourcePattern("ann@example.com", recipient("Ann@example.com"))).toBe(false);
  });

  test("an address cannot smuggle a second address past a star", () => {
    expect(matchResourcePattern("*@example.com", recipient("x@evil.com,a@example.com"))).toBe(false);
    expect(matchResourcePattern("*@example.com", recipient("x@evil.com a@example.com"))).toBe(false);
    expect(matchResourcePattern("*@example.com", recipient("x@y@example.com"))).toBe(false);
  });

  test("a host pattern may start with a star", () => {
    expect(matchResourcePattern("*.example.com", host("api.example.com"))).toBe(true);
    expect(matchResourcePattern("*.example.com", host("API.Example.com"))).toBe(true);
    expect(matchResourcePattern("*.example.com", host("example.com"))).toBe(false);
    expect(matchResourcePattern("*.example.com", host("evilexample.com"))).toBe(false);
  });

  test("a path with a parent step never matches", () => {
    const base = join(root, "scratch").replace(/\\/g, "/");
    expect(matchResourcePattern(`${base}/reports/*`, path(`${base}/reports/../../secret`))).toBe(false);
  });

  test("regular-expression characters in a pattern are plain text", () => {
    expect(matchResourcePattern("a.b(c)+[d]", host("a.b(c)+[d]"))).toBe(true);
    expect(matchResourcePattern("a.b", host("axb"))).toBe(false);
  });
});

describe("validateResourcePattern", () => {
  test("accepts a narrow pattern", () => {
    expect(validateResourcePattern("*@example.com")).toBeNull();
    expect(validateResourcePattern("reports/*.txt")).toBeNull();
    expect(validateResourcePattern("*.example.com")).toBeNull();
    expect(validateResourcePattern("ann@example.com")).toBeNull();
  });

  test("refuses a pattern that would match nearly everything", () => {
    for (const bad of ["", "   ", "*", "**", "*@*", "*.*", "a/**/b", "*x", "x*", "*/*"]) {
      expect(validateResourcePattern(bad)).not.toBeNull();
    }
  });

  test("refuses whitespace, commas and control characters, and over-long patterns", () => {
    expect(validateResourcePattern("a b@example.com")).not.toBeNull();
    expect(validateResourcePattern("a@example.com,b@example.com")).not.toBeNull();
    expect(validateResourcePattern("a@example.com\u0000")).not.toBeNull();
    expect(validateResourcePattern(`${"a".repeat(400)}@example.com`)).not.toBeNull();
  });
});

describe("matchApprovalRule", () => {
  const add = (overrides: Partial<Parameters<typeof addApprovalRule>[1]> = {}) =>
    addApprovalRule(db, { agentID: "ea", toolName: "mail_send", target: "", account: "owner", resourcePattern: "*@example.com", ...overrides })!;
  const call = (overrides: Partial<Parameters<typeof matchApprovalRule>[1]> = {}) =>
    matchApprovalRule(db, { agentID: "ea", toolName: "mail_send", args: { account: "owner", to: ["a@example.com"], subject: "s", body: "b" }, resources: [recipient("a@example.com")], ...overrides });

  test("a pattern rule allows a call whose every resource fits", () => {
    const rule = add();
    expect(call()?.id).toBe(rule.id);
    expect(call({ args: { account: "owner", to: ["a@example.com", "b@example.com"], subject: "s", body: "b" }, resources: [recipient("a@example.com"), recipient("b@example.com")] })?.id).toBe(rule.id);
  });

  test("one resource outside the pattern means no match", () => {
    add();
    expect(call({ args: { account: "owner", to: ["a@example.com", "b@other.org"], subject: "s", body: "b" }, resources: [recipient("a@example.com"), recipient("b@other.org")] })).toBeNull();
  });

  test("a call with no resources matches no pattern", () => {
    add();
    expect(call({ args: { account: "owner", to: [], subject: "s", body: "b" }, resources: [] })).toBeNull();
    // A tool that is not mail uses the resources the engine gave.
    expect(call({ toolName: "calendar_create", resources: [] })).toBeNull();
  });

  test("it is still one bot and one tool", () => {
    add();
    expect(call({ agentID: "researcher" })).toBeNull();
    expect(call({ toolName: "calendar_create" })).toBeNull();
  });

  test("a revoked rule never matches", () => {
    const rule = add();
    revokeApprovalRule(db, rule.id);
    expect(call()).toBeNull();
  });

  test("an exact-target rule still matches the call it was made for, and is tried first", () => {
    const exact = addApprovalRule(db, { agentID: "ea", toolName: "mail_send", target: JSON.stringify({ account: "owner", to: ["a@example.com"] }) })!;
    add();
    const matched = call({ args: { account: "owner", to: ["a@example.com"], subject: "s", body: "b" } });
    expect(matched?.id).toBe(exact.id);
  });

  test("a shell tool never matches, whatever rule is stored", () => {
    db.run("INSERT INTO approval_rules (id, agent_id, tool_name, target, created_at, resource_pattern) VALUES ('rul_x', 'ea', 'bash', 'pattern:ls*', ?, 'ls*')", [new Date().toISOString()]);
    expect(call({ toolName: "bash", args: { command: "ls" }, resources: [{ kind: "other", value: "ls" }] })).toBeNull();
  });

  test("a write outside scratch never matches, even when the pattern fits", () => {
    const outside = join(root, "elsewhere", "x.txt").replace(/\\/g, "/");
    addApprovalRule(db, { agentID: "ea", toolName: "write_file", target: "", resourcePattern: `${root.replace(/\\/g, "/")}/elsewhere/*.txt` });
    expect(matchApprovalRule(db, { agentID: "ea", toolName: "write_file", args: { path: outside, content: "x" }, resources: [path(outside)] })).toBeNull();
  });

  test("a write inside scratch matches a scratch pattern", () => {
    const base = join(root, "scratch").replace(/\\/g, "/");
    const rule = addApprovalRule(db, { agentID: "ea", toolName: "write_file", target: "", resourcePattern: `${base}/reports/*.txt` })!;
    const inside = `${base}/reports/q3.txt`;
    expect(matchApprovalRule(db, { agentID: "ea", toolName: "write_file", args: { path: inside, content: "x" }, resources: [path(inside)] })?.id).toBe(rule.id);
  });
});

describe("storing pattern rules", () => {
  test("a rule is listed with its pattern, and adding the same one twice returns the first", () => {
    const first = addApprovalRule(db, { agentID: "ea", toolName: "mail_send", target: "", account: "owner", resourcePattern: "*@example.com" })!;
    const again = addApprovalRule(db, { agentID: "ea", toolName: "mail_send", target: "", account: "owner", resourcePattern: "*@example.com" })!;
    expect(again.id).toBe(first.id);
    const listed = listApprovalRules(db);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ toolName: "mail_send", resourcePattern: "*@example.com" });
  });

  test("a different pattern for the same bot and tool is its own rule", () => {
    addApprovalRule(db, { agentID: "ea", toolName: "mail_send", target: "", account: "owner", resourcePattern: "*@example.com" });
    addApprovalRule(db, { agentID: "ea", toolName: "mail_send", target: "", account: "owner", resourcePattern: "*@example.org" });
    expect(listApprovalRules(db)).toHaveLength(2);
  });

  test("a shell tool is refused, as before", () => {
    expect(addApprovalRule(db, { agentID: "ea", toolName: "bash", target: "", resourcePattern: "ls*" })).toBeNull();
    expect(addApprovalRule(db, { agentID: "ea", toolName: "run_privileged", target: "", resourcePattern: "ls*" })).toBeNull();
  });

  test("an unsafe pattern throws instead of storing a rule that matches everything", () => {
    expect(() => addApprovalRule(db, { agentID: "ea", toolName: "mail_send", target: "", resourcePattern: "*" })).toThrow(/pattern/);
    expect(listApprovalRules(db)).toHaveLength(0);
  });

  test("rules made the old way have no pattern", () => {
    addApprovalRule(db, { agentID: "ea", toolName: "task_create", target: '{"title":"x"}' });
    expect(listApprovalRules(db)[0]!.resourcePattern).toBeNull();
  });
});
