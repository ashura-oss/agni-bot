import { describe, expect } from "bun:test";
import { scenarioTest, call, loadTools, say, textOf, useScenarios } from "./harness";
import { buildConversationHistory } from "../../src/ws/history";

/**
 * After Stop, the stopped request is closed in the model's context (a note the
 * model sees) and not in the owner's history (the note is not a chat bubble).
 */
const scenarios = useScenarios();

describe("Stop closes the request it stopped", () => {
  scenarioTest("the next turn is told the stopped request is closed, and the owner sees no such bubble", async () => {
    const s = await scenarios.start();
    const doomed = s.outside("must-not-exist.txt");
    s.model.queue(
      loadTools("bash"),
      call("bash", { command: `touch ${doomed.replaceAll("\\", "/")}` }, "call_bash_stopped"),
      say("4."),
    );
    const a = await s.connect({ label: "A" });
    const first = await a.startTurn("tidy the shared folder");
    const card = await a.firstOf(["approval.request", "turn.end"], { since: first.since, why: "the gated bash call" });
    expect(card.type).toBe("approval.request");
    a.send({ type: "msg.cancel", turnID: first.turnID });
    const ended = await a.waitFor("turn.end", { since: first.since, match: (frame) => frame.turnID === first.turnID, why: "the stopped turn to end" });
    expect(ended.stopReason).toBe("cancelled");

    const second = await a.startTurn("what is 2+2?");
    await a.waitFor("turn.end", { since: second.since, match: (frame) => frame.turnID === second.turnID, why: "the second turn to end" });

    const request = s.model.requests.at(-1)!;
    const lines = request.messages.filter((message) => message.role !== "system").map((message) => `${message.role}: ${textOf(message)}`);
    const oldAt = lines.findIndex((line) => line.includes("tidy the shared folder"));
    const newAt = lines.findIndex((line) => line.includes("what is 2+2?"));
    expect(oldAt).toBeGreaterThanOrEqual(0);
    // Between the stopped request and the new one sits the closure note, worded as a firm refusal to resume.
    const note = lines[oldAt + 1]!;
    expect(note).toMatch(/^assistant: /);
    expect(note).toMatch(/Stop/);
    expect(note).toMatch(/will not resume it, retry its actions/i);
    expect(newAt).toBeGreaterThan(oldAt + 1);
    expect(request.messages.some((message) => (message.tool_calls ?? []).length > 0)).toBe(false);

    // Not in the owner's history, on either surface.
    const conversationID = s.get<{ conversation_id: string }>("SELECT conversation_id FROM threads WHERE id = ?", first.threadID)!.conversation_id;
    const shown = buildConversationHistory(s.db, conversationID, 200).map((message) => message.text).join("\n");
    expect(shown).not.toMatch(/will not resume it/i);
    const channel = s.db.query<{ text: string }, []>("SELECT text FROM channel_messages").all().map((row) => row.text).join("\n");
    expect(channel).not.toMatch(/will not resume it/i);
  });
});
