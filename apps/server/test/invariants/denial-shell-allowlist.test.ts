/**
 * INV-07 (shell allowlist): the server does not read a shell line for file names unless the line is
 * one allowlisted program with plain literal words (policy/shell-proof.ts).
 *
 * The contract under test:
 *   - a proven command's files are its literal path arguments; one that matches what the owner refused
 *     is refused outright, with no card;
 *   - any other shell command, in a run that holds a refusal, shows the approval card with the refusal
 *     named, and never runs on its own;
 *   - on Windows a Git Bash path (`/c/...`, `/cygdrive/c/...`, `//?/C:/...`, `/mnt/c/...`) is the same
 *     file as its `C:\...` spelling, or it is unresolved.
 *
 * The refused file is named `q1`: two characters, so nothing here can lean on a text search of the
 * command for the name.
 *
 * For Sprint 7: unattended (sandboxed) shell is off in any run that holds a refusal. The sandbox
 * profile, not this parser, is the boundary.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect } from "bun:test";
import { scenarioTest, useScenarios, say, type Scenario } from "../scenarios/harness";
import { call, playTurn, resultJson, scripted, type CallRecord } from "./support";

const scenarios = useScenarios();
const WINDOWS = process.platform === "win32";

const shell = (path: string): string => path.replaceAll("\\", "/");

function setUp(s: Scenario): { target: string; other: string } {
  mkdirSync(join(s.scratch, "sub"), { recursive: true });
  const files = { target: join(s.scratch, "q1"), other: join(s.scratch, "other.txt") };
  writeFileSync(files.target, "original");
  writeFileSync(files.other, "other");
  return files;
}

/** The owner says no to everything that asks: nothing that ran got past a click. */
const refuseEverything = { answer: () => "reject" as const };

/** Not run: it came back as an error the model can read, or it was put to the owner (who said no). */
const neverRanOnItsOwn = (record: CallRecord | undefined): boolean =>
  record !== undefined && (record.card !== null || Object.hasOwn(resultJson(record), "error"));

/** Refuse the delete of q1, then try `command`. Returns the record of the second call. */
async function afterRefusingTheDelete(s: Scenario, files: { target: string }, command: string, tool: "bash" | "run_privileged" = "bash"): Promise<CallRecord> {
  const args = tool === "bash" ? { command } : { command, purpose: "tidy up" };
  s.model.queue(...scripted(true, [
    call("bash", { command: `rm ${shell(files.target)}` }, "call_rm"),
    call(tool, args, "call_route"),
    say("Done."),
  ]));
  const a = await s.connect({ label: "A" });
  const report = await playTurn(s, a, "clean up q1", refuseEverything);
  const record = report.calls.find((entry) => entry.callID === "call_route");
  expect(record, "the bot never tried the route; the script is out of step").toBeDefined();
  return record!;
}

describe("INV-07 wrappers whose options take a value cannot hide the program", () => {
  for (const command of [
    "sudo -u x rm q1",
    "env -u X rm q1",
    "timeout -s KILL 5 rm q1",
    "nice -n 5 rm q1",
    "sudo rm q1",
    "env FOO=1 rm q1",
    "nohup rm q1",
    "time rm q1",
  ]) {
    scenarioTest(`after the owner refuses rm q1, this does not run on its own: ${command}`, async () => {
      const s = await scenarios.start();
      const files = setUp(s);
      const record = await afterRefusingTheDelete(s, files, command);
      expect(neverRanOnItsOwn(record), `ran without the owner: ${record.result.slice(0, 120)}`).toBe(true);
      expect(readFileSync(files.target, "utf8")).toBe("original");
    });
  }
});

describe("INV-07 options that change the folder cannot move a command off the refused file", () => {
  for (const command of [
    "env -C /tmp rm q1",
    "sudo -D sub rm q1",
    "git -C sub rm q1",
    "make -C sub",
    "tar -C sub -xf a.tar",
    "cd sub && rm ../q1",
    "cp -t sub q1",
  ]) {
    scenarioTest(`after the owner refuses rm q1, this does not run on its own, and its card names the refusal: ${command}`, async () => {
      const s = await scenarios.start();
      const files = setUp(s);
      const record = await afterRefusingTheDelete(s, files, command);
      expect(neverRanOnItsOwn(record), `ran without the owner: ${record.result.slice(0, 120)}`).toBe(true);
      expect(readFileSync(files.target, "utf8")).toBe("original");
      // A command the server cannot follow to file names is put to the owner with the refusal named, not refused blind.
      expect(record.card, `no card: ${record.result.slice(0, 120)}`).not.toBeNull();
      expect(record.card!.preview).toContain("You said no to deleting");
      expect(record.card!.preview).toContain("q1");
      expect(record.card!.preview).toContain("may touch it");
      expect(record.card!.buttons, "an unproven shell command in a refused run offered \"always\"").not.toContain("always");
    });
  }
});

