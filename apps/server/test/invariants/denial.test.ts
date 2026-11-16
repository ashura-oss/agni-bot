/**
 * INV-07: a denial covers the thing, not just the tool (S2-07; exit test 2).
 *
 *   If the owner refuses a delete, the bot cannot reach the same file another
 *   way in that run: overwrite, append, move, copy or shell. The owner's
 *   later reflexive "Allow" is not the defence; the run already knows the
 *   answer. A different file stays usable, the denial follows the work into
 *   delegation and handoff, and the next run asks afresh.
 *
 * `REFUSALS_BEFORE_STOP` (policy/denials.ts) is three: a bot that keeps going
 * after being told no is stopped. Each route is therefore tried in a run of
 * its own, and the stop has a test of its own.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect } from "bun:test";
import { scenarioTest, useScenarios, say, type Scenario } from "../scenarios/harness";
import { answerCards, allCallsTo, call, playTurn, resultJson, scripted, type CallRecord, type ModelStep } from "./support";

const scenarios = useScenarios();

const shell = (path: string): string => path.replaceAll("\\", "/");

interface Files { target: string; other: string; fresh: string }

/** A scratch folder with the file the owner will refuse to lose, and one beside it. */
function setUp(s: Scenario): Files {
  mkdirSync(s.scratch, { recursive: true });
  const files = { target: join(s.scratch, "ledger.txt"), other: join(s.scratch, "other.txt"), fresh: join(s.scratch, "fresh.txt") };
  writeFileSync(files.target, "original ledger");
  writeFileSync(files.other, "other file");
  return files;
}

const refusedWithoutACard = (record: CallRecord | undefined): boolean =>
  record !== undefined && record.card === null && Object.hasOwn(resultJson(record), "error");

/** The owner refuses the delete and, tired, allows anything else that asks: an "Allow" must not undo the refusal. */
const refuseTheDeleteOnly = { answer: (card: { action: string }) => (card.action.includes("rm ") ? ("reject" as const) : ("once" as const)) };

/**
 * Other ways to reach the file the owner would not let the bot delete. A shell route the server cannot prove to be one
 * allowlisted command on plain files (`unproven`) is not read for file names: it is put to the owner with the refusal
 * named (policy/shell-proof.ts), and the owner says no. Every other route is refused with no card.
 */
const ROUTES: Array<{ id: string; unproven?: true; step: (f: Files, s: Scenario) => ModelStep }> = [
  { id: "overwrite with write_file", step: (f) => call("write_file", { path: f.target, content: "overwritten" }, "call_route") },
  { id: "append with write_file", step: (f) => call("write_file", { path: f.target, content: " appended", append: true }, "call_route") },
  { id: "the same file by a relative name", step: () => call("write_file", { path: "ledger.txt", content: "overwritten" }, "call_route") },
  { id: "the same file by a path that goes round it", step: (_f, s) => call("write_file", { path: join(s.scratch, "sub", "..", "ledger.txt"), content: "overwritten" }, "call_route") },
  { id: "move it with the shell", step: (f, s) => call("bash", { command: `mv ${shell(f.target)} ${shell(join(s.scratch, "moved.txt"))}` }, "call_route") },
  { id: "copy another file over it with the shell", step: (f) => call("bash", { command: `cp ${shell(f.other)} ${shell(f.target)}` }, "call_route") },
  { id: "redirect shell output into it", unproven: true, step: (f) => call("bash", { command: `echo hijacked > ${shell(f.target)}` }, "call_route") },
  { id: "edit it in place with sed", unproven: true, step: (f) => call("bash", { command: `sed -i s/original/hijacked/ ${shell(f.target)}` }, "call_route") },
];

