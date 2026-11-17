/**
 * Sprint 2, fix round J: what a card says, and how the client is told to make the owner read it.
 *
 *  5. A URL on a card is shown as the server will resolve it (the host in punycode, the path escaped), with a "Written as" line when
 *     the model wrote it some other way. This covers a routine's HTTP preflight and the `web_fetch` card.
 *  6. A one-shot job the owner approved is not run at once because its card waited past its time.
 *  7. The audit row of a call a stored rule let through says why the call was not shown whole: the reason, not a fixed one.
 *  8. One schedule check serves the engine, the card and the tool.
 *  9. A card the owner could not take in at a glance (over 2,000 characters or 40 lines) is marked `truncated`: the owner opens the
 *     full text before Allow, and `approval.full` returns the whole preview.
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { previewAction, CARD_BODY_MAX_CHARS } from "../src/agent/card-preview";
import { ApprovalBroker } from "../src/agent/approval-broker";
import { checkSchedule } from "../src/jobs/schedule-check";
import { createJobTools } from "../src/tools/jobs-tool";
import { createRoutineTools } from "../src/tools/routines-tool";
import { decide } from "../src/policy/engine";
import { resetS2Startup } from "../src/startup/s2";
import type { RunContext } from "../src/policy/types";
import { scenarioTest, useScenarios, say } from "./scenarios/harness";
import { allCallsTo, answerCards, call, later, minutes, playTurn, resultJson, scripted, useWeb } from "./invariants/support";
import { policyRig, type PolicyRig } from "./policy-fixture";

const scenarios = useScenarios();
useWeb();
afterEach(() => { setSystemTime(); resetS2Startup(); });

const bot = "Ava";
const at = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();
type Handler = (args: unknown, ctx: unknown) => Promise<{ id?: string; error?: string }>;
const jobHandler = (rig: PolicyRig): Handler => createJobTools(rig.db)[0]!.handler as unknown as Handler;
const ctxOf = (run: RunContext, extra: Record<string, unknown> = {}) => ({ threadID: "thr", turnID: "trn", signal: new AbortController().signal, run, chain: { depth: 1, rootAgentID: "ea", currentAgentID: "ea", handoffSummary: null }, ...extra });

describe("a URL on a card is shown as it will be resolved, and as it was written when that differs", () => {
  const written = "https://bücher.example/Pfad?q=ä";
  const resolved = "https://xn--bcher-kva.example/Pfad?q=%C3%A4";

  test("a routine's HTTP preflight shows the resolved address and the written one", () => {
    const create = { name: "Watch", prompt: "Look.", cron: "0 9 * * *", timezone: "UTC", preflight: { kind: "http", url: written } };
    const preview = previewAction("routine_create", create, bot);
    expect(preview, "the card does not show the address the server will fetch").toContain(`Before each run: it fetches ${resolved}`);
    expect(preview, "the card does not say how the address was written").toContain(`Written as: ${written}`);
  });

  test("an address already in its resolved form has no Written as line", () => {
    const create = { name: "Watch", prompt: "Look.", cron: "0 9 * * *", timezone: "UTC", preflight: { kind: "http", url: "https://example.com/status" } };
    const preview = previewAction("routine_create", create, bot);
    expect(preview).toContain("Before each run: it fetches https://example.com/status");
    expect(preview).not.toContain("Written as:");
  });

  test("a web_fetch card shows the address the server will fetch, with the written form when it differs", () => {
    const preview = previewAction("web_fetch", { url: "HTTPS://Bücher.Example/a b", maxChars: 4_000 }, bot);
    expect(preview).toContain("Fetches: https://xn--bcher-kva.example/a%20b");
    expect(preview).toContain("Written as: HTTPS://Bücher.Example/a b");
    expect(preview, "an argument beside the address is not named").toContain("maxChars = 4000");
  });

  test("a web_fetch address that is already resolved has no Written as line, and one that cannot be read says so", () => {
    expect(previewAction("web_fetch", { url: "https://example.com/a" }, bot)).not.toContain("Written as:");
    const broken = previewAction("web_fetch", { url: "not a url" }, bot);
    expect(broken).toContain("not a url");
    expect(broken).toMatch(/not an address/i);
  });

  test("a confusable host cannot pass for the real one: the owner reads the punycode", () => {
    const preview = previewAction("web_fetch", { url: "https://exаmple.com/login" }, bot);
    expect(preview, "the Cyrillic look-alike was shown as the plain address").toContain("Fetches: https://xn--");
    expect(preview).toContain("Written as: https://exаmple.com/login");
  });
});

// ---------------------------------------------------------------------------
// 6. the owner's yes is for a time that is still ahead
// ---------------------------------------------------------------------------

describe("a one-shot job the owner approved is not run at once because the card waited past its time", () => {
  let rig: PolicyRig | undefined;
  afterEach(() => { rig?.close(); rig = undefined; });
  const jobRun = (r: PolicyRig): RunContext => r.another({ principal: { kind: "job" }, jobID: "job_bot" });
  const jobs = (r: PolicyRig): number => r.db.query("SELECT id FROM jobs WHERE kind = 'turn'").all().length;

  test("the tool re-checks the time when the loop carries the owner's yes: past the grace is refused and nothing is made", async () => {
    rig = policyRig();
    const stale = await jobHandler(rig)({ text: "do it", at: at(-120_000) }, ctxOf(jobRun(rig), { ownerApproved: true }));
    expect(stale.id, "a job whose time passed while its card waited was made and would run at once").toBeUndefined();
    expect(stale.error).toMatch(/already passed|has passed/i);
    expect(stale.error).toMatch(/future/i);
    expect(jobs(rig)).toBe(0);
    // A few seconds behind is "now", as on the card; a time ahead is fine.
    expect((await jobHandler(rig)({ text: "do it", at: at(-30_000) }, ctxOf(jobRun(rig), { ownerApproved: true }))).id).toBeDefined();
    expect((await jobHandler(rig)({ text: "do it", at: at(3_600_000) }, ctxOf(jobRun(rig), { ownerApproved: true }))).id).toBeDefined();
  });

  test("the owner's own turn is not affected: a time just past still runs at once", async () => {
    rig = policyRig();
    expect((await jobHandler(rig)({ text: "do it", at: at(-120_000) }, ctxOf(rig.run))).id).toBeDefined();
  });

  scenarioTest("through the real loop: the owner answers a card after its time went by, and the job is not made", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    s.model.queue(...scripted(true, [call("job_schedule", { text: "Count the pallets.", at: at(-1_000) }, "call_seed"), say("Scheduled.")]));
    await playTurn(s, a, "count the pallets", { answer: () => "once" });
    // The job fires; its call for the next link is put to the owner with a time 30 seconds ahead; the owner takes five minutes.
    const owner = answerCards(a, () => { later(minutes(5)); return "once"; });
    s.model.queue(...scripted(true, [call("job_schedule", { text: "Count them again.", at: at(30_000) }, "call_next"), say("Noted.")]));
    for (let tick = 0; tick < 8 && !allCallsTo(s, "job_schedule", a).some((entry) => entry.callID === "call_next"); tick += 1) await s.runner().tick();
    owner.stop();
    const next = allCallsTo(s, "job_schedule", a).find((entry) => entry.callID === "call_next");
    expect(next, "the job never made the call; the script is out of step").toBeDefined();
    expect(owner.cards.length, "the call was not put to the owner").toBe(1);
    expect(String(resultJson(next).error ?? "(no error)"), "the stale yes was not refused").toMatch(/already passed|has passed/i);
    expect(s.all("SELECT id FROM jobs WHERE payload LIKE '%Count them again.%'")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 7. the audit row says why a rule-approved call was not shown whole
// ---------------------------------------------------------------------------

describe("the audit row of a call a stored rule let through gives the reason it could not be shown whole", () => {
  let rig: PolicyRig | undefined;
  afterEach(() => { rig?.close(); rig = undefined; });
  const rule = { id: "rul_1", agentID: "ea", toolName: "x", createdAt: "2026-11-17T00:00:00Z" };
  const recorded = (r: PolicyRig, tool: string, args: Record<string, unknown>): string => {
    new ApprovalBroker({ db: r.db, emit: () => undefined, waitForDecision: async () => null }).recordRuleApproval("thr", "trn", tool, "call_1", args, { ...rule, toolName: tool });
    return r.db.query<{ preview: string }, []>("SELECT preview FROM approvals ORDER BY created_at DESC, rowid DESC").get()!.preview;
  };

  test("a call too long for a card says it is too long", () => {
    rig = policyRig();
    const preview = recorded(rig, "write_file", { path: "notes.txt", content: "x".repeat(CARD_BODY_MAX_CHARS * 2) });
    expect(preview).toMatch(/too long/i);
    expect(preview).not.toContain("could not be drawn");
  });

  test("a resume of a routine is read from the database, so it is shown whole when the routine is there and named when it is not", async () => {
    rig = policyRig();
    const made = await (createRoutineTools(rig.db)[0]!.handler as unknown as Handler)({ name: "Inbox", prompt: "Check the inbox thoroughly.", cron: "0 9 * * *", timezone: "UTC" }, ctxOf(rig.run)) as unknown as { id: string };
    const whole = recorded(rig, "routine_pause", { id: made.id, enabled: true });
    expect(whole, "the row did not read the routine from the database").toContain("Check the inbox thoroughly.");
    expect(whole).not.toMatch(/too long|could not be drawn/);
    const missing = recorded(rig, "routine_pause", { id: "rtn_nowhere", enabled: true });
    expect(missing, "the row gave a reason that is not the real one").toContain("there is no routine with id");
    expect(missing).not.toContain("too long");
  });
});

// ---------------------------------------------------------------------------
// 8. one schedule check
// ---------------------------------------------------------------------------

describe("one check says whether a job_schedule call could ever be made", () => {
  const ok = { text: "do it", at: at(3_600_000) };

  test("each refusal, in one place", () => {
    expect(checkSchedule(ok, "ea")).toBeNull();
    expect(checkSchedule({ text: "do it" }, "ea"), "a job with no time was not told to say when").toMatch(/say when it should run/);
    expect(checkSchedule({ ...ok, dailyAt: "09:05" }, "ea")).toMatch(/pick one/);
    expect(checkSchedule({ ...ok, agent_id: "researcher" }, "ea")).toMatch(/only schedule jobs for itself/);
    expect(checkSchedule({ ...ok, agent_id: " ea " }, "ea")).toBeNull();
    expect(checkSchedule({ text: "  ", at: ok.at }, "ea")).toMatch(/needs something to do/);
    expect(checkSchedule({ text: "[The owner pressed Stop on my previous request, so I did not finish it. That request is closed.]", at: ok.at }, "ea")).not.toBeNull();
    expect(checkSchedule({ text: "x", at: "next tuesday-ish" }, "ea")).toMatch(/is not a date/);
    expect(checkSchedule({ text: "x", dailyAt: "9am" }, "ea")).not.toBeNull();
    expect(checkSchedule({ text: "x", dailyAt: "09:05", days: ["someday"] }, "ea")).not.toBeNull();
    expect(checkSchedule({ text: "x", everyMinutes: 1 }, "ea")).toMatch(/between 5/);
    expect(checkSchedule({ text: "x", everyMinutes: 30 }, "ea")).toBeNull();
  });

  test("a time already past is a problem only when the caller says what time it is", () => {
    const old = { text: "x", at: at(-120_000) };
    expect(checkSchedule(old, "ea"), "the owner's own turn may schedule a time just past").toBeNull();
    expect(checkSchedule(old, "ea", Date.now())).toMatch(/already passed/);
    expect(checkSchedule({ text: "x", at: at(-30_000) }, "ea", Date.now())).toBeNull();
    expect(checkSchedule({ text: "x", everyMinutes: 30 }, "ea", Date.now())).toBeNull();
  });

  test("the card path says the same thing: a job with no time is told to say when, not that undefined is not a date", () => {
    const rig = policyRig();
    try {
      const decision = decide(rig.another({ principal: { kind: "job" }, jobID: "job_bot" }), { tool: "job_schedule", args: { text: "do it" }, callID: "call_1" });
      expect(decision.action).toBe("refuse");
      if (decision.action === "refuse") expect(decision.error).toMatch(/say when it should run/);
    } finally {
      rig.close();
    }
  });
});
