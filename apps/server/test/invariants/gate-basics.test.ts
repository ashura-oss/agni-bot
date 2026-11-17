/**
 * INV-07 and INV-13: arguments are checked before anything else, and approval
 * cards mean what they say (S2-02, S2-08; track-c C5.4 items 7 and 13, S3 tests).
 *
 *   - A call whose arguments break the tool's schema never reaches a handler
 *     and never raises a card.
 *   - An approval nobody answers in time is a denial.
 *   - A long command's card shows all of it (nothing is cut); one too long for a card is refused, with no card.
 *   - "Always allow" is never offered for shell.
 */
import { existsSync } from "node:fs";
import { describe, expect } from "bun:test";
import { enqueueJob } from "../../src/stores/jobs";
import { scenarioTest, useScenarios, say } from "../scenarios/harness";
import { call, playTurn, resultJson, scripted } from "./support";

const scenarios = useScenarios();
const shell = (path: string): string => path.replaceAll("\\", "/");

describe("INV-07 arguments that break the schema never reach a handler and never raise a card", () => {
  scenarioTest("write_file without content, mail_send without a subject, bash without a command, job_schedule without text, create_agent without a prompt", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    const away = s.outside("never.txt");
    s.model.queue(...scripted(true, [
      call("write_file", { path: away }, "call_no_content"),
      call("mail_send", { account: "owner", to: ["friend@example.org"], body: "hello" }, "call_no_subject"),
      call("bash", {}, "call_no_command"),
      call("job_schedule", { at: new Date(Date.now() + 86_400_000).toISOString() }, "call_no_text"),
      call("create_agent", { name: "Incomplete", id: "incomplete" }, "call_no_prompt"),
      say("Done."),
    ]));
    const report = await playTurn(s, a, "do five things badly", { answer: () => "once" });

    const field: Record<string, string> = {
      call_no_content: "content",
      call_no_subject: "subject",
      call_no_command: "command",
      call_no_text: "text",
      call_no_prompt: "prompt",
    };
    const problems: string[] = [];
    for (const [id, name] of Object.entries(field)) {
      const record = report.calls.find((entry) => entry.callID === id)!;
      if (record.card) problems.push(`${id}: a card was raised for a call that cannot run`);
      const error = String(resultJson(record).error ?? "");
      if (!error) problems.push(`${id}: no error came back`);
      else if (!error.includes(name)) problems.push(`${id}: the error does not name "${name}": ${error.slice(0, 80)}`);
    }
    if (existsSync(away)) problems.push("write_file wrote a file from a call with no content");
    if (s.get("SELECT id FROM jobs WHERE kind = 'turn' AND payload LIKE '%\"text\":\"\"%'")) problems.push("a job was scheduled with no text");
    if (s.get("SELECT id FROM agents WHERE id = 'incomplete'")) problems.push("an agent was created with no prompt");
    expect(problems).toEqual([]);
  });

  scenarioTest("a mailbox name that is not exactly \"agent\" or \"owner\" is refused, not read as the free one (bug.md H6)", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    s.model.queue(...scripted(true, [
      call("mail_send", { account: "Owner", to: ["friend@example.org"], subject: "hi", body: "hello" }, "call_cased"),
      call("mail_send", { account: "agni", to: ["friend@example.org"], subject: "hi", body: "hello" }, "call_other"),
      say("Done."),
    ]));
    const report = await playTurn(s, a, "send two mails", { answer: () => "once" });
    for (const id of ["call_cased", "call_other"]) {
      const record = report.calls.find((entry) => entry.callID === id)!;
      expect(Object.hasOwn(resultJson(record), "error"), `${id}: an unknown mailbox name was accepted`).toBe(true);
      expect(/sent|not connected/i.test(String(resultJson(record).error ?? "")) && !/exactly/.test(String(resultJson(record).error)), `${id}: reached the mail handler as a real account`).toBe(false);
    }
  });
});

