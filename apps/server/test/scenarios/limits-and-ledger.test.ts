import { describe, expect } from "bun:test";
import { resetS2Startup } from "../../src/startup/s2";
import { startupS2Ledger } from "../../src/startup/s2-ledger";
import { scenarioTest, calls, say, textOf, toolPairingProblems, toolResult, useScenarios, type ToolCallSpec } from "./harness";

/**
 * Sprint 1 exit scenarios 8, 9 and 11: a runaway response is bounded, the
 * usage ledger counts every step, and compaction never tears a tool call from
 * its result or the owner's request from the conversation.
 */

const scenarios = useScenarios();

describe("S1-08 tool-call cap", () => {
  scenarioTest("one response with 40 tool calls runs at most 25, and every call id gets a result", async () => {
    const s = await scenarios.start();
    const specs: ToolCallSpec[] = Array.from({ length: 40 }, (_, index) => ({
      id: `call_${String(index).padStart(2, "0")}`,
      name: "task_create",
      args: { title: `Runaway task ${index}` },
    }));
    s.model.queue(calls(...specs), say("All done."));

    const a = await s.connect({ label: "A" });
    const { turnID, since } = await a.startTurn("create forty tasks");
    await a.waitFor("turn.end", { since, match: (frame) => frame.turnID === turnID, why: "the turn to end" });

    const created = s.get<{ n: number }>("SELECT count(*) AS n FROM tasks")!.n;
    expect(created, "calls that ran").toBeGreaterThan(0);
    expect(created, "more than 25 tool calls from one response ran").toBeLessThanOrEqual(25);

    // The model's next request must pair every call id with a result, run or refused.
    expect(s.model.requests.length).toBeGreaterThanOrEqual(2);
    const followUp = s.model.requests[1]!;
    const missing = specs.filter((spec) => {
      const result = toolResult(followUp, spec.id!);
      return result === undefined || result === "";
    });
    expect(missing.map((spec) => spec.id), "call ids that got no tool result").toEqual([]);
  });
});

describe("S1-16 usage ledger", () => {
  scenarioTest("a three-step turn records the usage of all three steps, one ledger row each", async () => {
    const s = await scenarios.start();
    // What `serve()` does: the router's usage hook writes one row per model call.
    await startupS2Ledger({ db: s.db, config: {} as never });
    s.model.queue(
      { calls: [{ name: "memory_search", args: { query: "first lookup" }, id: "call_a" }], usage: { in: 100, out: 10 } },
      { calls: [{ name: "memory_search", args: { query: "second lookup" }, id: "call_b" }], usage: { in: 200, out: 20 } },
      { text: "Here is what I found.", usage: { in: 300, out: 30 } },
    );

    const a = await s.connect({ label: "A" });
    const { turnID, since } = await a.startTurn("look two things up, then answer");
    await a.waitFor("turn.end", { since, match: (frame) => frame.turnID === turnID, why: "the turn to end" });

    const ledger = s.get<{ input: number | null; output: number | null; rows: number }>(
      "SELECT SUM(input_tokens) AS input, SUM(output_tokens) AS output, COUNT(*) AS rows FROM usage_ledger",
    );
    expect(ledger?.rows, "one ledger row per model call").toBe(3);
    expect(ledger?.input, "input tokens recorded for the turn (100 + 200 + 300)").toBe(600);
    expect(ledger?.output, "output tokens recorded for the turn (10 + 20 + 30)").toBe(60);
    resetS2Startup();
  });
});

describe("S1-14 compaction keeps call/result pairs and the current user message", () => {
  const request = "Please audit every shelf and report back. Reference code ZETA-4471.";
  const steps = 12;

  const narration = (step: number): string => `Step ${step} notes: ${"the shelves are being audited. ".repeat(190)}`;

  /** Twelve tool steps with large narration, so the working history outgrows the prompt budget more than once. */
  async function longTurn() {
    const s = await scenarios.start();
    for (let step = 1; step <= steps; step += 1) {
      s.model.queue({
        text: narration(step),
        calls: [
          { name: "memory_search", args: { query: `shelf ${step} first` }, id: `call_${step}_a` },
          { name: "memory_search", args: { query: `shelf ${step} second` }, id: `call_${step}_b` },
        ],
      });
    }
    s.model.queue(say("Audit complete."));
    const a = await s.connect({ label: "A" });
    const { turnID, since } = await a.startTurn(request);
    await a.waitFor("turn.end", { since, match: (frame) => frame.turnID === turnID, timeoutMs: 10_000, why: "the long turn to end" });
    return s;
  }

  scenarioTest("no request sends a tool result without its calling assistant message", async () => {
    const s = await longTurn();
    const last = s.model.requests.at(-1)!;
    const keptChars = last.messages
      .filter((message) => message.role !== "system")
      .reduce((total, message) => total + textOf(message).length + JSON.stringify(message.tool_calls ?? []).length, 0);
    const uncompactedChars = Array.from({ length: steps }, (_, index) => narration(index + 1).length).reduce((a, b) => a + b, 0);
    expect(keptChars, "the last request is as big as the whole history: compaction never engaged, so this proves nothing")
      .toBeLessThan(uncompactedChars);

    const problems = s.model.requests.flatMap((req) => toolPairingProblems(req.messages).map((problem) => `request ${req.index}: ${problem}`));
    expect(problems).toEqual([]);
  });

  scenarioTest("the owner's latest message is still a user message, verbatim, in every request", async () => {
    const s = await longTurn();
    const withoutIt = s.model.requests
      .filter((req) => !req.messages.some((message) => message.role === "user" && textOf(message) === request))
      .map((req) => req.index);
    expect(withoutIt, "requests where the owner's message is missing or was folded into a summary").toEqual([]);
  });
});
