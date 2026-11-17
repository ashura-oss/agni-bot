/**
 * A policy test rig: an in-memory database, the full tool registry a turn
 * builds (static tools and the per-turn ones), and a run context over it.
 * Shared by the policy tests; not a test file itself.
 */
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db";
import { buildTaskToolRegistry, registerLoadTools } from "../src/tools/task-registry";
import { registerTurnTools } from "../src/tools/turn-tools";
import type { ToolRegistry } from "../src/tools/registry";
import { defaultResolvedPersona } from "../src/agent/personas";
import { rootGuardrail } from "../src/agent/guardrails";
import { startClock } from "../src/agent/run-clock";
import { createRunContext, type RunContextInput } from "../src/policy/context";
import type { RunContext } from "../src/policy/types";
import { TOOL_POLICY } from "../src/policy/metadata";
import type { Router } from "../src/models/router";
import { createThread } from "../src/stores/threads";

export interface PolicyRig {
  db: Database;
  registry: ToolRegistry;
  run: RunContext;
  scratch: string;
  /** Make another run over the same database and tools. */
  another(input?: Partial<RunContextInput>): RunContext;
  close(): void;
}

export function policyRig(options: Partial<RunContextInput> = {}): PolicyRig {
  const db = openDatabase(":memory:");
  const root = mkdtempSync(join(tmpdir(), "agni-policy-"));
  const scratch = join(root, "scratch");
  mkdirSync(scratch, { recursive: true });
  const saved = process.env.AGNI_SCRATCH_DIR;
  process.env.AGNI_SCRATCH_DIR = scratch;
  const registry = buildTaskToolRegistry(db);
  const persona = defaultResolvedPersona(db);
  registerTurnTools(registry, {
    db, router: null as unknown as Router, settings: { firstTokenTimeoutMs: 1, turnTimeoutMs: 1 }, emit: () => undefined,
    signal: new AbortController().signal, threadID: "thr_policy", turnID: "trn_policy", persona,
    guardrail: rootGuardrail(persona.id), formBroker: null as never, onNeedsInput: () => undefined,
    // Registered too, so the table is checked against every tool a turn can have.
    delegation: { taskID: "tsk_policy", ownerAgentID: persona.id, parentAgentID: null, parentChannelID: null },
  });
  registerLoadTools(registry, [], new Set());
  const base: RunContextInput = {
    db, bot: persona.id, threadID: "thr_policy", turnID: "trn_policy", principal: { kind: "owner" },
    capabilities: registry.list().map((tool) => tool.name), registry,
  };
  const another = (input: Partial<RunContextInput> = {}): RunContext => createRunContext({ ...base, ...options, ...input });
  return {
    db, registry, scratch, run: another(), another,
    close: () => {
      db.close();
      if (saved === undefined) delete process.env.AGNI_SCRATCH_DIR; else process.env.AGNI_SCRATCH_DIR = saved;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Every tool name a parent could hold: the table's tools (the per-turn ones included) and whatever the registry
 * has built (MCP tools among them). Pass it as a child's `policy.capabilities` so a test of the child is not cut down
 * to the inert tools, which is what a child with no readable parent gets.
 */
export function fullCapabilities(db: Database): string[] {
  return [...new Set([...Object.keys(TOOL_POLICY), ...buildTaskToolRegistry(db).list().map((tool) => tool.name)])];
}

/**
 * A turn row and a started clock for a run a test builds by hand. A run's time limit counts from the start of its
 * clock, and a run whose clock cannot be found is stopped, so a hand-made root must have both, like a real one.
 */
export function seedRootTurn(db: Database, turnID: string): void {
  startClock(db, turnID);
  if (db.query("SELECT 1 FROM turns WHERE id = ?").get(turnID)) return;
  const thread = createThread(db, "ea");
  db.run("INSERT INTO turns (id, thread_id, agent_id, state, started_at) VALUES (?, ?, 'ea', 'running', ?)", [turnID, thread.id, new Date().toISOString()]);
}

/** A parent run that can call every tool: what the owner's own assistant turn holds. Pass it as the `run` of a handoff. */
export function fullCapabilityRun(db: Database, input: Partial<RunContextInput> = {}): RunContext {
  seedRootTurn(db, input.clockKey ?? input.rootTurnID ?? input.turnID ?? "trn_parent");
  return createRunContext({
    db, bot: "ea", threadID: "thr_parent", turnID: "trn_parent", principal: { kind: "owner" },
    capabilities: fullCapabilities(db), registry: buildTaskToolRegistry(db), ...input,
  });
}
