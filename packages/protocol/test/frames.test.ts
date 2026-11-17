import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  JobInfoSchema,
  PROTOCOL_VERSION,
  decodeText,
  encodeFrame,
  isSupportedVersion,
  parseClientFrame,
  parseServerFrame,
  type ServerFrame,
} from "../src/index";

describe("client frames", () => {
  test("validates versioned appearance profiles", () => {
    const profile = { version: 1, id: "theme_test", name: "Test", mode: "system", preset: "agni", accent: "ember", background: { kind: "none" }, textScale: "default", density: "comfortable", corners: "standard", motion: "system", agentTint: "full", updatedAt: "2026-10-23T00:00:00.000Z" };
    expect(parseClientFrame({ type: "appearance.save", profile }).ok).toBe(true);
    expect(parseClientFrame({ type: "appearance.save", profile: { ...profile, customAccent: "red", accent: "custom" } }).ok).toBe(false);
  });
  test("accepts ChatGPT account actions without an API key", () => {
    expect(parseClientFrame({ type: "provider.auth.start", providerID: "chatgpt" }).ok).toBe(true);
    expect(parseClientFrame({ type: "provider.auth.select", providerID: "chatgpt", accountID: "unit-account" }).ok).toBe(true);
    expect(parseClientFrame({ type: "provider.auth.start", providerID: "unknown" }).ok).toBe(false);
    expect(parseClientFrame({ type: "provider.auth.disconnect", providerID: "chatgpt" }).ok).toBe(false);
  });
  test("accepts a full msg.send", () => {
    const result = parseClientFrame({
      type: "msg.send",
      threadID: "thr_1",
      text: "hello",
      files: ["a.png"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.frame.type).toBe("msg.send");
      if (result.frame.type === "msg.send") expect(result.frame.text).toBe("hello");
    }
  });

  test("accepts channel sends, typing, and agent rename frames", () => {
    expect(parseClientFrame({ type: "msg.send", text: "hello", channelId: "main", texts: ["hello"] }).ok).toBe(true);
    expect(parseClientFrame({ type: "user.typing", channelId: "main", isTyping: true }).ok).toBe(true);
    expect(parseClientFrame({ type: "agent.rename", agentId: "ea", name: "Agni" }).ok).toBe(true);
  });

  test("accepts empty threadID as new-thread signal", () => {
    const result = parseClientFrame({ type: "msg.send", threadID: "", text: "hi" });
    expect(result.ok).toBe(true);
  });

  test("rejects missing text", () => {
    const result = parseClientFrame({ type: "msg.send", threadID: "thr_1" });
    expect(result.ok).toBe(false);
  });

  test("rejects unknown frame types", () => {
    const result = parseClientFrame({ type: "msg.explode", threadID: "thr_1" });
    expect(result.ok).toBe(false);
  });

  test("rejects a bad decision token", () => {
    const result = parseClientFrame({ type: "approve.reply", requestID: "req_1", decision: "maybe" });
    expect(result.ok).toBe(false);
  });

  test("accepts hello with a version", () => {
    const result = parseClientFrame({ type: "hello", v: PROTOCOL_VERSION, token: "agni_x", device: "cli" });
    expect(result.ok).toBe(true);
  });

  test("accepts durable-state reads with and without limits", () => {
    expect(parseClientFrame({ type: "thread.list" }).ok).toBe(true);
    expect(parseClientFrame({ type: "thread.list", limit: 5 }).ok).toBe(true);
    expect(parseClientFrame({ type: "thread.list", limit: 0 }).ok).toBe(false);
    expect(parseClientFrame({ type: "thread.history", threadID: "thr_1" }).ok).toBe(true);
    expect(parseClientFrame({ type: "thread.history", threadID: "" }).ok).toBe(false);
  });
});

describe("server frames", () => {
  test("accepts channel messages, activity, and agent updates", () => {
    expect(parseServerFrame({ type: "status.update", seq: 1, channelId: "main", text: "Working", transient: true }).ok).toBe(true);
    expect(parseServerFrame({
      type: "msg.new", seq: 2, id: "m1", channelId: "main", fromType: "agent", fromId: "ea",
      senderName: "Agni", text: "Hi", internal: false, uiHint: "normal", createdAt: "2026-10-17T00:00:00Z",
    }).ok).toBe(true);
    expect(parseServerFrame({ type: "agent.updated", seq: 3, agentId: "ea", displayName: "Agni", onboarded: true }).ok).toBe(true);
  });
  test("accepts hello.ok with seq", () => {
    const result = parseServerFrame({
      type: "hello.ok",
      seq: 1,
      v: PROTOCOL_VERSION,
      serverTime: "2026-10-16T12:00:00.000Z",
      lastSeq: 1,
    });
    expect(result.ok).toBe(true);
  });

  test("round-trips approval.closed for an approval card and a form card", () => {
    const approval = { type: "approval.closed", seq: 20, requestID: "apr_1", kind: "approval", reason: "decided" } as const;
    const parsedApproval = parseServerFrame(JSON.parse(encodeFrame(approval)));
    expect(parsedApproval.ok).toBe(true);
    if (parsedApproval.ok) expect(parsedApproval.frame).toEqual(approval);

    const form = { type: "approval.closed", seq: 21, requestID: "frm_1", kind: "form", reason: "expired" } as const;
    const parsedForm = parseServerFrame(JSON.parse(encodeFrame(form)));
    expect(parsedForm.ok).toBe(true);
    if (parsedForm.ok) expect(parsedForm.frame).toEqual(form);

    expect(parseServerFrame({ ...approval, reason: "cancelled" }).ok).toBe(true);
  });

  test("rejects approval.closed with a bad kind, reason, or missing seq", () => {
    const frame = { type: "approval.closed", seq: 22, requestID: "apr_1", kind: "approval", reason: "decided" };
    expect(parseServerFrame({ ...frame, kind: "secret" }).ok).toBe(false);
    expect(parseServerFrame({ ...frame, reason: "timeout" }).ok).toBe(false);
    expect(parseServerFrame({ ...frame, seq: undefined }).ok).toBe(false);
    expect(parseServerFrame({ ...frame, requestID: undefined }).ok).toBe(false);
  });

  test("round-trips the approval rules frames", () => {
    expect(parseClientFrame({ type: "approval.rules.list" }).ok).toBe(true);
    expect(parseClientFrame({ type: "approval.rule.revoke", id: "rul_1" }).ok).toBe(true);
    expect(parseClientFrame({ type: "approval.rule.revoke" }).ok).toBe(false);
    expect(parseClientFrame({ type: "approval.rule.revoke", id: "" }).ok).toBe(false);

    const list: ServerFrame = {
      type: "approval.rules.list.ok",
      seq: 30,
      rules: [
        { id: "rul_1", agentID: "agni", agentName: "Agni", toolName: "bash", target: "ls", createdAt: "2026-11-01T10:00:00.000Z" },
        { id: "rul_2", agentID: "gone", agentName: null, toolName: "write_file", target: "c:/x", createdAt: "2026-11-02T10:00:00.000Z" },
      ],
    };
    const parsedList = parseServerFrame(JSON.parse(encodeFrame(list)));
    expect(parsedList.ok).toBe(true);
    if (parsedList.ok) expect(parsedList.frame).toEqual(list);
    expect(parseServerFrame({ type: "approval.rules.list.ok", seq: 31, rules: [] }).ok).toBe(true);
    expect(parseServerFrame({ ...list, rules: [{ id: "rul_1" }] }).ok).toBe(false);

    const revoked = { type: "approval.rule.revoke.ok", seq: 32, id: "rul_1" } as const;
    const parsedRevoked = parseServerFrame(JSON.parse(encodeFrame(revoked)));
    expect(parsedRevoked.ok).toBe(true);
    if (parsedRevoked.ok) expect(parsedRevoked.frame).toEqual(revoked);
  });

  test("job.list.ok carries recurrence and housekeeping fields, which older frames may omit", () => {
    const job = { id: "job_1", kind: "turn", state: "queued", runAt: "2026-11-17T09:05:00.000Z", enabled: true, attempts: 0 };
    const withFields = { ...job, dailyAt: "09:05", days: ["mon", "tue", "wed", "thu", "fri"], internal: false };
    const parsed = parseServerFrame({ type: "job.list.ok", seq: 40, jobs: [withFields, { ...job, id: "job_2", kind: "tagger", internal: true }, job] });
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.frame.type === "job.list.ok") {
      expect(parsed.frame.jobs[0]).toMatchObject({ dailyAt: "09:05", days: ["mon", "tue", "wed", "thu", "fri"], internal: false });
      expect(parsed.frame.jobs[1]?.internal).toBe(true);
    }
    expect(parseServerFrame({ type: "job.list.ok", seq: 41, jobs: [{ ...job, days: [1, 2] }] }).ok).toBe(false);
    expect(parseServerFrame({ type: "job.list.ok", seq: 42, jobs: [{ ...job, internal: "yes" }] }).ok).toBe(false);
  });

  test("history messages carry the stop reason of the turn that produced them", () => {
    const message = { id: "msg_1", role: "assistant", text: "partial", createdAt: "2026-11-17T09:05:00.000Z", turnID: "trn_1" };
    const parsed = parseServerFrame({ type: "conversation.history.ok", seq: 43, conversationID: "cnv_1", messages: [{ ...message, stopReason: "timeout" }, message] });
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.frame.type === "conversation.history.ok") {
      expect(parsed.frame.messages[0]?.stopReason).toBe("timeout");
      expect(parsed.frame.messages[1]?.stopReason).toBeUndefined();
    }
    expect(parseServerFrame({ type: "thread.history.ok", seq: 44, threadID: "thr_1", messages: [{ ...message, stopReason: 3 }] }).ok).toBe(false);
  });

  test("rejects server frames without seq", () => {
    const result = parseServerFrame({ type: "presence", state: "online" });
    expect(result.ok).toBe(false);
  });

  test("accepts turn.end with usage", () => {
    const result = parseServerFrame({
      type: "turn.end",
      seq: 9,
      turnID: "trn_1",
      threadID: "thr_1",
      stopReason: "end",
      usage: { provider: "groq", model: "llama-3.1-8b-instant", latencyMs: 412 },
    });
    expect(result.ok).toBe(true);
  });

  test("rejects unknown stop reason", () => {
    const result = parseServerFrame({
      type: "turn.end",
      seq: 9,
      turnID: "trn_1",
      threadID: "thr_1",
      stopReason: "exploded",
    });
    expect(result.ok).toBe(false);
  });

  test("accepts thread list and history replies", () => {
    const list = parseServerFrame({
      type: "thread.list.ok",
      seq: 12,
      threads: [{ id: "thr_1", agentID: "agni", title: "bench notes", updatedAt: "2026-10-16T12:00:00.000Z" }],
    });
    expect(list.ok).toBe(true);
    if (list.ok && list.frame.type === "thread.list.ok") {
      expect(list.frame.threads[0]?.title).toBe("bench notes");
    }

    const history = parseServerFrame({
      type: "thread.history.ok",
      seq: 13,
      threadID: "thr_1",
      messages: [
        { id: "msg_1", role: "user", text: "hi", createdAt: "2026-10-16T12:00:00.000Z", turnID: "trn_1" },
        { id: "msg_2", role: "assistant", text: "hello", createdAt: "2026-10-16T12:00:01.000Z" },
      ],
    });
    expect(history.ok).toBe(true);
    if (history.ok && history.frame.type === "thread.history.ok") {
      expect(history.frame.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    }
  });
});

