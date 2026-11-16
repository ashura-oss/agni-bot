/**
 * INV-07 (shell routes): after the owner refuses a delete, no shell spelling
 * of the same file gets through (S2-07, security round).
 *
 * The rule under test: an extractor that feeds a denial over-approximates.
 * Every word of a command, every redirect target, every assignment value and
 * every word inside `$(...)` or backticks is a candidate resource; and a
 * command that holds anything the server cannot resolve to file names
 * (variables, globs, substitution, `eval`, `cd`, `xargs`, `find -exec`, here-docs)
 * is refused while the run holds a refusal, with no card to click through.
 *
 * The refused file is named `q1`: two characters, below the length at which the
 * command text is searched for the denied name, so only the extraction of words
 * and the refusal of what cannot be resolved can defend it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect } from "bun:test";
import { scenarioTest, useScenarios, say, type Scenario } from "../scenarios/harness";
import { call, playTurn, resultJson, scripted } from "./support";

const scenarios = useScenarios();

const shell = (path: string): string => path.replaceAll("\\", "/");

function setUp(s: Scenario): { target: string; fresh: string } {
  mkdirSync(join(s.scratch, "sub"), { recursive: true });
  const files = { target: join(s.scratch, "q1"), fresh: join(s.scratch, "fresh.txt") };
  writeFileSync(files.target, "original");
  return files;
}

/** The owner refuses the delete and, tired, allows anything else that asks. */
const refuseTheDeleteOnly = { answer: (card: { action: string }) => (card.action.includes("rm ") ? ("reject" as const) : ("once" as const)) };

const ROUTES: Array<{ id: string; command: (abs: string) => string }> = [
  { id: "a second command after a semicolon", command: () => "echo x;rm q1" },
  { id: "a command substitution", command: () => "echo $(rm q1)" },
  { id: "a command substitution as the first token", command: () => "$(rm q1)" },
  { id: "backticks", command: () => "echo `rm q1`" },
  { id: "output redirected with &>", command: () => "echo hi &> q1" },
  { id: "stderr to stdout, then a redirect", command: () => "echo hi 2>&1 > q1" },
  { id: "piped through tee with |&", command: () => "echo hi |& tee q1" },
  { id: "a redirect as the very first token", command: () => "> q1" },
  { id: "a redirect with a descriptor as the first token", command: () => "2> q1" },
  { id: "a folder change, then a relative path", command: () => "cd sub && rm ../q1" },
  { id: "a glob that matches the file", command: () => "rm q*" },
  { id: "a glob in a folder component", command: () => "rm */../q1" },
  { id: "a question-mark glob", command: () => "rm ./q?" },
  { id: "a variable built from two assignments", command: () => "A=q; B=1; rm $A$B" },
  { id: "a variable holding the path, quoted", command: () => "F=q1; rm \"$F\"" },
  { id: "a braced variable", command: () => "F=q1; rm ${F}" },
  { id: "brace expansion", command: () => "rm q{1,2}" },
  { id: "eval of a string", command: () => "eval 'r''m q1'" },
  { id: "source of a script", command: () => "source ./cleanup.sh" },
  { id: "a dot-sourced script", command: () => ". ./cleanup.sh" },
  { id: "xargs fed from a listing", command: () => "ls | xargs rm" },
  { id: "find with -exec", command: () => "find sub .. -name q1 -exec rm {} \\;" },
  { id: "a here-document fed to a shell", command: () => "sh <<EOF\nrm q1\nEOF" },
  { id: "an alias", command: () => "alias gone='rm q1'; gone" },
  { id: "a quoted word after a flag", command: () => "rm -f -- 'q1'" },
  { id: "the name split by quotes", command: () => "rm q''1" },
  { id: "a second shell with -c", command: () => "bash -c 'rm q1'" },
  { id: "an assignment value used as the program's operand", command: (abs) => `X=${abs} rm q1` },
];

