/**
 * INV-07, the wake turn: a refusal made while a task was being set up or done still holds in the
 * turn that tells the parent bot the task is finished.
 *
 * The wake is a turn of its own, started by a job. It belongs to the same request as the parent's
 * turn and the child's, so what the owner refused there is refused here too. Once the wake had no
 * root of its own named, it counted as a fresh run and a refused file could be written in it.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect } from "bun:test";
import { scenarioTest, useScenarios, say, type Scenario } from "../scenarios/harness";
import { answerCards, allCallsTo, call, playTurn, resultJson, scripted } from "./support";

const scenarios = useScenarios();

const shell = (path: string): string => path.replaceAll("\\", "/");

function setUp(s: Scenario): string {
  mkdirSync(s.scratch, { recursive: true });
  const target = join(s.scratch, "ledger.txt");
  writeFileSync(target, "original ledger");
  return target;
}

describe("INV-07 a denial holds in the wake turn", () => {
  scenarioTest("the parent was refused, the child finished, and the wake may not overwrite the same file", async () => {
    const s = await scenarios.start();
    const target = setUp(s);
    const a = await s.connect({ label: "A" });
    s.model.queue(...scripted(true, [
      call("bash", { command: `rm ${shell(target)}` }, "call_rm"),
      call("delegate_task", { toAgentID: "researcher", goal: "Count the pallets in the east warehouse." }, "call_delegate"),
      say("The researcher is counting."),
    ]));
    await playTurn(s, a, "clean up the old ledger", { answer: (card) => (card.action.includes("rm ") ? "reject" : "once") });

    // The child answers; then the parent's wake turn tries to write the file the owner refused to lose.
    const owner = answerCards(a, "once");
    s.model.queue(say("There are 42 pallets."), ...scripted(true, [call("write_file", { path: target, content: "overwritten by the wake" }, "call_wake_write"), say("Tried."), say("Noted.")]));
    const tried = (): boolean => allCallsTo(s, "write_file", a).some((entry) => entry.callID === "call_wake_write");
    for (let tick = 0; tick < 6 && !tried(); tick += 1) await s.runner().tick();
    await s.runner().tick();
    owner.stop();

    const record = allCallsTo(s, "write_file", a).find((entry) => entry.callID === "call_wake_write");
    expect(record, "the wake turn never tried the write; the script is out of step").toBeDefined();
    expect(owner.cards, "the wake turn raised a card about a file its own request was refused").toEqual([]);
    expect(String(resultJson(record).error ?? "(no error)"), "the wake turn was stopped by something other than the refusal").toMatch(/refus|said no|not allowed|denied/i);
    expect(readFileSync(target, "utf8")).toBe("original ledger");
  });

  scenarioTest("the child was refused, and the wake may not repeat it", async () => {
    const s = await scenarios.start();
    const target = setUp(s);
    const a = await s.connect({ label: "A" });
    s.model.queue(call("delegate_task", { toAgentID: "coder", goal: "Tidy up the ledger file." }, "call_delegate"), say("The coder is on it."));
    await playTurn(s, a, "tidy the ledger");

    // The child is refused (the owner says no), finishes its report; the wake then tries the same thing.
    const owner = answerCards(a, (card) => (card.action.includes("rm ") ? "reject" : "once"));
    s.model.queue(
      ...scripted(true, [call("bash", { command: `rm ${shell(target)}` }, "call_child_rm"), say("The owner would not let me delete it.")]),
      ...scripted(true, [call("bash", { command: `rm ${shell(target)}` }, "call_wake_rm"), say("Tried."), say("Noted.")]),
    );
    const tried = (): boolean => allCallsTo(s, "bash", a).some((entry) => entry.callID === "call_wake_rm");
    for (let tick = 0; tick < 6 && !tried(); tick += 1) await s.runner().tick();
    await s.runner().tick();
    owner.stop();

    const record = allCallsTo(s, "bash", a).find((entry) => entry.callID === "call_wake_rm");
    expect(record, "the wake turn never tried the delete; the script is out of step").toBeDefined();
    expect(record!.card, "the wake turn asked the owner again about a delete its request was refused").toBeNull();
    expect(String(resultJson(record).error ?? "(no error)"), "the wake turn was stopped by something other than the refusal").toMatch(/refus|said no|not allowed|denied/i);
    expect(readFileSync(target, "utf8")).toBe("original ledger");
  });
});