describe("routine info on job frames", () => {
  const job = {
    id: "job_1",
    kind: "routine",
    state: "queued",
    runAt: "2026-10-27T06:30:00.000Z",
    enabled: true,
    attempts: 0,
    title: "Morning digest",
    threadID: "thr_1",
  };
  const routine = {
    name: "Morning digest",
    cron: "30 7 * * *",
    timezone: "Europe/Berlin",
    misfire: "run_once",
    preflight: "http",
    maxTokens: 16000,
    maxExecutionMs: 120000,
    allowedDomains: ["example.com"],
    successStreak: 3,
    failureStreak: 0,
    recentRuns: [{ at: "2026-10-27T06:30:00.000Z", outcome: "ran", tokens: 512, summary: "digest sent" }],
  };

  test("accepts a JobInfo without routine", () => {
    const result = JobInfoSchema.safeParse(job);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.routine).toBeUndefined();
  });

  test("accepts a JobInfo with routine", () => {
    const result = JobInfoSchema.safeParse({ ...job, routine });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.routine?.name).toBe("Morning digest");
      expect(result.data.routine?.recentRuns[0]?.outcome).toBe("ran");
    }
  });

  test("rejects a routine with a bad preflight", () => {
    expect(JobInfoSchema.safeParse({ ...job, routine: { ...routine, preflight: "ftp" } }).success).toBe(false);
  });

  test("rejects more than five recent runs", () => {
    const runs = Array.from({ length: 6 }, (_, index) => ({ at: "2026-10-27T06:30:00.000Z", outcome: "ran", tokens: index }));
    expect(JobInfoSchema.safeParse({ ...job, routine: { ...routine, recentRuns: runs } }).success).toBe(false);
  });

  test("job.list.ok parses with routine present and absent", () => {
    expect(parseServerFrame({ type: "job.list.ok", seq: 1, jobs: [{ ...job, routine }, job] }).ok).toBe(true);
  });
});