describe("INV-07 an unproven shell command in a run that holds a refusal asks, naming the refusal", () => {
  scenarioTest("run_privileged asks too, with the refusal named", async () => {
    const s = await scenarios.start();
    const files = setUp(s);
    const record = await afterRefusingTheDelete(s, files, "make -C sub", "run_privileged");
    expect(record.card, "the privileged command did not ask").not.toBeNull();
    expect(record.card!.preview).toContain("You said no to deleting");
    expect(readFileSync(files.target, "utf8")).toBe("original");
  });

  scenarioTest("the owner can allow it: the card is a question, not a wall", async () => {
    const s = await scenarios.start();
    const files = setUp(s);
    s.model.queue(...scripted(true, [
      call("bash", { command: `rm ${shell(files.target)}` }, "call_rm"),
      call("bash", { command: `echo kept > ${shell(files.other)}` }, "call_redirect"),
      say("Done."),
    ]));
    const a = await s.connect({ label: "A" });
    const report = await playTurn(s, a, "clean up q1", { answer: (card) => (card.action.includes("rm ") ? "reject" : "once") });
    const record = report.calls.find((entry) => entry.callID === "call_redirect");
    expect(record?.card, "a redirect in a refused run did not ask").not.toBeNull();
    expect(record!.card!.preview).toContain("You said no to deleting");
    expect(readFileSync(files.other, "utf8").trim(), "the owner's yes did not run the command").toBe("kept");
    expect(readFileSync(files.target, "utf8")).toBe("original");
  });

  scenarioTest("a proven command on another file still asks as before, without the warning", async () => {
    const s = await scenarios.start();
    const files = setUp(s);
    s.model.queue(...scripted(true, [
      call("bash", { command: `rm ${shell(files.target)}` }, "call_rm"),
      call("bash", { command: `touch ${shell(join(s.scratch, "new.txt"))}` }, "call_other"),
      say("Done."),
    ]));
    const a = await s.connect({ label: "A" });
    const report = await playTurn(s, a, "clean up q1", refuseEverything);
    const record = report.calls.find((entry) => entry.callID === "call_other");
    expect(record?.card, "a proven command on another file did not ask").not.toBeNull();
    expect(record!.card!.preview, "a command that touches nothing refused was shown the warning").not.toContain("You said no");
  });

  scenarioTest("a read of the refused file is not a delete: `cat q1` still runs free", async () => {
    const s = await scenarios.start();
    const files = setUp(s);
    s.model.queue(...scripted(true, [
      call("bash", { command: `rm ${shell(files.target)}` }, "call_rm"),
      call("bash", { command: "cat q1" }, "call_cat"),
      say("Done."),
    ]));
    const a = await s.connect({ label: "A" });
    const report = await playTurn(s, a, "clean up q1", refuseEverything);
    const record = report.calls.find((entry) => entry.callID === "call_cat");
    expect(record?.card, "a plain read was put to the owner").toBeNull();
    expect(record?.ok).toBe(true);
  });

  scenarioTest("with no refusal in the run, an unproven command asks as before, with no warning", async () => {
    const s = await scenarios.start();
    setUp(s);
    s.model.queue(...scripted(true, [call("bash", { command: "make -C sub" }, "call_make"), say("Done.")]));
    const a = await s.connect({ label: "A" });
    const report = await playTurn(s, a, "build it", refuseEverything);
    const record = report.calls.find((entry) => entry.callID === "call_make");
    expect(record?.card, "a shell command in a clean run must still ask").not.toBeNull();
    expect(record!.card!.preview).not.toContain("You said no");
  });
});

describe.skipIf(!WINDOWS)("INV-07 Git Bash paths are the same file as the C:\\ path the refusal was made on", () => {
  /** The path as a Git Bash user would type it, one per mount style. */
  const SPELLINGS: Array<{ id: string; spell: (win: string) => string }> = [
    { id: "/c/...", spell: (win) => `/${win[0]!.toLowerCase()}${shell(win).slice(2)}` },
    { id: "/C/... (upper-case drive)", spell: (win) => `/${win[0]!.toUpperCase()}${shell(win).slice(2)}` },
    { id: "/cygdrive/c/...", spell: (win) => `/cygdrive/${win[0]!.toLowerCase()}${shell(win).slice(2)}` },
    { id: "/mnt/c/...", spell: (win) => `/mnt/${win[0]!.toLowerCase()}${shell(win).slice(2)}` },
    { id: "//?/C:/...", spell: (win) => `//?/${shell(win)}` },
    { id: "C:/... in a different case", spell: (win) => shell(win).toUpperCase().replace(/Q1$/, "q1") },
  ];

  for (const spelling of SPELLINGS) {
    scenarioTest(`after the owner refuses rm of the C:\\ file, rm of ${spelling.id} is refused with no card`, async () => {
      const s = await scenarios.start();
      const files = setUp(s);
      const record = await afterRefusingTheDelete(s, files, `rm ${spelling.spell(files.target)}`);
      expect(record.card, `${spelling.id} raised a card for the file the owner refused`).toBeNull();
      expect(Object.hasOwn(resultJson(record), "error"), `${spelling.id}: ${record.result.slice(0, 120)}`).toBe(true);
      expect(record.result).toContain("said no");
      expect(readFileSync(files.target, "utf8")).toBe("original");
    });
  }

  scenarioTest("a Git Bash path to a different file is not over-refused: it asks like any command", async () => {
    const s = await scenarios.start();
    const files = setUp(s);
    const spelled = `/${files.other[0]!.toLowerCase()}${shell(files.other).slice(2)}`;
    const record = await afterRefusingTheDelete(s, files, `touch ${spelled}`);
    expect(record.card, "a Git Bash path to another file was refused outright").not.toBeNull();
    expect(record.card!.preview, "a path to another file was shown the warning").not.toContain("You said no");
  });

  scenarioTest("a POSIX path the server cannot convert asks, naming the refusal, and does not run", async () => {
    const s = await scenarios.start();
    const files = setUp(s);
    const record = await afterRefusingTheDelete(s, files, "rm /tmp/q1");
    expect(record.card, "an unconvertible absolute path did not ask").not.toBeNull();
    expect(record.card!.preview).toContain("You said no to deleting");
    expect(existsSync(files.target)).toBe(true);
  });
});
