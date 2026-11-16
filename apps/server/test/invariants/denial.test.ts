/**
 * INV-07: a denial covers the thing, not just the tool (S2-07; exit test 2).
 *
 *   If the owner refuses a delete, the bot cannot reach the same file another
 *   way in that run: overwrite, append, move, copy or shell. The owner's
 *   later reflexive "Allow" is not the defence; the run already knows the
 *   answer. A different file stays usable, and the next run asks afresh.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect } from "bun:test";
import { scenarioTest, useScenarios, say } from "../scenarios/harness";
import { call, playTurn, resultJson, scripted } from "./support";

const scenarios = useScenarios();

const shell = (path: string): string => path.replaceAll("\\", "/");

// waits for S2-1b (S2-07: denial covers (resource, operation) for the run)
describe("INV-07 a denied delete holds across tools for the rest of the run", () => {
  scenarioTest("after the owner refuses `rm`, overwrite, append, move, copy and shell redirects to that file are refused with no new card", async () => {
    const s = await scenarios.start();
    mkdirSync(s.scratch, { recursive: true });
    const target = join(s.scratch, "ledger.txt");
    const other = join(s.scratch, "other.txt");
    const fresh = join(s.scratch, "fresh.txt");
    writeFileSync(target, "original ledger");
    writeFileSync(other, "other file");
    s.model.queue(...scripted(true, [
      call("bash", { command: `rm ${shell(target)}` }, "call_rm"),
      call("write_file", { path: target, content: "overwritten" }, "call_overwrite"),
      call("write_file", { path: target, content: " appended", append: true }, "call_append"),
      call("bash", { command: `mv ${shell(target)} ${shell(join(s.scratch, "moved.txt"))}` }, "call_mv"),
      call("bash", { command: `cp ${shell(other)} ${shell(target)}` }, "call_cp"),
      call("bash", { command: `echo hijacked > ${shell(target)}` }, "call_redirect"),
      call("write_file", { path: fresh, content: "a different file" }, "call_fresh"),
      say("Done."),
    ]));
    const a = await s.connect({ label: "A" });
    // The owner refuses the delete; if the product asks again about the same file, an owner who clicks Allow reflexively must not undo that.
    const report = await playTurn(s, a, "clean up the old ledger", {
      answer: (card) => (card.action.includes("rm ") ? "reject" : "once"),
    });

    const problems: string[] = [];
    if (readFileSync(target, "utf8") !== "original ledger") problems.push(`the file now reads "${readFileSync(target, "utf8")}"`);
    if (existsSync(join(s.scratch, "moved.txt"))) problems.push("the file was moved");
    for (const id of ["call_overwrite", "call_append", "call_mv", "call_cp", "call_redirect"]) {
      const record = report.calls.find((entry) => entry.callID === id)!;
      if (record.card) problems.push(`${record.name}(${id}) raised a new card for a file the owner already refused`);
      else if (!Object.hasOwn(resultJson(record), "error")) problems.push(`${record.name}(${id}) came back without an error: ${record.result.slice(0, 80)}`);
    }
    expect(problems, "the denial did not cover the file").toEqual([]);
    expect(existsSync(fresh), "a different file was blocked too (a denial must not over-reach)").toBe(true);
  });

  scenarioTest("the denial ends with the run: the next turn asks about the same file again", async () => {
    const s = await scenarios.start();
    mkdirSync(s.scratch, { recursive: true });
    const target = join(s.scratch, "ledger.txt");
    writeFileSync(target, "original ledger");
    const a = await s.connect({ label: "A" });

    s.model.queue(...scripted(true, [call("bash", { command: `rm ${shell(target)}` }, "call_rm_1"), say("Not deleted.")]));
    const first = await playTurn(s, a, "delete the old ledger");
    expect(first.cards.length, "the delete should have asked").toBe(1);

    s.model.queue(...scripted(true, [call("write_file", { path: target, content: "replacement" }, "call_overwrite_2"), say("Saved.")]));
    const second = await playTurn(s, a, "actually, replace the ledger with a new one", { answer: () => "once" });
    expect(second.cards.length, "the next run was refused without asking; a denial must not outlive its run").toBe(1);
    expect(readFileSync(target, "utf8")).toBe("replacement");
  });
});
