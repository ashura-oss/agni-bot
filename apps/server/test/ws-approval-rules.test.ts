import { afterEach, describe, expect, test } from "bun:test";
import { addApprovalRule, listApprovalRules, type ApprovalRule } from "../src/stores/approval-rules";
import { startHarness, type Harness } from "./ws-harness";

/** W2-A item 2: the owner can list and revoke "Always allow" rules over the socket. */

let harness: Harness | undefined;

/** Shell commands are never remembered, so these tests use an MCP tool, which can be. */
const TOOL = "mcp_files_delete";

function addRule(db: Harness["db"], agentID: string, target: string): ApprovalRule {
  const added = addApprovalRule(db, { agentID, toolName: TOOL, target });
  if (!added) throw new Error("expected a rule to be remembered");
  return added;
}

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

describe("approval rules over the socket", () => {
  test("lists active rules newest first, with the bot's display name or null when the bot is gone", async () => {
    harness = await startHarness();
    const first = addRule(harness.db, "ea", "ls");
    const second = addRule(harness.db, "ghost", "c:/x/y.txt");
    const client = await harness.connect();

    client.send({ type: "approval.rules.list" });
    const answer = await client.next("approval.rules.list.ok");

    expect(answer.rules.map((rule) => rule.id).sort()).toEqual([first.id, second.id].sort());
    const known = answer.rules.find((rule) => rule.id === first.id)!;
    expect(known).toEqual({ id: first.id, agentID: "ea", agentName: expect.any(String), toolName: TOOL, target: "ls", createdAt: first.createdAt });
    expect(known.agentName).not.toBe("");
    expect(answer.rules.find((rule) => rule.id === second.id)).toMatchObject({ agentID: "ghost", agentName: null });
  });

  test("the list leaves out revoked rules and goes only to the asker", async () => {
    harness = await startHarness();
    const live = addRule(harness.db, "ea", "ls");
    const gone = addRule(harness.db, "ea", "pwd");
    harness.db.run("UPDATE approval_rules SET revoked_at = ? WHERE id = ?", [new Date().toISOString(), gone.id]);
    const asker = await harness.connect({ device: "phone" });
    const other = await harness.connect({ device: "laptop" });

    asker.send({ type: "approval.rules.list" });
    const answer = await asker.next("approval.rules.list.ok");
    expect(answer.rules.map((rule) => rule.id)).toEqual([live.id]);
    await Bun.sleep(100);
    expect(other.seen().filter((frame) => frame.type === "approval.rules.list.ok")).toEqual([]);
  });

  test("revoking a rule answers ok and the rule stops being listed or matched", async () => {
    harness = await startHarness();
    const created = addRule(harness.db, "ea", "ls");
    const client = await harness.connect();

    client.send({ type: "approval.rule.revoke", id: created.id });
    expect(await client.next("approval.rule.revoke.ok")).toMatchObject({ id: created.id });
    expect(listApprovalRules(harness.db)).toEqual([]);

    client.send({ type: "approval.rules.list" });
    expect((await client.next("approval.rules.list.ok")).rules).toEqual([]);
  });

  test("an unknown or already revoked id is a not_found error to the asker", async () => {
    harness = await startHarness();
    const created = addRule(harness.db, "ea", "ls");
    const client = await harness.connect();

    client.send({ type: "approval.rule.revoke", id: "rul_nope" });
    expect(await client.next("error")).toMatchObject({ code: "not_found" });

    client.send({ type: "approval.rule.revoke", id: created.id });
    await client.next("approval.rule.revoke.ok");
    client.send({ type: "approval.rule.revoke", id: created.id });
    expect(await client.next("error")).toMatchObject({ code: "not_found" });
  });
});
