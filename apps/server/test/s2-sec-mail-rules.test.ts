/**
 * Sprint 2 security round, item 2: a pattern rule for mail matches the addresses the mail sender will
 * really use. The recipients are parsed with the sender's own parser (`mail/smtp.ts`), every address must
 * fit the pattern, a list that does not parse cleanly shows the card, and the rule names the account it
 * was made for.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { recipientResources } from "../src/policy/resources";
import { decide } from "../src/policy/engine";
import { addApprovalRule, approvalTarget, listApprovalRules, matchApprovalRule } from "../src/stores/approval-rules";
import { policyRig, type PolicyRig } from "./policy-fixture";

let db: Database;
let rig: PolicyRig | undefined;
beforeEach(() => { db = openDatabase(":memory:"); });
afterEach(() => { db.close(); rig?.close(); rig = undefined; });

const match = (args: Record<string, unknown>) =>
  // The resources are what the engine hands over: the matcher must not rely on them.
  matchApprovalRule(db, { agentID: "ea", toolName: "mail_send", args, resources: recipientResources(args) });

const send = (to: unknown, account?: string) => ({ ...(account ? { account } : {}), to, subject: "s", body: "b" });

describe("a mail pattern rule", () => {
  beforeEach(() => {
    addApprovalRule(db, { agentID: "ea", toolName: "mail_send", target: "", resourcePattern: "*@ok.com", account: "owner" });
  });

  test("allows a send whose every address the sender parses and the pattern fits", () => {
    expect(match(send(["a@ok.com", "B@OK.COM"], "owner"))).not.toBeNull();
  });

  const SPLIT_TRICKS: Array<[string, unknown]> = [
    ["a comma inside one entry", ["a@ok.com, evil@x.com"]],
    ["a quoted address with another in angle brackets", ['"a@ok.com" <evil@x.com>']],
    ["a semicolon inside one entry", ["a@ok.com;evil@x.com"]],
    ["a display name", ["Ann <a@ok.com>"]],
    ["a line break inside one entry", ["a@ok.com\nevil@x.com"]],
    ["a single string with two addresses", "a@ok.com, evil@x.com"],
    ["an entry that is not a string", ["a@ok.com", 7]],
    ["no recipients", []],
  ];
  for (const [name, to] of SPLIT_TRICKS) {
    test(`shows the card for ${name}`, () => {
      expect(match(send(to, "owner"))).toBeNull();
    });
  }

  test("does not apply to a different account", () => {
    expect(match(send(["a@ok.com"], "agent"))).toBeNull();
    expect(match(send(["a@ok.com"]))).toBeNull();
    expect(match(send(["a@ok.com"], "work"))).toBeNull();
  });

  test("the rule is listed with the account it was made for", () => {
    expect(listApprovalRules(db)[0]).toMatchObject({ toolName: "mail_send", resourcePattern: "*@ok.com", account: "owner" });
  });
});

describe("the account is part of a mail pattern rule", () => {
  test("a mail rule without an account is refused when it is made", () => {
    expect(() => addApprovalRule(db, { agentID: "ea", toolName: "mail_send", target: "", resourcePattern: "*@ok.com" })).toThrow(/account/);
  });

  test("the same pattern for two accounts is two rules", () => {
    const owner = addApprovalRule(db, { agentID: "ea", toolName: "mail_send", target: "", resourcePattern: "*@ok.com", account: "owner" })!;
    const agent = addApprovalRule(db, { agentID: "ea", toolName: "mail_send", target: "", resourcePattern: "*@ok.com", account: "agent" })!;
    expect(owner.id).not.toBe(agent.id);
    expect(match(send(["a@ok.com"], "agent"))?.id).toBe(agent.id);
    expect(match(send(["a@ok.com"], "owner"))?.id).toBe(owner.id);
  });

  test("a pattern rule written without an account (an older row) matches no mail", () => {
    db.run("INSERT INTO approval_rules (id, agent_id, tool_name, target, created_at, resource_pattern) VALUES ('rul_old', 'ea', 'mail_send', 'pattern:*@ok.com', ?, '*@ok.com')", [new Date().toISOString()]);
    expect(match(send(["a@ok.com"], "owner"))).toBeNull();
  });
});

describe("an exact mail rule is also tied to what the sender parses", () => {
  test("a recipient list the sender would refuse has no target, so no rule can be made or matched for it", () => {
    expect(approvalTarget("mail_send", send(["a@ok.com, evil@x.com"], "owner"))).toBeNull();
    expect(approvalTarget("mail_send", send(["a@ok.com"], "work"))).toBeNull();
    expect(approvalTarget("mail_send", send(["a@ok.com"], "owner"))).not.toBeNull();
  });
});

describe("through the engine", () => {
  test("an owner-account send to an address outside the pattern, split into one entry, still gets a card", () => {
    rig = policyRig();
    addApprovalRule(rig.db, { agentID: rig.run.bot, toolName: "mail_send", target: "", resourcePattern: "*@ok.com", account: "owner" });
    const call = (args: Record<string, unknown>) => decide(rig!.run, { tool: "mail_send", args, callID: "c" });
    expect(call(send(["a@ok.com"], "owner"))).toMatchObject({ action: "run", via: "rule" });
    expect(call(send(["a@ok.com, evil@x.com"], "owner")).action).toBe("ask");
    expect(call(send(['"a@ok.com" <evil@x.com>'], "owner")).action).toBe("ask");
    expect(call(send(["a@ok.com;evil@x.com"], "owner")).action).toBe("ask");
  });
});