describe("INV-07 a denied delete holds across tools for the rest of the run", () => {
  for (const route of ROUTES) {
    scenarioTest(`after the owner refuses rm, this route to the same file ${route.unproven ? "never runs on its own" : "is refused with no new card"}: ${route.id}`, async () => {
      const s = await scenarios.start();
      const files = setUp(s);
      s.model.queue(...scripted(true, [
        call("bash", { command: `rm ${shell(files.target)}` }, "call_rm"),
        route.step(files, s),
        call("write_file", { path: files.fresh, content: "a different file" }, "call_fresh"),
        say("Done."),
      ]));
      const a = await s.connect({ label: "A" });
      const report = await playTurn(s, a, "clean up the old ledger", route.unproven ? { answer: () => "reject" as const } : refuseTheDeleteOnly);

      const record = report.calls.find((entry) => entry.callID === "call_route");
      expect(record, "the bot never tried the route; the script is out of step").toBeDefined();
      if (route.unproven) {
        // Both a card and a refusal keep it from running on its own; the card must name what the owner refused.
        expect(record!.card !== null || refusedWithoutACard(record), `${route.id} ran with no card and no refusal: ${record!.result.slice(0, 100)}`).toBe(true);
        if (record!.card) expect(record!.card.preview).toContain("You said no to deleting");
      } else {
        expect(record!.card, `${route.id} raised a card for a file the owner already refused`).toBeNull();
        expect(refusedWithoutACard(record), `${route.id} came back without an error: ${record!.result.slice(0, 100)}`).toBe(true);
      }
      expect(readFileSync(files.target, "utf8"), "the refused file changed").toBe("original ledger");
      expect(existsSync(join(s.scratch, "moved.txt")), "the refused file was moved").toBe(false);
      expect(existsSync(files.fresh), "a different file was blocked too (a denial must not over-reach)").toBe(true);
    });
  }

  scenarioTest("a bot that keeps trying after the owner said no is stopped, and the calls queued behind never run", async () => {
    const s = await scenarios.start();
    const files = setUp(s);
    s.model.queue(...scripted(true, [
      call("bash", { command: `rm ${shell(files.target)}` }, "call_rm"),
      call("write_file", { path: files.target, content: "one" }, "call_try_1"),
      call("write_file", { path: files.target, content: "two" }, "call_try_2"),
      call("bash", { command: `mv ${shell(files.target)} ${shell(join(s.scratch, "moved.txt"))}` }, "call_try_3"),
      call("write_file", { path: files.fresh, content: "after the stop" }, "call_after_stop"),
      say("Finished."),
    ]));
    const a = await s.connect({ label: "A" });
    const report = await playTurn(s, a, "clean up the old ledger", refuseTheDeleteOnly);

    expect(report.calls.some((entry) => entry.callID === "call_after_stop"), "the run went on to a call queued after the third refusal").toBe(false);
    expect(existsSync(files.fresh)).toBe(false);
    expect(readFileSync(files.target, "utf8")).toBe("original ledger");
    expect(report.stopReason, "a run that ignored the owner's no ended as an ordinary success").not.toBe("end");
    const told = s.all<{ text: string }>("SELECT text FROM channel_messages WHERE from_type = 'agent' ORDER BY created_at").map((row) => row.text).join("\n");
    expect(told, "the owner was not told the run was stopped").toMatch(/stopped/i);
  });

  scenarioTest("the denial ends with the run: the next turn asks about the same file again", async () => {
    const s = await scenarios.start();
    const files = setUp(s);
    const a = await s.connect({ label: "A" });

    s.model.queue(...scripted(true, [call("bash", { command: `rm ${shell(files.target)}` }, "call_rm_1"), say("Not deleted.")]));
    const first = await playTurn(s, a, "delete the old ledger");
    expect(first.cards.length, "the delete should have asked").toBe(1);

    s.model.queue(...scripted(true, [call("write_file", { path: files.target, content: "replacement" }, "call_overwrite_2"), say("Saved.")]));
    const second = await playTurn(s, a, "actually, replace the ledger with a new one", { answer: () => "once" });
    expect(second.cards.length, "the next run was refused without asking; a denial must not outlive its run").toBe(1);
    expect(readFileSync(files.target, "utf8")).toBe("replacement");
  });
});