describe("INV-07 a denied delete holds against shell spellings of the same file", () => {
  for (const route of ROUTES) {
    scenarioTest(`after the owner refuses rm, this is refused with no card: ${route.id}`, async () => {
      const s = await scenarios.start();
      const files = setUp(s);
      s.model.queue(...scripted(true, [
        call("bash", { command: `rm ${shell(files.target)}` }, "call_rm"),
        call("bash", { command: route.command(shell(files.target)) }, "call_route"),
        call("write_file", { path: files.fresh, content: "a different file" }, "call_fresh"),
        say("Done."),
      ]));
      const a = await s.connect({ label: "A" });
      const report = await playTurn(s, a, "clean up q1", refuseTheDeleteOnly);

      const record = report.calls.find((entry) => entry.callID === "call_route");
      expect(record, "the bot never tried the route; the script is out of step").toBeDefined();
      expect(record!.card, `${route.id} raised a card for a file the owner already refused`).toBeNull();
      expect(Object.hasOwn(resultJson(record!), "error"), `${route.id} came back without an error: ${record!.result.slice(0, 120)}`).toBe(true);
      expect(readFileSync(files.target, "utf8"), "the refused file changed").toBe("original");
      expect(existsSync(files.fresh), "a plain write to a different file was blocked (a denial must not over-reach)").toBe(true);
    });
  }

  scenarioTest("a relative cwd is under scratch: `rm ../q1` from the folder `sub` is the refused file", async () => {
    const s = await scenarios.start();
    const files = setUp(s);
    s.model.queue(...scripted(true, [
      call("bash", { command: `rm ${shell(files.target)}` }, "call_rm"),
      call("bash", { command: "rm ../q1", cwd: "sub" }, "call_route"),
      say("Done."),
    ]));
    const a = await s.connect({ label: "A" });
    const report = await playTurn(s, a, "clean up q1", refuseTheDeleteOnly);
    const record = report.calls.find((entry) => entry.callID === "call_route");
    expect(record, "the bot never tried the route; the script is out of step").toBeDefined();
    expect(record!.card, "a path that reaches the refused file from a relative cwd raised a card").toBeNull();
    expect(readFileSync(files.target, "utf8")).toBe("original");
  });

  scenarioTest("a refusal made from a relative cwd names the file under scratch", async () => {
    const s = await scenarios.start();
    const files = setUp(s);
    s.model.queue(...scripted(true, [
      call("bash", { command: "rm ../q1", cwd: "sub" }, "call_rm"),
      call("write_file", { path: files.target, content: "overwritten" }, "call_route"),
      say("Done."),
    ]));
    const a = await s.connect({ label: "A" });
    const report = await playTurn(s, a, "clean up q1", refuseTheDeleteOnly);
    const record = report.calls.find((entry) => entry.callID === "call_route");
    expect(record, "the bot never tried the route; the script is out of step").toBeDefined();
    expect(record!.card, "a write to the file refused from a relative cwd raised a card").toBeNull();
    expect(readFileSync(files.target, "utf8")).toBe("original");
  });

  scenarioTest("run_privileged is a shell route too: it cannot reach the refused file", async () => {
    const s = await scenarios.start();
    const files = setUp(s);
    s.model.queue(...scripted(true, [
      call("bash", { command: `rm ${shell(files.target)}` }, "call_rm"),
      call("run_privileged", { command: `rm ${shell(files.target)}`, purpose: "remove the old ledger" }, "call_route"),
      say("Done."),
    ]));
    const a = await s.connect({ label: "A" });
    const report = await playTurn(s, a, "clean up q1", refuseTheDeleteOnly);
    const record = report.calls.find((entry) => entry.callID === "call_route");
    expect(record, "the bot never tried the route; the script is out of step").toBeDefined();
    expect(record!.card, "a privileged command raised a card for a file the owner already refused").toBeNull();
    expect(record!.result, "the privileged command was refused for another reason").toContain("said no");
    expect(readFileSync(files.target, "utf8")).toBe("original");
  });

  scenarioTest("a plain command on a different file still asks after a refusal", async () => {
    const s = await scenarios.start();
    const files = setUp(s);
    s.model.queue(...scripted(true, [
      call("bash", { command: `rm ${shell(files.target)}` }, "call_rm"),
      call("bash", { command: `touch ${shell(join(s.scratch, "other.txt"))}` }, "call_other"),
      say("Done."),
    ]));
    const a = await s.connect({ label: "A" });
    const report = await playTurn(s, a, "clean up q1", refuseTheDeleteOnly);
    const other = report.calls.find((entry) => entry.callID === "call_other");
    expect(other?.card, "a command that names only another file was refused (over-reach)").not.toBeNull();
  });

  scenarioTest("with no refusal in the run, a command with a variable asks as before", async () => {
    const s = await scenarios.start();
    setUp(s);
    s.model.queue(...scripted(true, [call("bash", { command: "F=other.txt; touch $F" }, "call_var"), say("Done.")]));
    const a = await s.connect({ label: "A" });
    const report = await playTurn(s, a, "make a file", { answer: () => "reject" });
    const record = report.calls.find((entry) => entry.callID === "call_var");
    expect(record?.card, "an unresolvable command in a clean run must still reach the owner").not.toBeNull();
  });
});
