/**
 * S1-07: "Always allow" is remembered as a standing rule scoped to exactly one
 * bot, one tool and one target, until the owner revokes it. A rule must never
 * widen: not to another bot, another tool, or a near-miss target.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDatabase } from "../src/db";
import { MIGRATIONS } from "../src/db/migrations";
import { ApprovalBroker, type Decision } from "../src/agent/approval-broker";
import { createThread, createTurn } from "../src/stores/threads";
import { buildTaskToolRegistry } from "../src/tools/task-registry";
import { registerSecureExecTool } from "../src/tools/secure-exec-tool";
import { createRunContext } from "../src/policy/context";
import { gateToolCall } from "../src/agent/tool-gate";
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

/** For tests of rules that may be stored: a null here is a failure. */
const addRule = (...args: Parameters<typeof addApprovalRule>) => addApprovalRule(...args)!;

describe("approvalTarget: what a rule is scoped to", () => {
  test("bash is never remembered, whatever the command or working directory", () => {
    for (const command of ["rm -rf build", "ls -la", "cat notes.txt", "echo hi", "pwd", "  cat notes.txt\r\n"]) {
      expect({ command, target: approvalTarget("bash", { command }) }).toEqual({ command, target: null });
      expect(approvalTarget("bash", { command, cwd: join(root, "elsewhere") })).toBeNull();
    }
    expect(approvalTarget("bash", {})).toBeNull();
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

  test("calendar_update and calendar_create are their exact arguments, key order aside", () => {
    const u = approvalTarget("calendar_update", { account: "owner", eventId: "ev1", summary: "x" });
    expect(approvalTarget("calendar_update", { summary: "x", eventId: "ev1", account: "owner" })).toBe(u);
    // A different edit to the same event is a different thing to allow.
    expect(approvalTarget("calendar_update", { account: "owner", eventId: "ev1", summary: "different", location: "y" })).not.toBe(u);
    expect(approvalTarget("calendar_update", { account: "owner", eventId: "ev1", summary: "x", attendees: ["evil@x.com"] })).not.toBe(u);
    expect(approvalTarget("calendar_update", { account: "owner", eventId: "ev2", summary: "x" })).not.toBe(u);
    expect(approvalTarget("calendar_update", { account: "agent", eventId: "ev1", summary: "x" })).not.toBe(u);
    const c = approvalTarget("calendar_create", { account: "owner", summary: "x", start: "s", end: "e" });
    expect(approvalTarget("calendar_create", { account: "owner", summary: "x", start: "s", end: "e2" })).not.toBe(c);
  });

  test("any other tool is the canonical JSON of its arguments, key order aside", () => {
    const a = approvalTarget("mcp_files_delete", { path: "/x", opts: { b: 1, a: [2, 1] } });
    expect(approvalTarget("mcp_files_delete", { opts: { a: [2, 1], b: 1 }, path: "/x" })).toBe(a);
    expect(approvalTarget("mcp_files_delete", { opts: { a: [1, 2], b: 1 }, path: "/x" })).not.toBe(a);
    expect(approvalTarget("mcp_files_delete", { path: "/y", opts: { b: 1, a: [2, 1] } })).not.toBe(a);
  });

  test("no bash command is ever remembered: runners, redirects, metacharacters, even plain read-only ones", () => {
    // An interpreter, shell, script or build/test tool runs whatever the files
    // it names say today; a file the bot can append to would turn a rule into
    // a shell without asking. Checked per command segment, not just the first.
    const runsCode = [
      "python3 run.py", "python run.py", "node x.js", "bun test", "deno run x.ts", "sh x.sh", "bash -c 'rm -rf x'", "zsh x", "pwsh -File a.ps1",
      "powershell -c ls", "cmd /c dir", "make test", "npm test", "npx tsc", "pnpm i", "yarn build", "pytest", "cargo run", "go run .", "java Main",
      "ruby a.rb", "perl a.pl", "php a.php", "python3.11 run.py", "Python.exe run.py", "./run.sh", "../tools/x", "/usr/bin/thing", "C:\\tools\\x.exe a",
      "scripts\\run.cmd", "~/bin/thing", "cd build && python run.py", "ls; sh x", "echo hi | sh", "FOO=1 python x.py", "sudo rm x", "env python x.py",
      "xargs rm", "nohup ./x", "time python x", "echo $(python x.py)", "echo `node x.js`", "(python x.py)", "ls\npython x.py", "eval ls", "source x.sh", ". ./x.sh",
      "find . -exec rm {} ;", "timeout 5 ls",
      // Gaps a denylist leaves: an interpreter it never heard of, shell syntax, quoting, expansion.
      "py run.py", "if true; then ls; fi", "! ls", "while true; do ls; done", "p''ython run.py", "pyth\on run.py", "$X run.py", "ls $X", "ls ${X}", "$(ls)",
      "git status", "git log --oneline -5", "git diff HEAD~1", "git show abc123", "git commit -m x", "git push origin main", "git -c core.pager=./x log", "git log --ext-diff", "git diff --textconv", "git status --exec=x", "git",
      "jest", "vitest run", "poetry run x", "pipenv run x", "conda run x", "docker run x", "cscript a.vbs", "wscript a.vbs", "mshta x", "gcc x.c", "sed e", "sed -n p",
      "ls > run.py", "echo hi > run.cmd", "echo x >> a.bat", "cat a >run.sh", "ls < in", "cat a | python", "cat a | py", "rm -rf build; py x.py", "ls && py x.py",
      "LS", "ls.exe", "'ls' x", "FOO=1 ls", "mkdir -p out && node x", "unknowntool --flag",
      // The plain, read-only commands an earlier design remembered.
      "rm -rf build", "ls -la", "dir", "cat notes.md", "type notes.md", "head -n 5 a.txt", "tail -f a.log", "wc -l a", "mkdir -p out/x", "cp a b", "copy a b",
      "mv old new", "move old new", "del old.txt", "touch a", "echo python", "echo hi there", "ls -la | wc -l", "mv old new && ls", "ls; pwd", "pwd", "echo hi",
    ];
    for (const command of runsCode) expect({ command, target: approvalTarget("bash", { command }) }).toEqual({ command, target: null });
  });

  test("run_privileged is never remembered: the owner reviews each command", () => {
    expect(approvalTarget("run_privileged", { command: "sudo ls", purpose: "list" })).toBeNull();
  });

  test("write_file outside scratch has no target; inside scratch it does", () => {
    expect(approvalTarget("write_file", { path: join(root, "outside", "x.txt"), content: "x" })).toBeNull();
    expect(approvalTarget("write_file", { path: "../outside/x.txt", content: "x" })).toBeNull();
    expect(approvalTarget("write_file", { path: join(root, "scratch-sibling", "x.txt"), content: "x" })).toBeNull();
    expect(approvalTarget("write_file", { path: "inside/x.txt", content: "x" })).not.toBeNull();
    expect(approvalTarget("write_file", { path: join(root, "scratch", "x.txt"), content: "x" })).not.toBeNull();
  });

  test("a write_file whose path cannot be resolved has no target", () => {
    expect(approvalTarget("write_file", { path: "", content: "x" })).toBeNull();
    expect(approvalTarget("write_file", { content: "x" })).toBeNull();
  });
});

describe("the rule store", () => {
  const rule = { agentID: "ea", toolName: "mcp_files_delete", target: "rm -rf build" };

  test("an added rule is found by its exact bot, tool and target, and by nothing else", () => {
    const added = addRule(db, rule);
    expect(added.id).toStartWith("rul_");
    expect(findApprovalRule(db, "ea", "mcp_files_delete", "rm -rf build")?.id).toBe(added.id);
    expect(findApprovalRule(db, "other-bot", "mcp_files_delete", "rm -rf build")).toBeNull();
    expect(findApprovalRule(db, "ea", "write_file", "rm -rf build")).toBeNull();
    expect(findApprovalRule(db, "ea", "mcp_files_delete", "rm -rf build ")).toBeNull();
    expect(findApprovalRule(db, "ea", "mcp_files_delete", "rm -rf")).toBeNull();
    expect(findApprovalRule(db, "ea", "mcp_files_delete", "rm -rf build && ls")).toBeNull();
    expect(findApprovalRule(db, "ea", "mcp_files_delete", "RM -RF BUILD")).toBeNull();
  });

  test("target text is data: SQL wildcards and quotes match nothing extra", () => {
    addRule(db, { agentID: "ea", toolName: "mcp_files_delete", target: "ls %" });
    addRule(db, { agentID: "ea", toolName: "mcp_files_delete", target: "it's" });
    expect(findApprovalRule(db, "ea", "mcp_files_delete", "ls anything")).toBeNull();
    expect(findApprovalRule(db, "ea", "mcp_files_delete", "ls %")).not.toBeNull();
    expect(findApprovalRule(db, "ea", "mcp_files_delete", "it's")).not.toBeNull();
    expect(findApprovalRule(db, "ea", "mcp_files_delete", "' OR '1'='1")).toBeNull();
  });

  test("adding the same active rule twice keeps one rule", () => {
    const first = addRule(db, rule);
    const second = addRule(db, rule);
    expect(second.id).toBe(first.id);
    expect(listApprovalRules(db)).toHaveLength(1);
  });

  test("listApprovalRules returns active rules; revoked ones only on request", () => {
    const a = addRule(db, rule);
    const b = addRule(db, { ...rule, target: "ls" });
    expect(listApprovalRules(db).map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    expect(revokeApprovalRule(db, a.id)).toBe(true);
    expect(listApprovalRules(db).map((r) => r.id)).toEqual([b.id]);
    const all = listApprovalRules(db, { includeRevoked: true });
    expect(all.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    expect(all.find((r) => r.id === a.id)?.revokedAt).not.toBeNull();
    expect(all.find((r) => r.id === b.id)?.revokedAt).toBeNull();
  });

  test("a revoked rule no longer matches, and revoking twice or an unknown id is false", () => {
    const a = addRule(db, rule);
    expect(revokeApprovalRule(db, a.id)).toBe(true);
    expect(findApprovalRule(db, "ea", "mcp_files_delete", "rm -rf build")).toBeNull();
    expect(revokeApprovalRule(db, a.id)).toBe(false);
    expect(revokeApprovalRule(db, "rul_nope")).toBe(false);
  });

  test("after a revoke the owner can allow the same thing again as a fresh rule", () => {
    const a = addRule(db, rule);
    revokeApprovalRule(db, a.id);
    const again = addRule(db, rule);
    expect(again.id).not.toBe(a.id);
    expect(findApprovalRule(db, "ea", "mcp_files_delete", "rm -rf build")?.id).toBe(again.id);
  });

  test("a tool that is never remembered cannot be stored or found, whoever calls", () => {
    for (const toolName of ["bash", "run_privileged"]) {
      expect(addApprovalRule(db, { agentID: "ea", toolName, target: "ls" })).toBeNull();
      expect(db.query("SELECT count(*) AS n FROM approval_rules WHERE tool_name = ?").get(toolName)).toEqual({ n: 0 });
      // A row that got in some other way is never found either.
      db.run("INSERT INTO approval_rules (id, agent_id, tool_name, target, created_at) VALUES (?, 'ea', ?, 'ls', ?)", [`rul_old_${toolName}`, toolName, new Date().toISOString()]);
      expect(findApprovalRule(db, "ea", toolName, "ls")).toBeNull();
    }
  });
});

describe("migration 51 retires shell rules", () => {
  test("rules already stored for bash and run_privileged are revoked; the rest are untouched", () => {
    const old = new Database(":memory:");
    old.exec("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);");
    for (const migration of MIGRATIONS.filter((entry) => entry.id <= 50)) {
      old.transaction(() => {
        old.exec(migration.sql);
        old.run("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)", [migration.id, migration.name, "test"]);
      })();
    }
    const insert = (id: string, tool: string, revokedAt: string | null) =>
      old.run("INSERT INTO approval_rules (id, agent_id, tool_name, target, created_at, revoked_at) VALUES (?, 'ea', ?, ?, 'then', ?)", [id, tool, id, revokedAt]);
    insert("r_bash", "bash", null);
    insert("r_priv", "run_privileged", null);
    insert("r_write", "write_file", null);
    insert("r_mcp", "mcp_files_delete", null);
    insert("r_bash_already", "bash", "earlier");

    expect(migrate(old)).toEqual(MIGRATIONS.filter((entry) => entry.id > 50).map((entry) => entry.id));
    const state = Object.fromEntries((old.query("SELECT id, revoked_at FROM approval_rules").all() as Array<{ id: string; revoked_at: string | null }>).map((r) => [r.id, r.revoked_at]));
    expect(state.r_bash).not.toBeNull();
    expect(state.r_priv).not.toBeNull();
    expect(state.r_bash_already).toBe("earlier");
    expect(state.r_write).toBeNull();
    expect(state.r_mcp).toBeNull();
    expect(MIGRATIONS.find((entry) => entry.id === 51)?.name).toBe("revoke_shell_rules");
    old.close();
  });
});

describe("the broker uses rules", () => {
  /** Calls go through the policy engine and the gate, as in a turn: the engine looks the rules up, the broker draws the card. */
  function harness(answers: Decision[], agentID = "ea", approvalNote?: (toolName: string) => string | undefined) {
    const thread = createThread(db, agentID);
    const frames: Array<{ type: string; requestID: string; preview: string; buttons: Decision[] }> = [];
    let asked = 0;
    let lastAnswer: Decision | null = null;
    const broker = new ApprovalBroker({
      db,
      emit: (frame) => frames.push(frame),
      approvalNote,
      waitForDecision: async (requestID) => {
        asked += 1;
        const decision = answers.shift() ?? null;
        lastAnswer = decision;
        // What ws/dispatch does when the owner clicks.
        if (decision) db.run("UPDATE approvals SET status='decided', decision=?, decided_at=? WHERE id=?", [decision, new Date().toISOString(), requestID]);
        return decision;
      },
    });
    const registry = buildTaskToolRegistry(db);
    registerSecureExecTool(registry, { emit: () => undefined, threadID: thread.id });
    for (const name of ["mcp_files_delete", "mcp_gh_delete", "some_other_tool"]) {
      registry.register({ name, description: "x", kind: "static", schema: { type: "object", properties: {} }, timeoutMs: 1000, handler: async () => ({}) });
    }
    let n = 0;
    const ask = async (toolName: string, args: Record<string, unknown>, who = { threadID: thread.id, agentID }) => {
      n += 1;
      const turnID = `trn_${who.agentID}_${n}`;
      createTurn(db, { id: turnID, threadID: who.threadID, agentID: who.agentID });
      const run = createRunContext({
        db, bot: who.agentID, threadID: who.threadID, turnID, principal: { kind: "owner" },
        capabilities: registry.list().map((tool) => tool.name), registry,
      });
      lastAnswer = null;
      const gate = await gateToolCall(
        { db, broker, emit: () => undefined, setState: () => undefined, hold: () => () => undefined, ownerWaitMs: 60_000 },
        run, { tool: toolName, args, callID: `call_${n}` }, new AbortController().signal,
      );
      if (gate.go) return gate.approvedBy === "rule" ? "always" : gate.approvedBy === "owner" ? lastAnswer : "free";
      return /denied/.test(gate.content) ? "reject" : /cancelled/.test(gate.content) ? null : "refused";
    };
    return { broker, frames, ask, thread, get asked() { return asked; } };
  }

  const rows = () => db.query("SELECT * FROM approvals ORDER BY rowid").all() as Array<Record<string, unknown>>;

  test("answering always stores a rule; the same call then runs without a card", async () => {
    const h = harness(["always"]);
    expect(await h.ask("mcp_files_delete", { path: "build" })).toBe("always");
    expect(h.frames).toHaveLength(1);
    expect(listApprovalRules(db)).toHaveLength(1);
    expect(listApprovalRules(db)[0]).toMatchObject({ agentID: "ea", toolName: "mcp_files_delete", target: '{"path":"build"}' });

    expect(await h.ask("mcp_files_delete", { path: "build" })).toBe("always");
    expect(h.frames).toHaveLength(1); // no second card
    expect(h.asked).toBe(1); // and nobody was waited on
  });

  test("an auto-approved call is still an approval row that says a rule matched", async () => {
    const h = harness(["always"]);
    await h.ask("mcp_files_delete", { path: "build" });
    await h.ask("mcp_files_delete", { path: "build" });
    const [first, second] = rows();
    const rule = listApprovalRules(db)[0]!;
    expect(first).toMatchObject({ status: "decided", decision: "always", rule_id: null });
    expect(second).toMatchObject({ status: "decided", decision: "always", rule_id: rule.id, tool_name: "mcp_files_delete" });
    expect(second!.decided_at).toBeTruthy();
    expect(String(second!.action)).toContain("build");
    expect(String(second!.action)).toContain("standing rule");
    expect(String(second!.preview)).toContain(rule.id);
    expect(String(second!.preview)).toContain("Auto-approved");
  });

  test("once and reject never create a rule", async () => {
    const h = harness(["once", "reject", "once"]);
    await h.ask("mcp_files_delete", { path: "build" });
    await h.ask("mcp_files_delete", { path: "build" });
    await h.ask("mcp_files_delete", { path: "build" });
    expect(listApprovalRules(db)).toHaveLength(0);
    expect(h.frames).toHaveLength(3);
  });

  test("a cancelled wait (null) never creates a rule", async () => {
    const h = harness([]);
    expect(await h.ask("mcp_files_delete", { path: "build" })).toBeNull();
    expect(listApprovalRules(db)).toHaveLength(0);
  });

  test("a rule for one bot does not approve another bot", async () => {
    const a = harness(["always"], "ea");
    await a.ask("mcp_files_delete", { path: "build" });
    const b = harness(["reject"], "researcher");
    expect(await b.ask("mcp_files_delete", { path: "build" })).toBe("reject");
    expect(b.frames).toHaveLength(1);
  });

  test("a rule does not approve a different tool or a different target", async () => {
    const h = harness(["always", "reject", "reject", "reject"]);
    await h.ask("mcp_files_delete", { path: "build" });
    expect(await h.ask("mcp_files_delete", { path: "build2" })).toBe("reject");
    expect(await h.ask("mcp_files_delete", { path: "build; rm -rf /" })).toBe("reject");
    expect(await h.ask("some_other_tool", { path: "build" })).toBe("reject");
    expect(h.frames).toHaveLength(4);
  });

  test("a revoked rule asks again", async () => {
    const h = harness(["always", "once"]);
    await h.ask("mcp_files_delete", { path: "build" });
    revokeApprovalRule(db, listApprovalRules(db)[0]!.id);
    expect(await h.ask("mcp_files_delete", { path: "build" })).toBe("once");
    expect(h.frames).toHaveLength(2);
  });

  test("always on write_file inside scratch remembers the resolved path, not the content", async () => {
    const scratch = join(root, "scratch");
    writeFileSync(join(scratch, "notes.md"), "v0");
    writeFileSync(join(scratch, "other.md"), "v0");
    const h = harness(["always", "reject"]);
    await h.ask("write_file", { path: "notes.md", content: "v1" });
    // The same file by absolute path, with different content: the rule answers.
    expect(await h.ask("write_file", { path: join(scratch, "notes.md"), content: "v2 entirely different" })).toBe("always");
    expect(await h.ask("write_file", { path: "other.md", content: "v1" })).toBe("reject");
    expect(h.frames.map((f) => f.buttons.join())).toEqual(["once,always,reject", "once,always,reject"]);
  });

  test("a write outside scratch is never remembered: no 'always' button, nothing stored, asks every time", async () => {
    mkdirSync(join(root, "outside"), { recursive: true });
    const target = join(root, "outside", "startup.cmd");
    const h = harness(["always", "once", "reject"]);
    expect(await h.ask("write_file", { path: target, content: "v1" })).toBe("always");
    expect(listApprovalRules(db)).toHaveLength(0);
    expect(await h.ask("write_file", { path: target, content: "v2" })).toBe("once");
    expect(await h.ask("write_file", { path: "../outside/startup.cmd", content: "v3" })).toBe("reject");
    expect(h.frames).toHaveLength(3);
    expect(h.frames.every((f) => f.buttons.join() === "once,reject")).toBe(true);
  });

  test("a rule row for a path outside scratch is ignored at match time", async () => {
    mkdirSync(join(root, "outside"), { recursive: true });
    const target = join(root, "outside", "config.env");
    db.run("INSERT INTO approval_rules (id, agent_id, tool_name, target, created_at) VALUES ('rul_old', 'ea', 'write_file', ?, ?)", [
      process.platform === "win32" ? target.toLowerCase() : target, new Date().toISOString(),
    ]);
    const h = harness(["reject"]);
    expect(await h.ask("write_file", { path: target, content: "x" })).toBe("reject");
    expect(h.frames).toHaveLength(1);
  });

  test("rules that can never match are not listed as active (stored before shell and outside-scratch writes stopped being remembered)", () => {
    mkdirSync(join(root, "outside"), { recursive: true });
    const lower = (path: string): string => (process.platform === "win32" ? path.toLowerCase() : path);
    const insert = (id: string, tool: string, target: string): void => {
      db.run("INSERT INTO approval_rules (id, agent_id, tool_name, target, created_at) VALUES (?, 'ea', ?, ?, ?)", [id, tool, target, new Date().toISOString()]);
    };
    insert("rul_bash", "bash", "ls");
    insert("rul_priv", "run_privileged", "sudo ls");
    insert("rul_out", "write_file", lower(join(root, "outside", "startup.cmd")));
    insert("rul_in", "write_file", lower(join(root, "scratch", "notes.md")));
    insert("rul_mcp", "mcp_files_delete", '{"path":"/x"}');

    expect(listApprovalRules(db).map((rule) => rule.id).sort()).toEqual(["rul_in", "rul_mcp"]);
    // The full history (revoked rows are asked for) still has every row.
    expect(listApprovalRules(db, { includeRevoked: true })).toHaveLength(5);
  });

  test("always on a tool that is never remembered stores nothing", async () => {
    const h = harness(["always", "once"]);
    expect(await h.ask("run_privileged", { command: "sudo ls", purpose: "list" })).toBe("always");
    expect(listApprovalRules(db)).toHaveLength(0);
    expect(await h.ask("run_privileged", { command: "sudo ls", purpose: "list" })).toBe("once");
    expect(h.frames).toHaveLength(2);
  });

  test("a rule is read from the turn's bot, so a handoff turn does not borrow the thread owner's rules", async () => {
    // One thread owned by "ea"; a handoff child turn in it belongs to "researcher".
    const h = harness(["always", "reject"], "ea");
    await h.ask("mcp_files_delete", { path: "build" });
    const decision = await h.ask("mcp_files_delete", { path: "build" }, { threadID: h.thread.id, agentID: "researcher" });
    expect(decision).toBe("reject");
  });

  test("a card offers 'always' only when a rule could be stored: never for a shell command", async () => {
    const h = harness(["once", "once", "once", "once", "once", "once"]);
    await h.ask("mcp_files_delete", { path: "build" });
    await h.ask("bash", { command: "rm -rf build" });
    await h.ask("bash", { command: "ls -la", cwd: join(root, "elsewhere") });
    await h.ask("bash", { command: "python3 run.py" });
    await h.ask("run_privileged", { command: "sudo ls", purpose: "list" });
    await h.ask("write_file", { path: join(root, "outside", "x.md"), content: "x" });
    expect(h.frames.map((f) => f.buttons)).toEqual([
      ["once", "always", "reject"],
      ["once", "reject"],
      ["once", "reject"],
      ["once", "reject"],
      ["once", "reject"],
      ["once", "reject"], // a write outside scratch
    ]);
  });

  test("'always' on a bash command stores nothing, so the next call asks again", async () => {
    const h = harness(["always", "once"]);
    expect(await h.ask("bash", { command: "python3 run.py" })).toBe("always");
    expect(listApprovalRules(db)).toHaveLength(0);
    expect(await h.ask("bash", { command: "python3 run.py" })).toBe("once");
    expect(h.frames).toHaveLength(2);
  });

  test("a bash rule row already in the database is ignored at match time", async () => {
    // Rows written by an earlier build, or by hand: the broker never consults them for a shell command.
    for (const command of ["python3 ls.py", "python3 cat.py notes.txt", "rm -rf build"]) {
      db.run("INSERT INTO approval_rules (id, agent_id, tool_name, target, created_at) VALUES (?, 'ea', 'bash', ?, ?)", [`rul_old_${command}`, command, new Date().toISOString()]);
    }
    const h = harness(["reject", "reject", "reject"]);
    // A read-only command is free (no card, no rule); the rows for the others are never consulted.
    for (const command of ["python3 ls.py", "python3 cat.py notes.txt", "rm -rf build"]) {
      expect({ command, decision: await h.ask("bash", { command }) }).toEqual({ command, decision: "reject" });
    }
    expect(h.frames).toHaveLength(3);
    expect(h.frames.every((f) => f.buttons.join() === "once,reject")).toBe(true);
    expect(rows().every((r) => r.rule_id === null)).toBe(true);
  });

  test("an approval note from the integration appears in the preview, and only when there is one", async () => {
    const h = harness(["once", "once", "always", "once"], "ea", (tool) => (tool === "mcp_gh_delete" ? "Runs on the GitHub connector: deletes a repo." : undefined));
    await h.ask("mcp_gh_delete", { repo: "x" });
    await h.ask("bash", { command: "python3 x.py" });
    expect(h.frames[0]!.preview).toContain("Runs on the GitHub connector: deletes a repo.");
    expect(h.frames[1]!.preview).not.toContain("GitHub");
    // The auto-approved audit row keeps the note too.
    await h.ask("mcp_gh_delete", { repo: "y" });
    await h.ask("mcp_gh_delete", { repo: "y" });
    const last = rows().at(-1)!;
    expect(String(last.preview)).toContain("Runs on the GitHub connector");
    expect(String(last.preview)).toContain("Auto-approved");
  });

  test("the rule table exists after migration with the documented columns", () => {
    const cols = (db.query("PRAGMA table_info(approval_rules)").all() as Array<{ name: string }>).map((c) => c.name);
    for (const name of ["id", "agent_id", "tool_name", "target", "created_at", "revoked_at"]) expect(cols).toContain(name);
  });
});
