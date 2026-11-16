import { describe, expect, test } from "bun:test";
import { call, loadTools, say, toolResult, useScenarios } from "./harness";

/**
 * Sprint 1 exit scenarios 10 and 12: a bot made in a turn can be used in that
 * turn, and a wake turn (a delegated task finishing) can schedule a job.
 */

const scenarios = useScenarios();

describe("S1-10 create then delegate in the same turn", () => {
  test("a bot created by create_agent can be delegated to in the same turn", async () => {
    const s = await scenarios.start();
    s.model.queue(
      loadTools("create_agent"),
      call("create_agent", {
        name: "Scout",
        id: "scout",
        role: "scouting",
        prompt: "You scout things and report briefly.",
      }, "call_create"),
      call("delegate_task", { toAgentID: "scout", goal: "Scout the east warehouse and report what is there." }, "call_delegate"),
      say("Scout is on it."),
    );

    const a = await s.connect({ label: "A" });
    const { turnID, since } = await a.startTurn("make me a scout bot and send it to the east warehouse");
    await a.waitFor("turn.end", { since, match: (frame) => frame.turnID === turnID, why: "the turn to end" });

    // The model saw both calls succeed.
    const afterDelegate = s.model.requests.at(-1)!;
    expect(toolResult(afterDelegate, "call_create"), "create_agent result").toMatchObject({ id: "scout" });
    const delegated = toolResult(afterDelegate, "call_delegate") as Record<string, unknown>;
    expect(delegated.error, "delegate_task to the bot created earlier in the turn was refused").toBeUndefined();
    expect(delegated.state).toBe("queued");

    // And the work is really queued for the new bot.
    const task = s.get<{ owner_agent_id: string; delegate_state: string }>(
      "SELECT owner_agent_id, delegate_state FROM tasks WHERE owner_agent_id = 'scout'",
    );
    expect(task?.delegate_state).toBe("queued");
  });
});

describe("S1-22 a wake turn can schedule a job", () => {
  test("after a delegated task finishes, the parent's wake turn can call job_schedule", async () => {
    const s = await scenarios.start();
    const followUp = "Check on the warehouse report tomorrow morning.";
    const when = new Date(Date.now() + 24 * 3_600_000).toISOString();

    // Turn 1 (owner): delegate research, then say it started.
    s.model.queue(
      call("delegate_task", { toAgentID: "researcher", goal: "Count the pallets in the east warehouse." }, "call_delegate"),
      say("The researcher is counting."),
    );
    const a = await s.connect({ label: "A" });
    const { turnID, since } = await a.startTurn("have the researcher count the pallets");
    await a.waitFor("turn.end", { since, match: (frame) => frame.turnID === turnID, why: "the owner's turn to end" });

    // The researcher's turn (background job), then the parent's wake turn.
    s.model.queue(
      say("There are 42 pallets."),
      loadTools("job_schedule"),
      call("job_schedule", { text: followUp, at: when }, "call_schedule"),
      say("I scheduled a follow-up."),
    );
    const scheduled = (): { payload: string } | null => s.get<{ payload: string }>(
      "SELECT payload FROM jobs WHERE kind = 'turn' AND json_extract(payload, '$.text') = ?",
      followUp,
    );
    for (let tick = 0; tick < 4 && !scheduled(); tick += 1) await s.runner().tick();

    const wake = s.model.requests.at(-1)!;
    const result = toolResult(wake, "call_schedule") as Record<string, unknown> | undefined;
    expect(result?.error, "job_schedule was refused in the wake turn").toBeUndefined();
    expect(scheduled(), "no scheduled job was created by the wake turn").not.toBeNull();
  });
});
