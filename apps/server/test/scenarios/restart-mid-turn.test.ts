import { describe, expect } from "bun:test";
import { scenarioTest, gate, say, useScenarios, type Scenario } from "./harness";

/**
 * Sprint 1 exit scenario 3 (S1-03): the server is killed while a turn runs.
 *
 * A hard kill leaves `agent_sessions.state = 'running'` and a `turns` row with
 * no end. The crash is SIMULATED by rewriting database state (a finished turn
 * is flipped back to running); nothing is actually killed, because a turn
 * cannot be killed inside the test process. The scenario then boots a new
 * server on the same file. After boot the old turn must be dead and
 * unresumable; the next message must start a new turn under a new ID that the
 * owner can cancel.
 */

const scenarios = useScenarios();

/** One finished turn, rewritten into what a kill -9 mid-turn leaves behind, then a restart. */
async function serverRestartedAfterCrash(s: Scenario): Promise<{ crashedTurnID: string; threadID: string }> {
  s.model.queue(say("Partial work on the first request."));
  const before = await s.connect({ label: "before-crash" });
  const first = await before.startTurn("first request, in flight when the server dies");
  await before.waitFor("turn.end", { match: (frame) => frame.turnID === first.turnID, why: "the first turn to finish" });

  s.db.run("UPDATE agent_sessions SET state = 'running' WHERE thread_id = ?", [first.threadID]);
  s.db.run("UPDATE turns SET state = 'running', stop_reason = NULL, ended_at = NULL WHERE id = ?", [first.turnID]);
  await s.restart();
  return { crashedTurnID: first.turnID, threadID: first.threadID };
}

describe("S1-03 restart mid-turn", () => {
  scenarioTest("after boot the old turn is marked interrupted, not left running", async () => {
    const s = await scenarios.start();
    const { crashedTurnID, threadID } = await serverRestartedAfterCrash(s);

    const session = s.get<{ state: string }>("SELECT state FROM agent_sessions WHERE thread_id = ?", threadID);
    expect(session?.state, "a session the dead process left running must not stay resumable").not.toBe("running");
    expect(session?.state).not.toBe("awaiting_approval");
    const turn = s.get<{ state: string; stop_reason: string | null }>(
      "SELECT state, stop_reason FROM turns WHERE id = ?",
      crashedTurnID,
    );
    expect(turn?.state, "the dead turn is closed").not.toBe("running");
    expect(turn?.stop_reason, "and it did not finish normally").not.toBe("end");
  });

  scenarioTest("the next message starts a new turn under a new ID", async () => {
    const s = await scenarios.start();
    const { crashedTurnID } = await serverRestartedAfterCrash(s);

    s.model.queue(say("Answer to the second request."));
    const after = await s.connect({ label: "after-restart" });
    const second = await after.startTurn("second request, after the restart");

    expect(second.turnID, "the dead turn's ID must not be reused for the next message").not.toBe(crashedTurnID);
    await after.waitFor("turn.end", { match: (frame) => frame.turnID === second.turnID, why: "the new turn to finish" });
  });

  scenarioTest("cancelling the new turn by the ID the server announced works", async () => {
    const s = await scenarios.start();
    await serverRestartedAfterCrash(s);

    const midStream = gate();
    s.model.queue({ text: ["Working on the second request. ", "Still going."], hold: midStream });
    const after = await s.connect({ label: "after-restart" });
    const second = await after.startTurn("second request, which I will stop");
    await s.model.requested(2);

    after.send({ type: "msg.cancel", turnID: second.turnID });

    const end = await after.waitFor("turn.end", {
      match: (frame) => frame.turnID === second.turnID,
      timeoutMs: 2_000,
      why: `turn ${second.turnID} to end after msg.cancel with that same ID`,
    });
    expect(end.stopReason).toBe("cancelled");
  });
});