describe("INV-13 an approval nobody answers is a denial", () => {
  scenarioTest("a background job's card that expires leaves the action undone and closes the card as expired", async () => {
    const s = await scenarios.start({ ownerWaitMs: 400 });
    const a = await s.connect({ label: "A" });
    const away = s.outside("expired.txt");
    s.model.queue(...scripted(true, [call("write_file", { path: away, content: "x" }, "call_expiring"), say("Done.")]));
    enqueueJob(s.db, { kind: "turn", payload: { text: "save the file outside scratch", agentID: "ea", notify: false } });

    await s.runner().tick();
    const card = await a.waitFor("approval.request", { why: "the card the job raised" });
    const closed = await a.waitFor("approval.closed", { match: (frame) => frame.requestID === card.requestID, timeoutMs: 2_000, why: "the card to close" });
    expect(closed.reason, "an unanswered card did not close as expired").toBe("expired");
    expect(existsSync(away), "the action ran although nobody approved it").toBe(false);
  });
});

describe("INV-13 a long command's card shows all of it, and one too long to show raises no card", () => {
  const LONG = `echo ${"a".repeat(4_960)} ; touch `;

  scenarioTest("the last 2,000 characters of a 5,000-character shell command are on the card", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    const marker = shell(s.outside("tail-marker"));
    const command = `${LONG}${marker}`;
    expect(command.length).toBeGreaterThan(4_990);
    s.model.queue(...scripted(true, [call("bash", { command }, "call_long"), say("Done.")]));
    const report = await playTurn(s, a, "run the long command");
    const card = report.cards[0];
    expect(card, "the long command raised no card").toBeDefined();
    expect(card!.preview, "the card hid the end of the command").toContain(command.slice(-2_000));
    expect(existsSync(s.outside("tail-marker")), "the command ran without approval").toBe(false);
  });

  // Fix round I: a card shows the whole of what will run, so no card is cut; a command too long for a card is refused, with no card, and does not run.
  // Two turns, not one: a refused command is a denial for the rest of its run (INV-07), and the second command would share it.
  scenarioTest("a card is never cut (`truncated` is false), and a command too long to show whole raises no card and does not run", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    const marker = shell(s.outside("cut-marker"));
    s.model.queue(...scripted(true, [call("bash", { command: `${LONG}${marker}` }, "call_long"), say("Done.")]));
    const long = await playTurn(s, a, "run the long command");
    s.model.queue(...scripted(true, [call("bash", { command: `touch ${shell(s.outside("whole-marker"))}` }, "call_whole"), say("Done.")]));
    const whole = await playTurn(s, a, "run the short command");
    expect(long.cards.length).toBe(1);
    expect(whole.cards.length).toBe(1);
    // The whole command, in the quoted form the card shows model-written text in (a single line here): not its last few thousand characters.
    expect(long.cards[0]!.preview, "a long card hid part of the command").toContain(`> ${LONG}${marker}`);
    expect(long.cards[0]!.raw.truncated ?? false, "a card that shows everything said it was cut").toBe(false);
    expect(whole.cards[0]!.raw.truncated ?? false, "a whole card claimed to be cut").toBe(false);

    const huge = shell(s.outside("huge-marker"));
    s.model.queue(...scripted(true, [call("bash", { command: `echo ${"a".repeat(25_000)} ; touch ${huge}` }, "call_huge"), say("Done.")]));
    const refused = await playTurn(s, a, "run the huge command");
    expect(refused.cards, "a card was raised for a command too long to show whole").toEqual([]);
    expect(existsSync(s.outside("huge-marker")), "a command the owner could not read in full ran").toBe(false);
    const record = refused.calls.find((entry) => entry.callID === "call_huge");
    expect(String(resultJson(record).error ?? "(no error)"), "the model was not told why").toMatch(/too long/i);
  });

  scenarioTest("a tier and an expiry ride on every card (`tier`, `expiresAt`)", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    s.model.queue(...scripted(true, [call("bash", { command: `touch ${shell(s.outside("meta-marker"))}` }, "call_meta"), say("Done.")]));
    const report = await playTurn(s, a, "run a command");
    const raw = report.cards[0]!.raw;
    expect(raw.tier, "the card carries no tier").toBe(3);
    expect(typeof raw.expiresAt, "the card carries no expiry").toBe("string");
    expect(Number.isNaN(Date.parse(String(raw.expiresAt))), "the expiry is not a time").toBe(false);
  });
});

describe("INV-13 \"always allow\" is not offered where it must not be remembered", () => {
  scenarioTest("a shell command's card offers once and reject only", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    s.model.queue(...scripted(true, [call("bash", { command: `touch ${shell(s.outside("never-remembered"))}` }, "call_sh"), say("Done.")]));
    const report = await playTurn(s, a, "touch a file");
    expect(report.cards[0]!.buttons).toEqual(["once", "reject"]);
  });
});
