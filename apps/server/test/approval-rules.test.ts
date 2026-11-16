/**
 * S1-07: "Always allow" is remembered as a standing rule scoped to exactly one
 * bot, one tool and one target, until the owner revokes it. A rule must never
 * widen: not to another bot, another tool, or a near-miss target.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db";
import { ApprovalBroker, type Decision } from "../src/agent/approval-broker";
import { createThread, createTurn } from "../src/stores/threads";
import {
  addApprovalRule, approvalTarget, findApprovalRule, listApprovalRules, revokeApprovalRule,
} from "../src/stores/approval-rules";

let db: Database;
let root: string;
let savedScratch: string | undefined;

beforeEach(() => {
  db = openDatabase(":memory:");
  root = mkdtempSync(join(tmpdir(), "agni-t3-rules-"));
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

describe("approvalTarget: what a rule is scoped to", () => {
  test("bash is the exact command, normalised only for line endings and outer space", () => {
    expect(approvalTarget("bash", { command: "  rm -rf build\r\n" })).toBe("rm -rf build");
    // Inner whitespace is part of the command: a different string is a different target.
    expect(approvalTarget("bash", { command: "echo  a" })).not.toBe(approvalTarget("bash", { command: "echo a" }));
    expect(approvalTarget("bash", { command: "rm -rf build" })).not.toBe(approvalTarget("bash", { command: "rm -rf build2" }));
  });

  test("bash in another working directory is a different target", () => {
    const here = approvalTarget("bash", { command: "rm -rf build" });
    const there = approvalTarget("bash", { command: "rm -rf build", cwd: join(root, "elsewhere") });
    expect(there).not.toBe(here);
    expect(there).toContain("elsewhere");
  });

  test("write_file is the resolved absolute path, so relative and absolute spellings agree", () => {
    const abs = approvalTarget("write_file", { path: join(root, "scratch", "a", "b.txt"), content: "x" });
    expect(approvalTarget("write_file", { path: "a/b.txt", content: "y" })).toBe(abs);
    expect(approvalTarget("write_file", { path: "a/../a/b.txt", content: "y" })).toBe(abs);
    expect(approvalTarget("write_file", { path: "a/c.txt", content: "y" })).not.toBe(abs);
    if (process.platform === "win32") {
      expect(approvalTarget("write_file", { path: join(root, "SCRATCH", "A", "B.TXT"), content: "x" })).toBe(abs);
    }
  });

  test("mail_send is the account plus the recipient list, never the subject or body", () => {
    const a = approvalTarget("mail_send", { account: "owner", to: ["Bob@x.com", "amy@x.com"], subject: "one", body: "b1" });
    expect(approvalTarget("mail_send", { account: "owner", to: ["amy@X.COM", "Bob@x.com", "amy@x.com"], subject: "two", body: "b2" })).toBe(a);
    // The local part is exact: only the domain is case-insensitive.
    expect(approvalTarget("mail_send", { account: "owner", to: ["bob@x.com", "amy@x.com"], subject: "one", body: "b1" })).not.toBe(a);
    expect(approvalTarget("mail_send", { account: "owner", to: ["amy@x.com"], subject: "one", body: "b1" })).not.toBe(a);
    expect(approvalTarget("mail_send", { account: "agent", to: ["Bob@x.com", "amy@x.com"], subject: "one", body: "b1" })).not.toBe(a);
  });

  test("calendar_update is the account and event id; calendar_create is its exact arguments", () => {
    const u = approvalTarget("calendar_update", { account: "owner", eventId: "ev1", summary: "x" });
    expect(approvalTarget("calendar_update", { account: "owner", eventId: "ev1", summary: "different", location: "y" })).toBe(u);
    expect(approvalTarget("calendar_update", { account: "owner", eventId: "ev2" })).not.toBe(u);
    expect(approvalTarget("calendar_update", { account: "agent", eventId: "ev1" })).not.toBe(u);
    const c = approvalTarget("calendar_create", { account: "owner", summary: "x", start: "s", end: "e" });
    expect(approvalTarget("calendar_create", { account: "owner", summary: "x", start: "s", end: "e2" })).not.toBe(c);
  });

  test("any other tool is the canonical JSON of its arguments, key order aside", () => {
    const a = approvalTarget("mcp_files_delete", { path: "/x", opts: { b: 1, a: [2, 1] } });
    expect(approvalTarget("mcp_files_delete", { opts: { a: [2, 1], b: 1 }, path: "/x" })).toBe(a);
    expect(approvalTarget("mcp_files_delete", { opts: { a: [1, 2], b: 1 }, path: "/x" })).not.toBe(a);
    expect(approvalTarget("mcp_files_delete", { path: "/y", opts: { b: 1, a: [2, 1] } })).not.toBe(a);
  });

  test("run_privileged is never remembered: the owner reviews each command", () => {
    expect(approvalTarget("run_privileged", { command: "sudo ls", purpose: "list" })).toBeNull();
  });

  test("a write_file whose path cannot be resolved has no target", () => {
    expect(approvalTarget("write_file", { path: "", content: "x" })).toBeNull();
    expect(approvalTarget("write_file", { content: "x" })).toBeNull();
  });
});

describe("the rule store", () => {
  const rule = { agentID: "ea", toolName: "bash", target: "rm -rf build" };

  test("an added rule is found by its exact bot, tool and target, and by nothing else", () => {
    const added = addApprovalRule(db, rule);
    expect(added.id).toStartWith("rul_");
    expect(findApprovalRule(db, "ea", "bash", "rm -rf build")?.id).toBe(added.id);
    expect(findApprovalRule(db, "other-bot", "bash", "rm -rf build")).toBeNull();
    expect(findApprovalRule(db, "ea", "write_file", "rm -rf build")).toBeNull();
    expect(findApprovalRule(db, "ea", "bash", "rm -rf build ")).toBeNull();
    expect(findApprovalRule(db, "ea", "bash", "rm -rf")).toBeNull();
    expect(findApprovalRule(db, "ea", "bash", "rm -rf build && ls")).toBeNull();
    expect(findApprovalRule(db, "ea", "bash", "RM -RF BUILD")).toBeNull();
  });

  test("target text is data: SQL wildcards and quotes match nothing extra", () => {
    addApprovalRule(db, { agentID: "ea", toolName: "bash", target: "ls %" });
    addApprovalRule(db, { agentID: "ea", toolName: "bash", target: "it's" });
    expect(findApprovalRule(db, "ea", "bash", "ls anything")).toBeNull();
    expect(findApprovalRule(db, "ea", "bash", "ls %")).not.toBeNull();
    expect(findApprovalRule(db, "ea", "bash", "it's")).not.toBeNull();
    expect(findApprovalRule(db, "ea", "bash", "' OR '1'='1")).toBeNull();
  });

  test("adding the same active rule twice keeps one rule", () => {
    const first = addApprovalRule(db, rule);
    const second = addApprovalRule(db, rule);
    expect(second.id).toBe(first.id);
    expect(listApprovalRules(db)).toHaveLength(1);
  });

  test("listApprovalRules returns active rules; revoked ones only on request", () => {
    const a = addApprovalRule(db, rule);
    const b = addApprovalRule(db, { ...rule, target: "ls" });
    expect(listApprovalRules(db).map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    expect(revokeApprovalRule(db, a.id)).toBe(true);
    expect(listApprovalRules(db).map((r) => r.id)).toEqual([b.id]);
    const all = listApprovalRules(db, { includeRevoked: true });
    expect(all.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    expect(all.find((r) => r.id === a.id)?.revokedAt).not.toBeNull();
    expect(all.find((r) => r.id === b.id)?.revokedAt).toBeNull();
  });

  test("a revoked rule no longer matches, and revoking twice or an unknown id is false", () => {
    const a = addApprovalRule(db, rule);
    expect(revokeApprovalRule(db, a.id)).toBe(true);
    expect(findApprovalRule(db, "ea", "bash", "rm -rf build")).toBeNull();
    expect(revokeApprovalRule(db, a.id)).toBe(false);
    expect(revokeApprovalRule(db, "rul_nope")).toBe(false);
  });

  test("after a revoke the owner can allow the same thing again as a fresh rule", () => {
    const a = addApprovalRule(db, rule);
    revokeApprovalRule(db, a.id);
    const again = addApprovalRule(db, rule);
    expect(again.id).not.toBe(a.id);
    expect(findApprovalRule(db, "ea", "bash", "rm -rf build")?.id).toBe(again.id);
  });
});

describe("the broker uses rules", () => {
  function harness(answers: Decision[], agentID = "ea") {
    const thread = createThread(db, agentID);
    const frames: Array<{ type: string; requestID: string; preview: string }> = [];
    let asked = 0;
    const broker = new ApprovalBroker({
      db,
      emit: (frame) => frames.push(frame),
      waitForDecision: async (requestID) => {
        asked += 1;
        const decision = answers.shift() ?? null;
        // What ws/dispatch does when the owner clicks.
        if (decision) db.run("UPDATE approvals SET status='decided', decision=?, decided_at=? WHERE id=?", [decision, new Date().toISOString(), requestID]);
        return decision;
      },
    });
    let n = 0;
    const ask = async (toolName: string, args: Record<string, unknown>, who = { threadID: thread.id, agentID }) => {
      n += 1;
      const turnID = `trn_${agentID}_${n}`;
      createTurn(db, { id: turnID, threadID: who.threadID, agentID: who.agentID });
      return broker.request(who.threadID, turnID, toolName, `call_${n}`, args, new AbortController().signal);
    };
    return { broker, frames, ask, thread, get asked() { return asked; } };
  }

  const rows = () => db.query("SELECT * FROM approvals ORDER BY rowid").all() as Array<Record<string, unknown>>;

  test("answering always stores a rule; the same call then runs without a card", async () => {
    const h = harness(["always"]);
    expect(await h.ask("bash", { command: "rm -rf build" })).toBe("always");
    expect(h.frames).toHaveLength(1);
    expect(listApprovalRules(db)).toHaveLength(1);
    expect(listApprovalRules(db)[0]).toMatchObject({ agentID: "ea", toolName: "bash", target: "rm -rf build" });

    expect(await h.ask("bash", { command: "rm -rf build" })).toBe("always");
    expect(h.frames).toHaveLength(1); // no second card
    expect(h.asked).toBe(1); // and nobody was waited on
  });

  test("an auto-approved call is still an approval row that says a rule matched", async () => {
    const h = harness(["always"]);
    await h.ask("bash", { command: "rm -rf build" });
    await h.ask("bash", { command: "rm -rf build" });
    const [first, second] = rows();
    const rule = listApprovalRules(db)[0]!;
    expect(first).toMatchObject({ status: "decided", decision: "always", rule_id: null });
    expect(second).toMatchObject({ status: "decided", decision: "always", rule_id: rule.id, tool_name: "bash" });
    expect(second!.decided_at).toBeTruthy();
    expect(String(second!.action)).toContain("rm -rf build");
    expect(String(second!.action)).toContain("standing rule");
    expect(String(second!.preview)).toContain(rule.id);
    expect(String(second!.preview)).toContain("Auto-approved");
  });

  test("once and reject never create a rule", async () => {
    const h = harness(["once", "reject", "once"]);
    await h.ask("bash", { command: "rm -rf build" });
    await h.ask("bash", { command: "rm -rf build" });
    await h.ask("bash", { command: "rm -rf build" });
    expect(listApprovalRules(db)).toHaveLength(0);
    expect(h.frames).toHaveLength(3);
  });

  test("a cancelled wait (null) never creates a rule", async () => {
    const h = harness([]);
    expect(await h.ask("bash", { command: "rm -rf build" })).toBeNull();
    expect(listApprovalRules(db)).toHaveLength(0);
  });

  test("a rule for one bot does not approve another bot", async () => {
    const a = harness(["always"], "ea");
    await a.ask("bash", { command: "rm -rf build" });
    const b = harness(["reject"], "researcher");
    expect(await b.ask("bash", { command: "rm -rf build" })).toBe("reject");
    expect(b.frames).toHaveLength(1);
  });

  test("a rule does not approve a different tool or a different target", async () => {
    const h = harness(["always", "reject", "reject", "reject"]);
    await h.ask("bash", { command: "rm -rf build" });
    expect(await h.ask("bash", { command: "rm -rf build2" })).toBe("reject");
    expect(await h.ask("bash", { command: "rm -rf build; rm -rf /" })).toBe("reject");
    expect(await h.ask("some_other_tool", { command: "rm -rf build" })).toBe("reject");
    expect(h.frames).toHaveLength(4);
  });

  test("a revoked rule asks again", async () => {
    const h = harness(["always", "once"]);
    await h.ask("bash", { command: "rm -rf build" });
    revokeApprovalRule(db, listApprovalRules(db)[0]!.id);
    expect(await h.ask("bash", { command: "rm -rf build" })).toBe("once");
    expect(h.frames).toHaveLength(2);
  });

  test("always on write_file remembers the resolved path, not the content", async () => {
    mkdirSync(join(root, "outside"), { recursive: true });
    const target = join(root, "outside", "notes.md");
    const h = harness(["always", "reject"]);
    await h.ask("write_file", { path: target, content: "v1" });
    expect(await h.ask("write_file", { path: target, content: "v2 entirely different" })).toBe("always");
    expect(await h.ask("write_file", { path: join(root, "outside", "other.md"), content: "v1" })).toBe("reject");
  });

  test("always on a tool that is never remembered stores nothing", async () => {
    const h = harness(["always", "once"]);
    expect(await h.ask("run_privileged", { command: "sudo ls", purpose: "list" })).toBe("always");
    expect(listApprovalRules(db)).toHaveLength(0);
    expect(await h.ask("run_privileged", { command: "sudo ls", purpose: "list" })).toBe("once");
    expect(h.frames).toHaveLength(2);
  });

  test("a turn the server cannot attribute to a bot never matches or stores a rule", async () => {
    const h = harness(["always", "always"]);
    // No turn row, no thread row: there is no bot to scope the rule to.
    const orphan = (id: string) => h.broker.request("thr_missing", "trn_missing", "bash", id, { command: "ls x" }, new AbortController().signal);
    await orphan("call_a");
    await orphan("call_b");
    expect(listApprovalRules(db)).toHaveLength(0);
    expect(h.frames).toHaveLength(2);
  });

  test("a rule is read from the turn's bot, so a handoff turn does not borrow the thread owner's rules", async () => {
    // One thread owned by "ea"; a handoff child turn in it belongs to "researcher".
    const h = harness(["always", "reject"], "ea");
    await h.ask("bash", { command: "rm -rf build" });
    createTurn(db, { id: "trn_child", threadID: h.thread.id, agentID: "researcher" });
    const decision = await h.broker.request(h.thread.id, "trn_child", "bash", "call_child", { command: "rm -rf build" }, new AbortController().signal);
    expect(decision).toBe("reject");
  });

  test("the rule table exists after migration with the documented columns", () => {
    const cols = (db.query("PRAGMA table_info(approval_rules)").all() as Array<{ name: string }>).map((c) => c.name);
    for (const name of ["id", "agent_id", "tool_name", "target", "created_at", "revoked_at"]) expect(cols).toContain(name);
  });
});
