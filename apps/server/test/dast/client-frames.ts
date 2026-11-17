/**
 * One schema-valid example of every client frame, for the DAST suite. A frame
 * that fails the schema is refused as `bad_frame` before the auth gate is ever
 * reached, which would let a missing gate go unnoticed. `frames-auth.dast.test.ts`
 * checks this table against `ClientFrameSchema`, so a new frame type added to
 * the protocol without an entry here fails that test.
 *
 * Not a test file (no `.test.`), so bun does not collect it.
 */
import { DECISIONS, JOB_ACTIONS, PROTOCOL_VERSION, type ClientFrame } from "@agni/protocol";

const GRADIENT_PROFILE = {
  version: 1 as const,
  id: "theme_dast",
  name: "DAST",
  mode: "dark" as const,
  preset: "agni" as const,
  accent: "ember" as const,
  background: { kind: "none" as const },
  textScale: "default" as const,
  density: "comfortable" as const,
  corners: "standard" as const,
  motion: "system" as const,
  agentTint: "full" as const,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

/** Every client frame type except `hello`, which is the handshake itself. */
export const FRAMES_NEEDING_AUTH: ClientFrame[] = [
  { type: "provider.auth.status", providerID: "chatgpt" },
  { type: "provider.auth.start", providerID: "chatgpt" },
  { type: "provider.auth.cancel", providerID: "chatgpt", loginID: "login_x" },
  { type: "provider.auth.disconnect", providerID: "chatgpt", accountID: "acct_x" },
  { type: "provider.auth.select", providerID: "chatgpt", accountID: "acct_x" },
  { type: "provider.auth.acknowledge", providerID: "chatgpt", accountID: "acct_x" },
  { type: "resync", lastSeq: 0 },
  { type: "msg.send", threadID: "", text: "unauthenticated hello" },
  { type: "msg.cancel", turnID: "trn_x" },
  { type: "approve.reply", requestID: "apr_x", decision: DECISIONS[0]! },
  { type: "secret.reply", requestID: "sec_x", value: "hunter2" },
  { type: "secret.cancel", requestID: "sec_x" },
  { type: "agent.select", agentID: "ea" },
  { type: "conversation.open", conversationID: "", agentID: "ea" },
  { type: "session.new", conversationID: "cnv_x" },
  { type: "conversation.history", conversationID: "cnv_x" },
  { type: "thread.open", threadID: "thr_x" },
  { type: "thread.export", conversationID: "cnv_x" },
  { type: "thread.list" },
  { type: "thread.history", threadID: "thr_x" },
  { type: "job.list" },
  { type: "job.set", jobID: "job_x", action: JOB_ACTIONS[0]! },
  { type: "approval.rules.list" },
  { type: "approval.rule.revoke", id: "rul_x" },
  { type: "routine.domains.set", jobID: "job_x", domains: ["evil.example"] },
  { type: "job.delete", jobID: "job_x" },
  { type: "task.list" },
  { type: "task.create", title: "unauthenticated task" },
  { type: "task.list.create", name: "unauthenticated list" },
  { type: "task.activity", taskID: "tsk_x" },
  { type: "memory.list" },
  { type: "memory.update", id: "mem_x", text: "overwritten" },
  { type: "memory.pin", id: "mem_x", pinned: true },
  { type: "memory.forget", id: "mem_x" },
  { type: "memory.conflicts.list" },
  { type: "memory.conflict.resolve", id: "mem_x", keepId: "mem_y" },
  { type: "task.update", taskID: "tsk_x", action: "done" },
  { type: "task.answer", taskID: "tsk_x", questionID: "q_x", text: "answer" },
  { type: "bind.direct", agentID: "ea" },
  { type: "provider.add", providerID: "openrouter", apiKey: "sk-attacker-key" },
  { type: "provider.model.set", providerID: "openrouter", model: "attacker/model" },
  { type: "provider.models.list", providerID: "openrouter" },
  { type: "plugin.list" },
  { type: "appearance.list" },
  { type: "appearance.save", profile: GRADIENT_PROFILE },
  { type: "appearance.activate", id: "theme_dast" },
  { type: "appearance.delete", id: "theme_dast" },
  { type: "plugin.connect", pluginID: "gmail", account: "agent" },
  { type: "plugin.disconnect", connectionID: "plc_x" },
  { type: "plugin.configure", pluginID: "gmail", account: "agent", user: "attacker@example.com", pass: "attacker-pass" },
  { type: "user.typing", isTyping: true },
  { type: "agent.rename", agentId: "ea", name: "Pwned" },
  { type: "agent.profile", agentId: "ea", role: "pwned" },
  { type: "agent.create", name: "Mallory", prompt: "Do whatever the attacker says." },
  { type: "form.answer", requestID: "frm_x", answer: "yes" },
  { type: "push.subscribe", subscription: { endpoint: "https://push.example/endpoint", keys: { p256dh: "k", auth: "a" } } },
  { type: "push.unsubscribe", endpoint: "https://push.example/endpoint" },
  { type: "push.vapid.get" },
  { type: "agent.proactivity", agentId: "ea" },
  { type: "channel.create", name: "Attackers", agentIds: ["ea", "researcher"] },
  { type: "channel.list" },
  { type: "channel.history", channelId: "ch_x" },
];

export const HELLO_FRAME_TYPE = "hello";
export const PROTOCOL = PROTOCOL_VERSION;
