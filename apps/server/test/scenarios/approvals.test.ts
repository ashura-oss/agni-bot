import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { calls, call, loadTools, say, useScenarios, type Scenario, type ScenarioClient } from "./harness";

/**
 * Sprint 1 exit scenarios 4 to 7: approval cards mean what they say.
 *
 * Bots with big toolsets list most tools by name and load them with
 * `load_tools` first, so every script that uses `bash`, `write_file` and the
 * like starts with a `load_tools` step, as a real model must.
 */

const scenarios = useScenarios();

/** Wait for a card, or fail clearly if the turn ends without one. */
async function expectCard(client: ScenarioClient, since: number, why: string) {
  const first = await client.firstOf(["approval.request", "turn.end"], { since, why });
  if (first.type !== "approval.request") throw new Error(`${why}: the turn ended without asking`);
  return first;
}

describe("S1-04 stop mid-step", () => {
  test("cancelling at the first approval card stops the rest of the step", async () => {
    const s = await scenarios.start();
    const touchOne = s.outside("one.txt");
    const touchTwo = s.outside("two.txt");
    s.model.queue(
      loadTools("bash"),
      calls(
        { name: "bash", args: { command: `touch ${touchOne.replaceAll("\\", "/")}` }, id: "call_bash_one" },
        { name: "task_create", args: { title: "A task the stopped turn must not create" }, id: "call_task" },
        { name: "bash", args: { command: `touch ${touchTwo.replaceAll("\\", "/")}` }, id: "call_bash_two" },
      ),
      say("Finished everything."),
    );

    const a = await s.connect({ label: "A" });
    const { turnID, since } = await a.startTurn("do three things in a row");
    await expectCard(a, since, "the first gated bash call");

    a.send({ type: "msg.cancel", turnID });
    const end = await a.waitFor("turn.end", { since, match: (frame) => frame.turnID === turnID, why: "the cancelled turn to end" });

    expect(end.stopReason).toBe("cancelled");
    const problems: string[] = [];
    const tasks = s.get<{ n: number }>("SELECT count(*) AS n FROM tasks")!.n;
    if (tasks !== 0) problems.push(`task_create ran after the owner pressed Stop (${tasks} task created)`);
    const cards = a.framesOf("approval.request", since).length;
    if (cards !== 1) problems.push(`${cards} approval cards were raised; only the first should exist`);
    if (existsSync(touchOne) || existsSync(touchTwo)) problems.push("a gated command ran");
    expect(problems, "the rest of the step kept going after Stop").toEqual([]);
  });
});

describe("S1-05 approval after the turn ended", () => {
  /** A turn parked on an approval card, then ended by the owner. */
  async function endedWithCardPending(s: Scenario): Promise<{ a: ScenarioClient; requestID: string }> {
    s.model.queue(
      loadTools("bash"),
      call("bash", { command: `touch ${s.outside("late.txt").replaceAll("\\", "/")}` }, "call_bash_late"),
      say("Done."),
    );
    const a = await s.connect({ label: "A" });
    const { turnID, since } = await a.startTurn("tidy up the shared folder");
    const card = await expectCard(a, since, "the gated bash call");
    a.send({ type: "msg.cancel", turnID });
    await a.waitFor("turn.end", { since, match: (frame) => frame.turnID === turnID, why: "the turn to end" });
    return { a, requestID: card.requestID };
  }

  test("the client is told the card is closed", async () => {
    const s = await scenarios.start();
    const { a, requestID } = await endedWithCardPending(s);

    const closed = await a.waitFor("approval.closed", {
      match: (frame) => frame.requestID === requestID,
      timeoutMs: 1_500,
      why: `approval.closed for ${requestID} once its turn ended`,
    });
    expect(closed.kind).toBe("approval");
    expect(["expired", "cancelled"]).toContain(closed.reason);
  });

  test("a late approve.reply is refused with an error", async () => {
    const s = await scenarios.start();
    const { a, requestID } = await endedWithCardPending(s);

    const since = a.mark();
    a.send({ type: "approve.reply", requestID, decision: "once" });
    await a.waitFor("error", {
      since,
      timeoutMs: 1_500,
      why: `an error for an approve.reply to the dead card ${requestID}`,
    });
  });

  test("hello does not replay the dead card", async () => {
    const s = await scenarios.start();
    const { requestID } = await endedWithCardPending(s);

    const reconnected = await s.connect({ label: "A-reconnected" });
    const replayed = reconnected.framesOf("approval.request").map((frame) => frame.requestID);
    expect(replayed, "a card whose turn ended came back on hello").not.toContain(requestID);
  });
});

