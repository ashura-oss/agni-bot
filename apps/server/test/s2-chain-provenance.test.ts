/**
 * Sprint 2, fix round K: where a chain of work came from.
 *
 * A run counts as the owner's own only if its chain started with the owner (the owner's chat turn, or a job the owner made) and no link
 * since was made by a bot. That is one flag pair carried forward on every payload and brief, never cleared, never looked up from a root
 * job's row. Anything missing or unreadable reads as a bot's.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createRunContext } from "../src/policy/context";
import { OWNER_STARTED, UNKNOWN_PROVENANCE, handedProvenance, isOwnerMade, mergeProvenance, packProvenance, readProvenance, scheduledProvenance } from "../src/policy/provenance";
import type { RunContext } from "../src/policy/types";
import { policyRig, type PolicyRig } from "./policy-fixture";

describe("the chain's provenance is read back failing closed", () => {
  test("only an explicit owner marker and an explicit false botChained read as the owner's", () => {
    expect(readProvenance({ ownerStarted: true, botChained: false })).toEqual(OWNER_STARTED);
    expect(readProvenance({ ownerStarted: true, botChained: true })).toEqual({ ownerStarted: true, botChained: true });
  });

  test("a value that is missing, not an object, or half-written is a bot's: no marker, bot-chained", () => {
    for (const value of [undefined, null, "owner", 7, true, [], [true], {}, { ownerStarted: "yes", botChained: false }, { botChained: false }]) {
      expect({ value, read: readProvenance(value) }).toEqual({ value, read: UNKNOWN_PROVENANCE });
    }
    // A marker with no explicit "no bot link" is still not the owner's work.
    for (const value of [{ ownerStarted: true }, { ownerStarted: true, botChained: "no" }, { ownerStarted: true, botChained: null }]) {
      expect({ value, read: readProvenance(value) }).toEqual({ value, read: { ownerStarted: true, botChained: true } });
    }
  });

  test("merging is sticky: the chain is the owner's only if every part is, and one bot link marks all of it", () => {
    expect(mergeProvenance(OWNER_STARTED, OWNER_STARTED)).toEqual(OWNER_STARTED);
    expect(mergeProvenance(OWNER_STARTED, { ownerStarted: true, botChained: true })).toEqual({ ownerStarted: true, botChained: true });
    expect(mergeProvenance(OWNER_STARTED, UNKNOWN_PROVENANCE)).toEqual(UNKNOWN_PROVENANCE);
    expect(mergeProvenance()).toEqual(UNKNOWN_PROVENANCE);
  });
});

describe("a run starts with the provenance its front door gives it", () => {
  let rig: PolicyRig | undefined;
  afterEach(() => { rig?.close(); rig = undefined; });

  test("the owner's own chat turn (the owner, no job behind it) starts a chain; nothing else is the owner's by default", () => {
    rig = policyRig();
    expect(rig.run.ownerStarted).toBe(true);
    expect(rig.run.botChained).toBe(false);
    expect(isOwnerMade(rig.run)).toBe(true);
    for (const input of [
      { principal: { kind: "wake" as const } },
      { principal: { kind: "job" as const }, jobID: "job_x" },
      { principal: { kind: "peer" as const, from: "boss" } },
      { principal: { kind: "routine" as const } },
      // An owner-made job fires as the owner, but its marker is on its payload: with none given it is not shown to be the owner's.
      { principal: { kind: "owner" as const }, jobID: "job_owner" },
    ]) {
      const run = rig.another(input);
      expect({ kind: input.principal.kind, owner: isOwnerMade(run) }).toEqual({ kind: input.principal.kind, owner: false });
      expect(run.botChained, "a run with no record of its chain was not treated as a bot's").toBe(true);
    }
  });

  test("a provenance given by whoever started the run wins over the default", () => {
    rig = policyRig();
    expect(isOwnerMade(rig.another({ principal: { kind: "wake" }, provenance: OWNER_STARTED }))).toBe(true);
    expect(isOwnerMade(rig.another({ principal: { kind: "owner" }, jobID: "job_owner", provenance: OWNER_STARTED }))).toBe(true);
    expect(isOwnerMade(rig.another({ principal: { kind: "owner" }, provenance: { ownerStarted: true, botChained: true } }))).toBe(false);
  });

  test("a run whose flags cannot be read is not the owner's, and packs as a bot's", () => {
    rig = policyRig();
    const broken = { ...rig.run, ownerStarted: "yes", botChained: undefined } as unknown as RunContext;
    expect(isOwnerMade(broken)).toBe(false);
    expect(packProvenance(broken)).toEqual(UNKNOWN_PROVENANCE);
    expect(isOwnerMade(undefined)).toBe(false);
  });
});

describe("what a link hands on", () => {
  let rig: PolicyRig | undefined;
  afterEach(() => { rig?.close(); rig = undefined; });

  test("a job a run schedules is always bot-made; it keeps the marker the run's chain had", () => {
    rig = policyRig();
    expect(scheduledProvenance(rig.run)).toEqual({ ownerStarted: true, botChained: true });
    expect(scheduledProvenance(rig.another({ principal: { kind: "wake" } }))).toEqual(UNKNOWN_PROVENANCE);
    expect(scheduledProvenance(undefined)).toEqual(UNKNOWN_PROVENANCE);
  });

  test("a delegation or a handoff from the owner's own turn keeps the chain the owner's; from any other run it is a bot's link", () => {
    rig = policyRig();
    expect(handedProvenance(rig.run)).toEqual(OWNER_STARTED);
    // An owner-made job fire (a job the owner made, with its marker) is the owner's too.
    expect(handedProvenance(rig.another({ principal: { kind: "owner" }, jobID: "job_owner", provenance: OWNER_STARTED }))).toEqual(OWNER_STARTED);
    // A run a bot started (a wake, a bot's brief, a fire of a bot's job) hands on a chain marked as a bot's, even when the owner started it.
    expect(handedProvenance(rig.another({ principal: { kind: "wake" }, provenance: OWNER_STARTED }))).toEqual({ ownerStarted: true, botChained: true });
    expect(handedProvenance(rig.another({ principal: { kind: "peer", from: "boss" }, provenance: OWNER_STARTED }))).toEqual({ ownerStarted: true, botChained: true });
    expect(handedProvenance(rig.another({ principal: { kind: "job" }, jobID: "job_bot", provenance: OWNER_STARTED }))).toEqual({ ownerStarted: true, botChained: true });
    // Never cleared: a chain already marked stays marked, whoever hands it on.
    expect(handedProvenance(rig.another({ principal: { kind: "owner" }, provenance: { ownerStarted: true, botChained: true } }))).toEqual({ ownerStarted: true, botChained: true });
    expect(handedProvenance(undefined)).toEqual(UNKNOWN_PROVENANCE);
  });
});

// The factory itself must not guess from the principal alone for a run it is told about.
test("createRunContext takes a provenance that is a plain value, never a reference the caller can change later", () => {
  const rig = policyRig();
  try {
    const given = { ownerStarted: true, botChained: false };
    const run = createRunContext({ db: rig.db, bot: "ea", threadID: "t", turnID: "u", principal: { kind: "wake" }, capabilities: [], registry: rig.registry, provenance: given });
    given.botChained = true;
    expect(isOwnerMade(run)).toBe(true);
  } finally {
    rig.close();
  }
});
