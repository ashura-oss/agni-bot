import { describe, expect } from "bun:test";
import { scenarioTest, eventually, gate, useScenarios } from "./harness";

/**
 * Sprint 1 exit scenarios 1 and 2: a turn belongs to the server, not to the
 * socket that started it. Reloading a tab must not kill it, and Stop must work
 * from any device.
 */

const scenarios = useScenarios();

describe("S1-01 reload mid-turn", () => {
  scenarioTest("a turn survives its socket closing; the client resyncs and gets the rest", async () => {
    const s = await scenarios.start();
    const midStream = gate();
    s.model.queue({ text: ["First half of the answer. ", "Second half of the answer."], hold: midStream });

    const a = await s.connect({ label: "A" });
    const { turnID } = await a.startTurn("tell me a story in two parts");
    // The first token reached the browser; now the tab reloads (the socket closes).
    await a.waitFor("token", { match: (frame) => frame.delta.includes("First half"), why: "the first token" });
    const lastSeenSeq = a.lastSeq;
    a.close();
    await a.closed;
    await s.barrier();

    // The model carries on with nobody watching.
    midStream.open();
    await eventually(
      () => s.get<{ state: string }>("SELECT state FROM turns WHERE id = ?", turnID)?.state === "done",
      { label: "the turn has finished on the server" },
    );

    const turn = s.get<{ stop_reason: string }>("SELECT stop_reason FROM turns WHERE id = ?", turnID);
    expect(turn?.stop_reason, "the turn the closed socket started must end normally, not cancelled").toBe("end");

    // The reloaded client resyncs from the last frame it saw and receives everything it missed.
    const a2 = await s.connect({ label: "A-reloaded", resyncFrom: lastSeenSeq });
    const end = await a2.waitFor("turn.end", { match: (frame) => frame.turnID === turnID, why: "the missed turn.end in the resync" });
    expect(end.stopReason).toBe("end");
    const missedTokens = a2.framesOf("token").map((frame) => frame.delta).join("");
    expect(missedTokens).toContain("Second half of the answer.");
  });
});

describe("S1-02 stop from a second device", () => {
  scenarioTest("msg.cancel from device B stops the turn device A started", async () => {
    const s = await scenarios.start();
    const midStream = gate();
    s.model.queue({ text: ["Working on it. ", "Still working."], hold: midStream });

    const a = await s.connect({ label: "A-phone" });
    const b = await s.connect({ label: "B-laptop", token: await s.pairDevice("laptop") });
    const { turnID } = await a.startTurn("start something that takes a while");
    await s.model.requested(1);
    // B learns the turn from the broadcast, like a second open tab would.
    const seenByB = await b.waitFor("turn.start", { match: (frame) => frame.turnID === turnID, why: "B seeing the turn start" });

    b.send({ type: "msg.cancel", turnID: seenByB.turnID });

    const end = await a.waitFor("turn.end", {
      match: (frame) => frame.turnID === turnID,
      timeoutMs: 2_000,
      why: "the turn to end after B cancelled it",
    });
    expect(end.stopReason).toBe("cancelled");
  });
});
