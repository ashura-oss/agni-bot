/**
 * Sprint 2, fix round L: what a run hands on across a link, as one value (`policy/carry.ts`).
 *
 * Six places used to pack a run's taint, tools, root, clock and chain by hand, and they disagreed. `packCarried` writes it and
 * `readCarried` reads it back, and the table in carry.ts says what each link does to each property. These tests are that table, one
 * link at a time, and the failing-closed read of whatever storage hands back.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createRunContext, isOwnerMade } from "../src/policy/context";
import { packCarried, readCarried, storedCarried, type Carried } from "../src/policy/carry";
import { briefCarried } from "../src/stores/tasks";
import type { RunContext, TaintSource } from "../src/policy/types";
import { policyRig, type PolicyRig } from "./policy-fixture";

const WEB: TaintSource = { kind: "web", label: "evil.example/page", tool: "web_fetch", at: "2026-11-16T10:00:00Z" };
const TOOLS = ["say", "ask", "web_fetch", "bash", "mail_send"];

describe("ownerOnly: one sticky bit", () => {
  let rig: PolicyRig | undefined;
  afterEach(() => { rig?.close(); rig = undefined; });

  test("the owner's own chat turn starts a chain; nothing else is the owner's by default", () => {
    rig = policyRig();
    expect(rig.run.ownerOnly).toBe(true);
    expect(isOwnerMade(rig.run)).toBe(true);
    for (const input of [
      { principal: { kind: "wake" as const } },
      { principal: { kind: "job" as const }, jobID: "job_x" },
      { principal: { kind: "peer" as const, from: "boss" } },
      { principal: { kind: "routine" as const } },
      // A job's fire runs as the owner, but its bit is on its payload: with none given it is not shown to be the owner's.
      { principal: { kind: "owner" as const }, jobID: "job_owner" },
    ]) {
      expect({ kind: input.principal.kind, owner: isOwnerMade(rig.another(input)) }).toEqual({ kind: input.principal.kind, owner: false });
    }
  });

  test("a bit given by whoever started the run wins over the default", () => {
    rig = policyRig();
    expect(isOwnerMade(rig.another({ principal: { kind: "wake" }, ownerOnly: true }))).toBe(true);
    expect(isOwnerMade(rig.another({ principal: { kind: "owner" }, jobID: "job_owner", ownerOnly: true }))).toBe(true);
    expect(isOwnerMade(rig.another({ principal: { kind: "owner" }, ownerOnly: false }))).toBe(false);
  });

  test("only a true bit counts: anything else, and no run at all, is not the owner's", () => {
    rig = policyRig();
    for (const bad of [undefined, "yes", "true", 1, null, {}, []]) {
      expect({ bad, owner: isOwnerMade({ ...rig.run, ownerOnly: bad } as unknown as RunContext) }).toEqual({ bad, owner: false });
    }
    expect(isOwnerMade(undefined)).toBe(false);
  });
});

describe("readCarried fails closed", () => {
  test("nothing readable is the worst: not the owner's, cut to nothing, no root", () => {
    for (const value of [undefined, null, "owner", 7, true, [], [true]]) {
      const read = readCarried(value);
      expect({ value, ownerOnly: read.ownerOnly, capabilities: read.capabilities, root: read.rootTurnID }).toEqual({ value, ownerOnly: false, capabilities: null, root: undefined });
    }
  });

  test("the owner's bit is only an explicit true", () => {
    expect(readCarried({ ownerOnly: true }).ownerOnly).toBe(true);
    for (const bad of [false, "true", 1, null, {}, [true]]) expect(readCarried({ ownerOnly: bad }).ownerOnly).toBe(false);
  });

  test("taint: a list (even an empty one) is what the sender read; anything else is one unknown source", () => {
    expect(readCarried({ taint: [] }).taint).toEqual([]);
    expect(readCarried({ taint: [WEB] }).taint).toEqual([WEB]);
    for (const bad of ["web", 7, null, {}, [{ kind: "nonsense", label: 4 }]]) {
      const taint = readCarried({ taint: bad }).taint;
      expect({ bad, kinds: taint.map((source) => source.kind) }).toEqual({ bad, kinds: ["unknown"] });
    }
  });

  test("a delegated child whose sender did not say what it had read is as tainted as an unknown source", () => {
    expect(readCarried({ delegationTaskID: "tsk_1" }).taint.map((source) => source.kind)).toEqual(["unknown"]);
    expect(readCarried({ delegationTaskID: "tsk_1", taint: [] }).taint).toEqual([]);
  });

  test("capabilities: a readable list is the tools the sender could call; one that is not reads as unreadable (the inert tools only)", () => {
    expect(readCarried({ capabilities: ["say", "ask"] }).capabilities).toEqual(["say", "ask"]);
    expect(readCarried({ capabilities: [] }).capabilities).toEqual([]);
    for (const bad of ["everything", 7, null, {}, [1, 2], [""], undefined]) expect(readCarried({ capabilities: bad }).capabilities).toBeNull();
  });

  test("narrowed: said outright, or by a payload that predates it having a list of tools (even an unreadable one)", () => {
    expect(readCarried({ narrowed: true }).narrowed).toBe(true);
    expect(readCarried({ narrowed: false, capabilities: ["say"] }).narrowed).toBe(false);
    expect(readCarried({ capabilities: ["say"] }).narrowed).toBe(true);
    expect(readCarried({ capabilities: "everything" }).narrowed).toBe(true);
    expect(readCarried({}).narrowed).toBe(false);
  });

  test("the root, the refusal scope, the clock and the chain are read only when they are non-empty strings", () => {
    expect(readCarried({ rootTurnID: "trn_1", rootJob: "job_1", denialRoot: "job_0", clockKey: "clk", chainID: "chn" })).toMatchObject({
      rootTurnID: "trn_1", rootJob: "job_1", denialRoot: "job_0", clockKey: "clk", chainID: "chn",
    });
    expect(readCarried({ rootTurnID: "trn_1" }).rootJob).toBeNull();
    const none = readCarried({ rootTurnID: "", denialRoot: 4, clockKey: null, chainID: [] });
    expect([none.rootTurnID, none.denialRoot, none.clockKey, none.chainID]).toEqual([undefined, undefined, undefined, undefined]);
  });

  test("a brief or a wake that does not say whether its run was cut reads as cut, to tools nobody can read", () => {
    // They come from a delegation, which always cuts the delegate; a record from before `narrowed` existed must not read as free.
    expect(briefCarried(JSON.stringify({ taint: [WEB], ownerOnly: true }))).toMatchObject({ narrowed: true, capabilities: null });
    expect(briefCarried(JSON.stringify({ capabilities: ["say"] }))).toMatchObject({ narrowed: true, capabilities: ["say"] });
    expect(briefCarried(null)).toMatchObject({ narrowed: true, capabilities: null });
    expect(briefCarried("not json")).toMatchObject({ narrowed: true, capabilities: null });
    expect(briefCarried(JSON.stringify({ narrowed: false }))).toMatchObject({ narrowed: false });
    expect(briefCarried(JSON.stringify({ narrowed: true, capabilities: ["say", "ask"] }))).toMatchObject({ narrowed: true, capabilities: ["say", "ask"] });
    expect(readCarried({ wakeKey: "wake:t", results: [{ ownerOnly: true }] })).toMatchObject({ narrowed: true, capabilities: null });
    expect(readCarried({ wakeKey: "wake:t", narrowed: false, results: [{ narrowed: false }] }).narrowed).toBe(false);
    expect(readCarried({ wakeKey: "wake:t", narrowed: false, results: [{ narrowed: false }, { ownerOnly: true }] })).toMatchObject({ narrowed: true, capabilities: null });
    // A job that is neither keeps its own reading: no tool list is not narrowed (s2-legacy-jobs.test.ts).
    expect(readCarried({ scheduledBy: "bot" }).narrowed).toBe(false);
  });

  test("a wake is the owner's only if every task it is told about is", () => {
    const wake = (results: unknown[], ownerOnly = true) => readCarried({ wakeKey: "wake:t", ownerOnly, results });
    expect(wake([{ ownerOnly: true }, { ownerOnly: true }]).ownerOnly).toBe(true);
    expect(wake([{ ownerOnly: true }, { ownerOnly: false }]).ownerOnly).toBe(false);
    expect(wake([{ ownerOnly: true }, {}]).ownerOnly).toBe(false);
    expect(wake([{ ownerOnly: true }, "junk"]).ownerOnly).toBe(false);
    expect(wake([{ ownerOnly: true }], false).ownerOnly).toBe(false);
  });
});

describe("packCarried: what each link does", () => {
  let rig: PolicyRig | undefined;
  afterEach(() => { rig?.close(); rig = undefined; });

  /** A run that read a web page, was cut to a few tools, has a root, a refusal scope and a clock of its own. */
  const richRun = (r: PolicyRig, input: Partial<Parameters<typeof createRunContext>[0]> = {}): RunContext =>
    r.another({ principal: { kind: "peer", from: "boss" }, rootTurnID: "trn_root", rootJob: "job_root", denialRoot: "job_scope", clockKey: "clk_parent", capabilities: TOOLS, narrowed: true, taint: [WEB], ...input });

  test("a delegation hands on what the run read, its tools, its root, scope and clock, and the chain it is in", () => {
    rig = policyRig();
    const carried = packCarried(richRun(rig), "delegate", { chainID: "chn_1" });
    expect(carried).toMatchObject({
      taint: [WEB], narrowed: true, rootTurnID: "trn_root", rootJob: "job_root", denialRoot: "job_scope", clockKey: "clk_parent", chainID: "chn_1", ownerOnly: false,
    });
    expect([...carried.capabilities!].sort()).toEqual([...TOOLS].sort());
  });

  test("a handoff is the same link in the same process", () => {
    rig = policyRig();
    expect(packCarried(richRun(rig), "handoff")).toEqual(packCarried(richRun(rig), "delegate"));
  });

  test("the owner's own turn hands the chain on as it is; any run a bot started clears it", () => {
    rig = policyRig();
    expect(packCarried(rig.run, "delegate").ownerOnly).toBe(true);
    expect(packCarried(rig.another({ principal: { kind: "owner" }, jobID: "job_owner", ownerOnly: true }), "delegate").ownerOnly).toBe(true);
    for (const principal of [{ kind: "wake" as const }, { kind: "peer" as const, from: "boss" }, { kind: "job" as const }, { kind: "routine" as const }]) {
      expect({ principal: principal.kind, ownerOnly: packCarried(rig.another({ principal, jobID: "job_x", ownerOnly: true }), "delegate").ownerOnly }).toEqual({ principal: principal.kind, ownerOnly: false });
    }
  });

  test("a run that read nothing hands on an empty list, not a missing one", () => {
    rig = policyRig();
    expect(packCarried(rig.run, "delegate").taint).toEqual([]);
    expect(packCarried(rig.run, "schedule-once").taint).toEqual([]);
  });

  test("a job is always a bot's link, keeps the run's refusal scope, and starts a clock and a chain of its own", () => {
    rig = policyRig();
    for (const link of ["schedule-once", "schedule-recurring"] as const) {
      const carried = packCarried(richRun(rig, { ownerOnly: true, principal: { kind: "owner" }, jobID: "job_fire" }), link);
      expect({ link, ownerOnly: carried.ownerOnly, denialRoot: carried.denialRoot, clockKey: carried.clockKey, chainID: carried.chainID, taint: carried.taint }).toEqual({ link, ownerOnly: false, denialRoot: "job_scope", clockKey: undefined, chainID: undefined, taint: [WEB] });
    }
  });

  test("a job from a run that was not narrowed carries no tool list; from one that was, that run's", () => {
    rig = policyRig();
    expect(packCarried(rig.another({ principal: { kind: "owner" } }), "schedule-once")).toMatchObject({ narrowed: false, capabilities: null });
    const cut = packCarried(richRun(rig), "schedule-recurring");
    expect(cut.narrowed).toBe(true);
    expect([...cut.capabilities!].sort()).toEqual([...TOOLS].sort());
  });

  test("a one-shot job stays in the request it was made in, unless the owner's chat turn made it; a repeating job never does", () => {
    rig = policyRig();
    const inRequest = richRun(rig);
    expect(packCarried(inRequest, "schedule-once")).toMatchObject({ rootTurnID: "trn_root", rootJob: "job_root" });
    expect(packCarried(inRequest, "schedule-recurring").rootTurnID).toBeUndefined();
    expect(packCarried(rig.run, "schedule-once").rootTurnID, "the owner's chat turn is a root of its own").toBeUndefined();
    expect(packCarried(rig.another({ principal: { kind: "owner" }, jobID: "job_owner", rootTurnID: "trn_root", rootJob: "job_owner" }), "schedule-once")).toMatchObject({ rootTurnID: "trn_root", rootJob: "job_owner" });
  });

  test("a wake and a resumed run come from the brief: its root, scope and chain, a clock of their own, and the bit as the brief had it", () => {
    const brief: Carried = { taint: [WEB], narrowed: true, capabilities: TOOLS, rootTurnID: "trn_root", rootJob: null, denialRoot: "job_scope", clockKey: "clk_parent", chainID: "chn_1", ownerOnly: true };
    const wake = packCarried(brief, "wake");
    expect(wake).toMatchObject({ rootTurnID: "trn_root", rootJob: null, denialRoot: "job_scope", chainID: "chn_1", ownerOnly: true, taint: [] });
    expect(wake.clockKey).toBeUndefined();
    // A wake is cut to the tools of the run that delegated, when that run was cut.
    expect({ narrowed: wake.narrowed, capabilities: wake.capabilities }).toEqual({ narrowed: true, capabilities: TOOLS });
    const resume = packCarried(brief, "resume", { taint: [WEB] });
    expect(resume).toMatchObject({ rootTurnID: "trn_root", denialRoot: "job_scope", chainID: "chn_1", ownerOnly: true, taint: [WEB], narrowed: true });
    expect([...resume.capabilities!].sort()).toEqual([...TOOLS].sort());
    expect(resume.clockKey).toBeUndefined();
    expect(packCarried({ ...brief, ownerOnly: false }, "resume", { taint: [] }).ownerOnly).toBe(false);
  });

  test("a resumed task with no record of what it read is tainted", () => {
    expect(packCarried(readCarried({}), "resume").taint.map((source) => source.kind)).toEqual(["unknown"]);
  });

  test("a link made by something with no record of itself is the worst on every count", () => {
    for (const link of ["delegate", "handoff", "schedule-once", "schedule-recurring", "wake", "resume"] as const) {
      const carried = packCarried(undefined, link);
      expect({ link, ownerOnly: carried.ownerOnly, root: carried.rootTurnID }).toEqual({ link, ownerOnly: false, root: undefined });
    }
    for (const link of ["delegate", "handoff", "schedule-once", "schedule-recurring"] as const) {
      const carried = packCarried(undefined, link);
      expect({ link, taint: carried.taint.map((source) => source.kind), narrowed: carried.narrowed, capabilities: carried.capabilities }).toEqual({ link, taint: ["unknown"], narrowed: true, capabilities: null });
    }
  });

  test("a run whose record cannot be read hands on one unknown source and no tools", () => {
    rig = policyRig();
    const broken = { ...rig.run, taint: undefined, effectiveCapabilities: undefined } as unknown as RunContext;
    const carried = packCarried(broken, "delegate");
    expect(carried.taint.map((source) => source.kind)).toEqual(["unknown"]);
    expect(carried.capabilities).toBeNull();
  });

  test("what is stored reads back as what was packed, and a set that cannot be read is not written", () => {
    rig = policyRig();
    const carried = packCarried(richRun(rig), "delegate", { chainID: "chn_1" });
    expect(readCarried(JSON.parse(JSON.stringify(storedCarried(carried))))).toEqual(carried);
    const unreadable = packCarried(undefined, "delegate");
    expect("capabilities" in storedCarried(unreadable)).toBe(false);
    expect(readCarried(storedCarried(unreadable)).capabilities).toBeNull();
  });
});
