/**
 * The history answer names the turn behind the owner's message (Sprint 4 exit finding).
 *
 * "No reply, stopped" is what the app shows when the owner stopped a turn before any text came. After a
 * reload there is no assistant row to hang it on, so the owner's own row has to say which turn it started
 * and how that turn ended. The user's channel message used to be written before the turn existed and never
 * updated, so `conversation.history.ok` carried no `turnID` for it.
 */
import { describe, expect } from "bun:test";
import { eventually, gate, scenarioTest, useScenarios } from "../scenarios/harness";

const scenarios = useScenarios();

interface HistoryMessage { id: string; role: string; text: string; turnID?: string; stopReason?: string }

async function historyOf(s: Awaited<ReturnType<ReturnType<typeof useScenarios>["start"]>>, client: Awaited<ReturnType<Awaited<ReturnType<ReturnType<typeof useScenarios>["start"]>>["connect"]>>, conversationID: string): Promise<HistoryMessage[]> {
  await s.barrier();
  const since = client.mark();
  client.send({ type: "conversation.history", conversationID });
  const answer = await client.waitFor("conversation.history.ok", { since, why: "the history answer" });
  return answer.messages as HistoryMessage[];
}

describe("history carries the turn of the owner's message", () => {
  scenarioTest("a turn stopped before any text: the owner's row names the turn and how it ended", async () => {
    const s = await scenarios.start();
    const hold = gate();
    s.model.queue({ text: [], hold });
    const a = await s.connect({ label: "A" });
    const started = await a.startTurn("write me a long report");
    await s.model.requested(1);
    a.send({ type: "msg.cancel", turnID: started.turnID });
    const end = await a.waitFor("turn.end", { match: (frame) => frame.turnID === started.turnID, why: "the stopped turn to end" });
    expect(end.stopReason).toBe("cancelled");
    const conversationID = String((await a.waitFor("turn.start", { since: started.since, why: "its turn.start" })).conversationID);

    const messages = await historyOf(s, a, conversationID);
    const mine = messages.find((message) => message.role === "user" && message.text === "write me a long report");
    expect(mine, "the owner's message is missing from the history").toBeDefined();
    expect(mine!.turnID, "the owner's row does not name the turn it started").toBe(started.turnID);
    expect(mine!.stopReason, "the owner's row does not say the turn was stopped before it wrote anything").toBe("cancelled");
    expect(messages.some((message) => message.role === "assistant" && message.turnID === started.turnID)).toBe(false);
  });

  scenarioTest("a turn that answered: the owner's row names the turn and the reply carries the stop reason", async () => {
    const s = await scenarios.start();
    s.model.queue({ text: ["Here is the answer."] });
    const a = await s.connect({ label: "A" });
    const started = await a.startTurn("what is the answer");
    await a.waitFor("turn.end", { match: (frame) => frame.turnID === started.turnID, why: "the turn to end" });
    await eventually(() => s.get<{ state: string }>("SELECT state FROM turns WHERE id = ?", started.turnID)?.state === "done", { label: "the turn is finished" });
    const conversationID = String((await a.waitFor("turn.start", { since: started.since, why: "its turn.start" })).conversationID);

    const messages = await historyOf(s, a, conversationID);
    const mine = messages.find((message) => message.role === "user" && message.text === "what is the answer");
    expect(mine?.turnID).toBe(started.turnID);
    // The reply keeps its own marker, and the owner's row does not repeat it.
    expect(mine?.stopReason).toBeUndefined();
    const reply = messages.find((message) => message.role === "assistant" && message.text.includes("Here is the answer."));
    expect(reply?.stopReason).toBe("end");
  });
});
