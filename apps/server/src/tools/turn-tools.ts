/**
 * The tools a turn registers for itself because they need the live turn: its
 * emit, its abort signal, its guardrail state, the owner-facing brokers. The
 * static ones are built by `buildTaskToolRegistry`; this is everything else.
 * Kept in one place so the loop and the policy tests build the same set.
 */
import type { Database } from "bun:sqlite";
import type { ServerFrameBody } from "@agni/protocol";
import type { Router } from "../models/router";
import type { ResolvedPersona } from "../agent/personas";
import type { FormBroker } from "../agent/form-broker";
import type { GuardrailState } from "../agent/guardrails";
import type { TaskTurnSettings } from "../agent/task-loop";
import type { ToolRegistry } from "./registry";
import { registerHandoffTool } from "./handoff-tool";
import { registerDelegateTaskTool } from "./delegate-task-tool";
import { registerAskTool, registerDraftEmailTool, type AskToolDeps } from "./ask-tool";
import { registerRequestOwnerInputTool } from "./needs-input-tool";
import { registerArtifactTool } from "./artifact-tool";
import { registerSecureExecTool } from "./secure-exec-tool";
import { registerSayTool } from "./say-tool";
import { registerScratchTools } from "./scratch-tool";
import { registerRenameTool } from "./rename-tool";
import { registerCreateAgentTool } from "./create-agent-tool";
import { createUpdateAgentTool } from "./update-agent-tool";
import { registerExpandTool } from "./expand-tool";

export interface TurnToolDeps {
  db: Database;
  router: Router;
  settings: TaskTurnSettings;
  emit: (frame: ServerFrameBody) => void;
  signal: AbortSignal;
  threadID: string;
  turnID: string;
  channelID?: string;
  conversationID?: string;
  persona: ResolvedPersona;
  guardrail: GuardrailState;
  formBroker: FormBroker;
  /** The critic pass for `draft_email`. */
  review?: AskToolDeps["review"];
  /** Set for a delegated turn: the task it belongs to. */
  delegation?: { taskID: string; ownerAgentID: string; parentAgentID: string | null; parentChannelID: string | null };
  /** A delegated task asked the owner a question: the turn ends and waits. */
  onNeedsInput: () => void;
}

export function registerTurnTools(registry: ToolRegistry, deps: TurnToolDeps): void {
  const { db, emit, persona } = deps;
  // The handoff tool needs the live emit/signal/guardrail; register it per
  // turn so it can spawn a delegated child in the same thread.
  registerHandoffTool(registry, {
    db, router: deps.router, settings: deps.settings, emit, signal: deps.signal,
    threadID: deps.threadID, channelID: deps.channelID, currentAgentID: persona.id,
    conversationID: deps.conversationID, guardrail: deps.guardrail,
  });
  // The agent can put a question to the owner, and can put an email draft up
  // for approval. Both wait for the owner, so both are registered per turn.
  registerAskTool(registry, { db, broker: deps.formBroker });
  registerDraftEmailTool(registry, { db, broker: deps.formBroker, review: deps.review });
  // DEL-001: the async sibling of handoff. It returns as soon as the task is
  // queued; the specialist runs in a background session with only the brief.
  registerDelegateTaskTool(registry, {
    db, emit, currentAgentID: persona.id, channelID: deps.channelID, parentTurnID: deps.turnID,
    parentThreadID: deps.threadID, chainID: deps.guardrail.chainID,
  });
  // DEL-006: a delegated task can ask the owner a question and wait. The
  // tool is only registered for a delegated turn, and the turn stops with
  // `needs_input` once the question is asked.
  if (deps.delegation) {
    registerScratchTools(registry, { db, taskID: deps.delegation.taskID, agentID: persona.id });
    registerRequestOwnerInputTool(registry, {
      db,
      emit,
      task: {
        id: deps.delegation.taskID,
        ownerAgentID: deps.delegation.ownerAgentID,
        parentAgentID: deps.delegation.parentAgentID,
        parentChannelID: deps.delegation.parentChannelID,
      },
      onNeedsInput: deps.onNeedsInput,
    });
  }
  // Separate progress bubbles, and a one-time password prompt that never
  // reaches the model. Both are per-turn because they need the live emit.
  registerSayTool(registry, { db, emit, threadID: deps.threadID, turnID: deps.turnID, channelID: deps.channelID, persona });
  registerSecureExecTool(registry, { emit, threadID: deps.threadID, conversationID: deps.conversationID });
  // Renaming is an action, not a sentence: this persists the new name and
  // pushes `agent.updated` so every client's roster follows in the same turn.
  registerRenameTool(registry, { db, emit, currentAgentID: persona.id });
  // DEL-004: the full result of a delegated task, read through the same
  // visibility filter as everything else.
  registerArtifactTool(registry, { db, currentAgentID: persona.id });
  // ASM-005: a reference is a pointer; this is how the model follows it.
  registerExpandTool(registry, { db, currentAgentID: persona.id });
  // Redefining an agent is an action too: the owner's words become the
  // agent's role and prompt, durably.
  registry.register(createUpdateAgentTool({ db, emit }));
  registerCreateAgentTool(registry, { db, emit });
}
