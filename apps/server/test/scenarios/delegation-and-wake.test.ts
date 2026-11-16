import { describe, expect } from "bun:test";
import { scenarioTest, call, loadTools, say, toolResult, useScenarios } from "./harness";

/**
 * Sprint 1 exit scenarios 10 and 12: a bot made in a turn can be used in that
 * turn, and a wake turn (a delegated task finishing) can schedule a job.
 */

const scenarios = useScenarios();

describe("S1-10 create then delegate in the same turn", () => {
  scenarioTest("a bot created by create_agent can be delegated to in the same turn", async () => {
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

describe("S1-22 wake turns do not schedule jobs", () => {
  // Owner decision: a wake carries another bot's untrusted output, so job_schedule stays
  // refused there (allowing it would let one injection persist). The owner's own turn may.
  scenarioTest("a wake turn's job_schedule is refused clearly and creates nothing; an owner turn's succeeds", async () => {
    const s = await scenarios.start();
    const wakeFollowUp = "Check on the warehouse report tomorrow morning (from the wake).";
    const ownerFollowUp = "Check on the warehouse report tomorrow morning (from the owner).";
    const when = new Date(Date.now() + 24 * 3_600_000).toISOString();
    const scheduled = (text: string): { payload: string } | null => s.get<{ payload: string }>(
      "SELECT payload FROM jobs WHERE kind = 'turn' AND json_extract(payload, '$.text') = ?",
      text,
    );

    // Owner turn: delegate research, then say it started.
    s.model.queue(
      call("delegate_task", { toAgentID: "researcher", goal: "Count the pallets in the east warehouse." }, "call_delegate"),
      say("The researcher is counting."),
    );
    const a = await s.connect({ label: "A" });
    const first = await a.startTurn("have the researcher count the pallets");
    await a.waitFor("turn.end", { since: first.since, match: (frame) => frame.turnID === first.turnID, why: "the owner's turn to end" });

    // The researcher's background turn, then the parent's wake turn tries to schedule.
    s.model.queue(
      say("There are 42 pallets."),
      loadTools("job_schedule"),
      call("job_schedule", { text: wakeFollowUp, at: when }, "call_wake_schedule"),
      say("Noted."),
    );
    const wakeRan = (): boolean => s.model.requests.some((request) => toolResult(request, "call_wake_schedule") !== undefined);
    for (let tick = 0; tick < 4 && !wakeRan(); tick += 1) await s.runner().tick();
    expect(wakeRan(), "the wake turn never reached job_schedule").toBe(true);

    const refusal = toolResult(s.model.requests.at(-1)!, "call_wake_schedule") as Record<string, unknown>;
    expect(typeof refusal.error, "the wake's job_schedule must be refused with a message the model can read").toBe("string");
    expect(String(refusal.error)).toMatch(/another agent/i);
    expect(scheduled(wakeFollowUp), "a job was created from a wake turn").toBeNull();

    // The same call from an owner turn works.
    s.model.queue(
      loadTools("job_schedule"),
      call("job_schedule", { text: ownerFollowUp, at: when }, "call_owner_schedule"),
      say("Scheduled."),
    );
    const second = await a.startTurn("remind me about the warehouse report tomorrow");
    await a.waitFor("turn.end", { since: second.since, match: (frame) => frame.turnID === second.turnID, why: "the owner's second turn to end" });
    const ownerResult = toolResult(s.model.requests.at(-1)!, "call_owner_schedule") as Record<string, unknown>;
    expect(ownerResult.error, "job_schedule was refused in an owner turn").toBeUndefined();
    expect(scheduled(ownerFollowUp), "the owner's scheduled job was not created").not.toBeNull();
  });
});