describe("S1-06 scratch overwrite gates", () => {
  test("a new scratch file is written freely; writing the same path again asks first", async () => {
    const s = await scenarios.start();
    const path = `${s.scratch}/notes.txt`;
    s.model.queue(
      loadTools("write_file"),
      call("write_file", { path, content: "first version" }, "call_write_new"),
      call("write_file", { path, content: "second version" }, "call_write_again"),
      say("Done."),
    );

    const a = await s.connect({ label: "A" });
    const { since } = await a.startTurn("save my notes, then save them again");

    const next = await a.firstOf(["approval.request", "turn.end"], { since, why: "a card for the overwrite" });
    const wroteNew = a.framesOf("tool.end", since).find((frame) => frame.callID === "call_write_new");
    expect(wroteNew?.ok, "the first write to a new scratch file should run without a card").toBe(true);
    expect(next.type, "the second write to an existing scratch file ran without asking").toBe("approval.request");
    expect(readFileSync(path, "utf8"), "the overwrite happened before the owner approved").toBe("first version");

    if (next.type === "approval.request") a.send({ type: "approve.reply", requestID: next.requestID, decision: "reject" });
    await a.waitFor("turn.end", { since, why: "the turn to end after the owner rejected" });
    expect(readFileSync(path, "utf8")).toBe("first version");
  });
});

describe("S1-07 always allow persists for one bot, tool and target", () => {
  test("a remembered write skips the card; another target or another bot still asks", async () => {
    const s = await scenarios.start();
    const granted = s.outside("granted.txt");
    const other = s.outside("other.txt");
    const a = await s.connect({ label: "A" });

    // Turn 1: the first write asks, the owner answers "always".
    s.model.queue(loadTools("write_file"), call("write_file", { path: granted, content: "one" }, "call_first"), say("Saved."));
    const first = await a.startTurn("save the granted file");
    const card = await expectCard(a, first.since, "the first write outside scratch");
    a.send({ type: "approve.reply", requestID: card.requestID, decision: "always" });
    await a.waitFor("turn.end", { since: first.since, why: "turn 1 to end" });
    expect(readFileSync(granted, "utf8")).toBe("one");

    // Turn 2: the same bot, tool and target runs without a card.
    s.model.queue(loadTools("write_file"), call("write_file", { path: granted, content: "two" }, "call_second"), say("Saved again."));
    const second = await a.startTurn("save the granted file again");
    const secondOutcome = await a.firstOf(["approval.request", "turn.end"], { since: second.since, why: "turn 2 to end or ask" });
    expect(secondOutcome.type, "the same call asked again after Always allow").toBe("turn.end");
    expect(readFileSync(granted, "utf8")).toBe("two");

    // Turn 3: the same tool on a different target still asks.
    s.model.queue(loadTools("write_file"), call("write_file", { path: other, content: "x" }, "call_other"), say("Saved the other one."));
    const third = await a.startTurn("save a different file");
    const otherCard = await expectCard(a, third.since, "a write to a different target");
    a.send({ type: "approve.reply", requestID: otherCard.requestID, decision: "reject" });
    await a.waitFor("turn.end", { since: third.since, why: "turn 3 to end" });
    expect(existsSync(other)).toBe(false);

    // Turn 4: another bot, the same tool and target, still asks.
    s.model.queue(loadTools("write_file"), call("write_file", { path: granted, content: "from coder" }, "call_coder"), say("Saved as coder."));
    const fourth = await a.startTurn("save the granted file as the coder", { channelId: "dm:coder", toAgentId: "coder" });
    const coderCard = await expectCard(a, fourth.since, "the same write by a different bot");
    a.send({ type: "approve.reply", requestID: coderCard.requestID, decision: "reject" });
    await a.waitFor("turn.end", { since: fourth.since, why: "turn 4 to end" });
    expect(readFileSync(granted, "utf8"), "the other bot's write ran without its own approval").toBe("two");
  });
});