describe("INV-07 the denial follows the work to the bots the run hands it to", () => {
  scenarioTest("handoff: the bot that is handed the job cannot overwrite the file its caller was refused", async () => {
    const s = await scenarios.start();
    const files = setUp(s);
    s.model.queue(...scripted(true, [
      call("bash", { command: `rm ${shell(files.target)}` }, "call_rm"),
      call("handoff", { toAgentID: "coder", task: "Replace the contents of the ledger file with a fresh one." }, "call_handoff"),
      // the coder's turn, inside the handoff call
      call("write_file", { path: files.target, content: "overwritten by the coder" }, "call_child_overwrite"),
      say("Tried."),
      // back in the assistant's turn
      say("The coder could not do it."),
    ]));
    const a = await s.connect({ label: "A" });
    await playTurn(s, a, "clean up the old ledger", refuseTheDeleteOnly);

    const record = allCallsTo(s, "write_file", a).find((entry) => entry.callID === "call_child_overwrite");
    expect(record, "the coder never tried the write; the script is out of step").toBeDefined();
    expect(refusedWithoutACard(record), "the handed-off bot got a card or a success for a file its caller was refused").toBe(true);
    expect(readFileSync(files.target, "utf8")).toBe("original ledger");
  });

  scenarioTest("delegation: a background worker cannot overwrite the file the delegating run was refused", async () => {
    const s = await scenarios.start();
    const files = setUp(s);
    const a = await s.connect({ label: "A" });
    s.model.queue(...scripted(true, [
      call("bash", { command: `rm ${shell(files.target)}` }, "call_rm"),
      call("delegate_task", { toAgentID: "coder", goal: "Replace the contents of the ledger file with a fresh one." }, "call_delegate"),
      say("The coder is on it."),
    ]));
    await playTurn(s, a, "clean up the old ledger", refuseTheDeleteOnly);

    // The worker runs later, as a job, with nobody to ask: any card is answered "Allow".
    const owner = answerCards(a, "once");
    s.model.queue(call("write_file", { path: files.target, content: "overwritten by the worker" }, "call_worker_overwrite"), say("Tried."), say("Noted."));
    const tried = (): boolean => allCallsTo(s, "write_file", a).some((entry) => entry.callID === "call_worker_overwrite");
    for (let tick = 0; tick < 6 && !tried(); tick += 1) await s.runner().tick();
    await s.runner().tick();
    owner.stop();

    const record = allCallsTo(s, "write_file", a).find((entry) => entry.callID === "call_worker_overwrite");
    expect(record, "the worker never tried the write; the script is out of step").toBeDefined();
    expect(owner.cards, "the worker raised a card about a file the delegating run was refused").toEqual([]);
    expect(refusedWithoutACard(record), "a worker got a success for a file the delegating run was refused").toBe(true);
    expect(readFileSync(files.target, "utf8")).toBe("original ledger");
  });
});

describe("INV-07 a denial covers the file, not the words of the command that named it", () => {
  // Once a refusal recorded the words of the line (including the `touch` after the `;`) and then refused every later
  // command that contained one. A line the server cannot prove names no file, so a refusal of it records none.
  scenarioTest("refusing `echo start ; touch a.txt` does not refuse a command on a different file", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    s.model.queue(...scripted(true, [
      call("bash", { command: `echo start ; touch ${shell(s.outside("a.txt"))}` }, "call_first"),
      call("bash", { command: `touch ${shell(s.outside("b.txt"))}` }, "call_second"),
      say("Done."),
    ]));
    const report = await playTurn(s, a, "make two files");
    const second = report.calls.find((entry) => entry.callID === "call_second");
    // The owner said no to a.txt. b.txt is another file, so the owner is asked about it too.
    expect(second?.card, `a command on a different file was refused with no card: ${second?.result.slice(0, 160)}`).not.toBeNull();
  });
});
