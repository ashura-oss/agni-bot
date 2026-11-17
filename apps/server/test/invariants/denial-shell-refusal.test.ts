/**
 * INV-07 (a refused shell command): when the owner says no to a shell command the server could not prove
 * (policy/shell-proof.ts), the run holds a run-wide "shell" refusal. The server does not know what that command
 * would have touched, so for the rest of the run, for every bot the run hands work to:
 *
 *   - every shell call asks with a card that names the refusal (never runs on its own, never offers "Always allow");
 *   - every file write asks the same way, whatever the file;
 *   - no stored "always allow" rule approves any of them.
 *
 * The refusal ends with the run: the next turn is asked afresh. A refused PROVEN command names its files and
 * is covered by those file refusals instead; it does not make the run-wide one.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect } from "bun:test";
import { scenarioTest, useScenarios, say, type Scenario } from "../scenarios/harness";
import { answerCards, allCallsTo, call, playTurn, scripted, type Answer, type CallRecord } from "./support";

const scenarios = useScenarios();

const shell = (path: string): string => path.replaceAll("\\", "/");
const UNPROVEN = "make -C sub";
/** The sentence the card leads with once the run holds a refused shell command. */
const NAMED = "You said no to running a command";

interface Files { denied: string; other: string; fresh: string }

function setUp(s: Scenario): Files {
  mkdirSync(join(s.scratch, "sub"), { recursive: true });
  const files = { denied: join(s.scratch, "denied.txt"), other: join(s.scratch, "other.txt"), fresh: join(s.scratch, "fresh.txt") };
  writeFileSync(files.denied, "denied original");
  writeFileSync(files.other, "other original");
  return files;
}

/** The owner refuses the unproven command and every card after it: nothing that ran got past a click. */
const refuseEverything = { answer: (): Answer => "reject" };

/** Refuse the unproven command, then try `step`. Returns the record of the second call. */
async function afterRefusingTheCommand(s: Scenario, step: ReturnType<typeof call>): Promise<CallRecord> {
  s.model.queue(...scripted(true, [call("bash", { command: UNPROVEN }, "call_make"), step, say("Done.")]));
  const a = await s.connect({ label: "A" });
  const report = await playTurn(s, a, "build it", refuseEverything);
  const record = report.calls.find((entry) => entry.callID === "call_route");
  expect(record, "the bot never tried the route; the script is out of step").toBeDefined();
  return record!;
}

function expectAskedAndNamed(record: CallRecord, route: string): void {
  expect(record.card && record.card.preview !== "", `${route} ran with no card (or on a stored rule) after the owner refused a shell command`).toBeTruthy();
  expect(record.card!.preview, `${route}: the card does not name the refusal: ${record.card!.preview.slice(0, 300)}`).toContain(NAMED);
  expect(record.card!.buttons, `${route}: the card offered "Always allow" in a run that holds a refusal`).not.toContain("always");
}

describe("INV-07 after the owner refuses a shell command, later shell calls in the run ask", () => {
  scenarioTest("a read that is free in a clean run asks: cat", async () => {
    const s = await scenarios.start();
    setUp(s);
    const record = await afterRefusingTheCommand(s, call("bash", { command: "cat other.txt" }, "call_route"));
    expectAskedAndNamed(record, "cat");
  });

  scenarioTest("a delete of a file nobody refused asks, naming the refusal: rm", async () => {
    const s = await scenarios.start();
    const files = setUp(s);
    const record = await afterRefusingTheCommand(s, call("bash", { command: `rm ${shell(files.denied)}` }, "call_route"));
    expectAskedAndNamed(record, "rm");
    expect(readFileSync(files.denied, "utf8")).toBe("denied original");
  });

  scenarioTest("a move asks, naming the refusal: mv", async () => {
    const s = await scenarios.start();
    const files = setUp(s);
    const record = await afterRefusingTheCommand(s, call("bash", { command: `mv ${shell(files.denied)} ${shell(files.fresh)}` }, "call_route"));
    expectAskedAndNamed(record, "mv");
    expect(existsSync(files.denied)).toBe(true);
    expect(existsSync(files.fresh)).toBe(false);
  });

  scenarioTest("run_privileged asks too", async () => {
    const s = await scenarios.start();
    setUp(s);
    s.model.queue(...scripted(true, [
      call("bash", { command: UNPROVEN }, "call_make"),
      call("run_privileged", { command: "cat other.txt", purpose: "look" }, "call_route"),
      say("Done."),
    ]));
    const a = await s.connect({ label: "A" });
    const report = await playTurn(s, a, "build it", refuseEverything);
    expectAskedAndNamed(report.calls.find((entry) => entry.callID === "call_route")!, "run_privileged");
  });
});