describe("envelope helpers", () => {
  test("encode → decode → parse round trip", () => {
    const wire = encodeFrame({ type: "msg.cancel", turnID: "trn_1" });
    const decoded = decodeText(wire);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      const parsed = parseClientFrame(decoded.value);
      expect(parsed.ok).toBe(true);
    }
  });

  test("decodeText reports invalid JSON", () => {
    expect(decodeText("{oops").ok).toBe(false);
  });

  test("version guard", () => {
    expect(isSupportedVersion(PROTOCOL_VERSION)).toBe(true);
    expect(isSupportedVersion(PROTOCOL_VERSION - 1)).toBe(false);
  });
});

describe("Sprint 2 frames (additive)", () => {
  test("approval.request still parses without the new fields, and with them", () => {
    const base = { type: "approval.request", seq: 1, requestID: "apr_1", action: "do it", preview: "preview", buttons: ["once", "reject"] };
    expect(parseServerFrame(base).ok).toBe(true);
    expect(parseServerFrame({
      ...base,
      source: [{ kind: "web", label: "example.com/offers" }, { kind: "scheduled" }],
      tier: 2,
      expiresAt: "2026-11-16T12:10:00.000Z",
      truncated: true,
    }).ok).toBe(true);
  });

  test("approval.request rejects an unknown source kind and a tier outside 0-3", () => {
    const base = { type: "approval.request", seq: 1, requestID: "apr_1", action: "a", preview: "p", buttons: ["once"] };
    expect(parseServerFrame({ ...base, source: [{ kind: "carrier-pigeon" }] }).ok).toBe(false);
    expect(parseServerFrame({ ...base, tier: 4 }).ok).toBe(false);
  });

  test("approval.full needs a request id", () => {
    expect(parseClientFrame({ type: "approval.full", requestID: "apr_1" }).ok).toBe(true);
    expect(parseClientFrame({ type: "approval.full" }).ok).toBe(false);
  });

  test("policy.pause reads with no fields, pauses, or addresses one bot", () => {
    expect(parseClientFrame({ type: "policy.pause" }).ok).toBe(true);
    expect(parseClientFrame({ type: "policy.pause", paused: true }).ok).toBe(true);
    expect(parseClientFrame({ type: "policy.pause", paused: false, agentID: "researcher" }).ok).toBe(true);
    expect(parseClientFrame({ type: "policy.pause", paused: "yes" }).ok).toBe(false);
  });

  test("agent.enabled.set needs both fields", () => {
    expect(parseClientFrame({ type: "agent.enabled.set", agentID: "researcher", enabled: false }).ok).toBe(true);
    expect(parseClientFrame({ type: "agent.enabled.set", agentID: "researcher" }).ok).toBe(false);
  });

  test("spend.caps.set takes positive dollars or null, and leaves out what it does not change", () => {
    expect(parseClientFrame({ type: "spend.caps.set", dayUsd: 2 }).ok).toBe(true);
    expect(parseClientFrame({ type: "spend.caps.set", perJobUsd: null }).ok).toBe(true);
    expect(parseClientFrame({ type: "spend.caps.set" }).ok).toBe(true);
    expect(parseClientFrame({ type: "spend.caps.set", dayUsd: 0 }).ok).toBe(false);
    expect(parseClientFrame({ type: "spend.caps.set", dayUsd: -1 }).ok).toBe(false);
    expect(parseClientFrame({ type: "spend.caps.set", dayUsd: "2" }).ok).toBe(false);
  });

  test("an agent and an approval rule may carry the new optional fields", () => {
    expect(parseServerFrame({ type: "agents.update", seq: 1, agents: [{ id: "ea", name: "Agni", enabled: false }] }).ok).toBe(true);
    expect(parseServerFrame({
      type: "approval.rules.list.ok", seq: 1,
      rules: [{ id: "rul_1", agentID: "ea", agentName: "Agni", toolName: "write_file", target: "resource:reports/*", createdAt: "2026-11-16T00:00:00.000Z", resourcePattern: "reports/*" }],
    }).ok).toBe(true);
  });

  test("policy.pause.ok and spend.status.ok parse", () => {
    expect(parseServerFrame({ type: "policy.pause.ok", seq: 1, paused: false, stopped: 0, bots: [{ agentID: "ea", name: "Agni", enabled: true, runningTurns: 0, scheduledJobs: 0 }] }).ok).toBe(true);
    expect(parseServerFrame({ type: "spend.status.ok", seq: 1, day: "2026-11-16", resetsAt: "2026-11-17T00:00:00.000Z", timeZone: "UTC", caps: { dayUsd: 2, perBotDayUsd: null, perJobUsd: 0.5 }, daySpentUsd: 0, bots: [], unpricedCalls: 0 }).ok).toBe(true);
    expect(parseServerFrame({ type: "approval.full.ok", seq: 1, requestID: "apr_1", text: "everything" }).ok).toBe(true);
  });

  test("spend.status.ok carries the run caps when it has them, and parses without them", () => {
    const base = { type: "spend.status.ok", seq: 1, day: "2026-11-16", resetsAt: "2026-11-17T00:00:00.000Z", timeZone: "UTC", caps: { dayUsd: 2, perBotDayUsd: 1, perJobUsd: 0.5 }, daySpentUsd: 0, bots: [], unpricedCalls: 0 };
    const runCaps = { rootJobWallMinutes: 30, maxConcurrentDelegations: 4, maxSelfScheduledJobsPerBot: 10, maxWakesPerRequest: 10 };
    const withCaps = parseServerFrame({ ...base, runCaps });
    expect(withCaps.ok).toBe(true);
    if (withCaps.ok && withCaps.frame.type === "spend.status.ok") expect(withCaps.frame.runCaps).toEqual(runCaps);
    expect(parseServerFrame(base).ok).toBe(true);
    // A run cap is a positive number, and the counts are whole numbers.
    expect(parseServerFrame({ ...base, runCaps: { ...runCaps, rootJobWallMinutes: 0 } }).ok).toBe(false);
    expect(parseServerFrame({ ...base, runCaps: { ...runCaps, maxWakesPerRequest: 1.5 } }).ok).toBe(false);
    expect(parseServerFrame({ ...base, runCaps: { ...runCaps, maxConcurrentDelegations: -1 } }).ok).toBe(false);
    expect(parseServerFrame({ ...base, runCaps: { rootJobWallMinutes: 30 } }).ok).toBe(false);
  });

  test("spend.continue needs a run key; spend.stopped and spend.continue.ok parse", () => {
    expect(parseClientFrame({ type: "spend.continue", runKey: "agent:ea" }).ok).toBe(true);
    expect(parseClientFrame({ type: "spend.continue" }).ok).toBe(false);
    expect(parseClientFrame({ type: "spend.continue", runKey: "" }).ok).toBe(false);
    expect(parseServerFrame({ type: "spend.stopped", seq: 1, runKey: "agent:ea", agentId: "ea", scope: "day", reason: "over_cap", spentUsd: 2, capUsd: 2, message: "stopped" }).ok).toBe(true);
    expect(parseServerFrame({ type: "spend.stopped", seq: 1, runKey: "agent:ea", scope: "week", reason: "over_cap", spentUsd: 2, capUsd: 2, message: "stopped" }).ok).toBe(false);
    expect(parseServerFrame({ type: "spend.continue.ok", seq: 1, runKey: "agent:ea", grantedUsd: 0.5 }).ok).toBe(true);
    expect(parseServerFrame({ type: "spend.continue.ok", seq: 1, runKey: "agent:ea", grantedUsd: 0 }).ok).toBe(false);
  });

  test("an error frame may name the card an approve.reply was refused for", () => {
    const base = { type: "error", seq: 3, code: "unknown_request", message: "gone" };
    const named = parseServerFrame({ ...base, requestID: "apr_1" });
    expect(named.ok).toBe(true);
    if (named.ok && named.frame.type === "error") expect(named.frame.requestID).toBe("apr_1");
    const plain = parseServerFrame(base);
    expect(plain.ok).toBe(true);
    if (plain.ok && plain.frame.type === "error") expect(plain.frame.requestID).toBeUndefined();
    expect(parseServerFrame({ ...base, requestID: 5 }).ok).toBe(false);
  });

  test("the fixtures carry an error frame with a requestID", () => {
    const fixtures = JSON.parse(readFileSync(new URL("../fixtures/frames.json", import.meta.url), "utf8")) as { server: Array<{ type: string; requestID?: string }> };
    const named = fixtures.server.filter((frame) => frame.type === "error" && typeof frame.requestID === "string");
    expect(named.length).toBeGreaterThan(0);
    for (const frame of named) {
      const parsed = parseServerFrame(frame);
      expect(parsed.ok).toBe(true);
      if (parsed.ok && parsed.frame.type === "error") expect(parsed.frame.requestID).toBe(frame.requestID);
    }
  });
});