describe("INV-07 after the owner refuses a shell command, every file write in the run asks", () => {
  scenarioTest("a new file in scratch, free in a clean run, asks", async () => {
    const s = await scenarios.start();
    const files = setUp(s);
    const record = await afterRefusingTheCommand(s, call("write_file", { path: files.fresh, content: "new" }, "call_route"));
    expectAskedAndNamed(record, "write_file (new file)");
    expect(existsSync(files.fresh)).toBe(false);
  });

  scenarioTest("an overwrite asks without \"Always allow\"", async () => {
    const s = await scenarios.start();
    const files = setUp(s);
    const record = await afterRefusingTheCommand(s, call("write_file", { path: files.other, content: "overwritten" }, "call_route"));
    expectAskedAndNamed(record, "write_file (overwrite)");
    expect(readFileSync(files.other, "utf8")).toBe("other original");
  });

  scenarioTest("a stored \"always allow\" rule does not approve the write after the refusal", async () => {
    const s = await scenarios.start();
    const files = setUp(s);
    const a = await s.connect({ label: "A" });

    // Turn 1 (clean): the owner says "always" to an overwrite of other.txt, which stores a rule.
    s.model.queue(...scripted(true, [call("write_file", { path: files.other, content: "version 1" }, "call_write_1"), say("Saved.")]));
    const first = await playTurn(s, a, "update it", { answer: () => "always" });
    expect(first.cards[0]?.buttons, "the baseline cannot store a rule").toContain("always");
    // Turn 2 (clean): the rule covers the same write, so there is no card.
    s.model.queue(...scripted(true, [call("write_file", { path: files.other, content: "version 2" }, "call_write_2"), say("Saved.")]));
    const second = await playTurn(s, a, "update it again");
    expect(second.cards.length, "the baseline rule did not cover the same write in a clean run").toBe(0);

    // Turn 3: the owner refuses an unproven command, then the same write comes up again.
    s.model.queue(...scripted(true, [
      call("bash", { command: UNPROVEN }, "call_make"),
      call("write_file", { path: files.other, content: "version 3" }, "call_route"),
      say("Done."),
    ]));
    const third = await playTurn(s, a, "build it, then update it again", refuseEverything);
    const record = third.calls.find((entry) => entry.callID === "call_route");
    expect(record, "the third turn never tried the write; the script is out of step").toBeDefined();
    expectAskedAndNamed(record!, "write_file under a stored rule");
    expect(readFileSync(files.other, "utf8")).toBe("version 2");
  });
});

describe("INV-07 the refusal of a shell command follows the work and ends with the run", () => {
  scenarioTest("handoff: the bot that is handed the job is asked before it writes a file", async () => {
    const s = await scenarios.start();
    const files = setUp(s);
    s.model.queue(...scripted(true, [
      call("bash", { command: UNPROVEN }, "call_make"),
      call("handoff", { toAgentID: "coder", task: "Write a notes file for me." }, "call_handoff"),
      // the coder's turn, inside the handoff call
      call("write_file", { path: files.fresh, content: "from the coder" }, "call_child_write"),
      say("Tried."),
      // back in the assistant's turn
      say("The coder could not do it."),
    ]));
    const a = await s.connect({ label: "A" });
    await playTurn(s, a, "build it, then have the coder write notes", refuseEverything);

    const record = allCallsTo(s, "write_file", a).find((entry) => entry.callID === "call_child_write");
    expect(record, "the coder never tried the write; the script is out of step").toBeDefined();
    expectAskedAndNamed(record!, "a handed-off write_file");
    expect(existsSync(files.fresh)).toBe(false);
  });

  scenarioTest("delegation: a background worker is asked before it writes a file", async () => {
    const s = await scenarios.start();
    const files = setUp(s);
    const a = await s.connect({ label: "A" });
    s.model.queue(...scripted(true, [
      call("bash", { command: UNPROVEN }, "call_make"),
      call("delegate_task", { toAgentID: "coder", goal: "Write a notes file for me." }, "call_delegate"),
      say("The coder is on it."),
    ]));
    await playTurn(s, a, "build it, then have the coder write notes", refuseEverything);

    // The worker runs later, as a job, with nobody to ask: any card is answered "Allow".
    const owner = answerCards(a, "once");
    s.model.queue(call("write_file", { path: files.fresh, content: "from the worker" }, "call_worker_write"), say("Tried."), say("Noted."));
    const tried = (): boolean => allCallsTo(s, "write_file", a).some((entry) => entry.callID === "call_worker_write");
    for (let tick = 0; tick < 6 && !tried(); tick += 1) await s.runner().tick();
    await s.runner().tick();
    owner.stop();

    const record = allCallsTo(s, "write_file", a).find((entry) => entry.callID === "call_worker_write");
    expect(record, "the worker never tried the write; the script is out of step").toBeDefined();
    expect(owner.cards.length, "the worker wrote a file with no card although its run holds a refused shell command").toBe(1);
    expect(owner.cards[0]!.preview).toContain(NAMED);
  });

  scenarioTest("the next turn is asked afresh: a read is free again", async () => {
    const s = await scenarios.start();
    setUp(s);
    const a = await s.connect({ label: "A" });
    s.model.queue(...scripted(true, [call("bash", { command: UNPROVEN }, "call_make"), say("Not run.")]));
    await playTurn(s, a, "build it", refuseEverything);
    s.model.queue(...scripted(true, [call("bash", { command: "cat other.txt" }, "call_cat"), say("Read.")]));
    const second = await playTurn(s, a, "read the other file", refuseEverything);
    expect(second.calls.find((entry) => entry.callID === "call_cat")?.card, "a refusal outlived its run").toBeNull();
  });

  scenarioTest("a refused PROVEN command does not make the run-wide refusal: a new file is still free", async () => {
    const s = await scenarios.start();
    const files = setUp(s);
    s.model.queue(...scripted(true, [
      call("bash", { command: `rm ${shell(files.denied)}` }, "call_rm"),
      call("write_file", { path: files.fresh, content: "new" }, "call_fresh"),
      say("Done."),
    ]));
    const a = await s.connect({ label: "A" });
    const report = await playTurn(s, a, "clean up", refuseEverything);
    expect(report.calls.find((entry) => entry.callID === "call_fresh")?.card, "a proven refusal widened into a run-wide one").toBeNull();
    expect(existsSync(files.fresh)).toBe(true);
  });
});
