/**
 * Sprint 1 exit-test findings, security follow-ups (int5): a rule the list
 * hides is revoked, and model text on a password prompt or form is cleaned.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

describe("a rule the list hides is revoked, so it can never match later", () => {
  const saved = process.env.AGNI_SCRATCH_DIR;
  afterEach(() => { if (saved === undefined) delete process.env.AGNI_SCRATCH_DIR; else process.env.AGNI_SCRATCH_DIR = saved; });

  test("an outside-scratch write rule is revoked when the list hides it, and moving scratch over it does not bring it back", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { findApprovalRule, listApprovalRules } = await import("../src/stores/approval-rules");
    const root = mkdtempSync(join(tmpdir(), "agni-int5-rules-"));
    process.env.AGNI_SCRATCH_DIR = join(root, "scratch");
    db = openDatabase(":memory:");
    const target = join(root, "elsewhere", "startup.cmd");
    db.run("INSERT INTO approval_rules (id, agent_id, tool_name, target, created_at) VALUES ('rul_out', 'ea', 'write_file', ?, ?)", [target, new Date().toISOString()]);
    db.run("INSERT INTO approval_rules (id, agent_id, tool_name, target, created_at) VALUES ('rul_shell', 'ea', 'bash', 'ls', ?)", [new Date().toISOString()]);

    expect(listApprovalRules(db)).toEqual([]);
    const revoked = db.query<{ id: string; revoked_at: string | null }, []>("SELECT id, revoked_at FROM approval_rules ORDER BY id").all();
    expect(revoked.every((row) => row.revoked_at !== null)).toBe(true);

    // The scratch folder moves to cover the old target: the rule stays dead.
    process.env.AGNI_SCRATCH_DIR = root;
    expect(findApprovalRule(db, "ea", "write_file", target)).toBeNull();
    expect(listApprovalRules(db)).toEqual([]);
    // The history is still there.
    expect(listApprovalRules(db, { includeRevoked: true })).toHaveLength(2);
  });
});

describe("what the owner sees on a password prompt and a form is cleaned like an approval card", () => {
  const UNSAFE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/;
  const B = String.fromCharCode(92);

  test("the secret prompt shows the command and purpose with escapes, in the frame and in the replay list", async () => {
    const { requestSecret, listPendingSecrets, resetSecretBroker } = await import("../src/agent/secret-broker");
    resetSecretBroker();
    const frames: Array<{ type: string; command?: string; purpose?: string }> = [];
    const command = "sudo ls\nTo: owner@example.com\u202E gnp.exe";
    void requestSecret({ emit: (frame) => frames.push(frame as never) }, { purpose: "update\r\nthe system\u200B", command });
    const sent = frames.find((frame) => frame.type === "secret.request")!;
    for (const text of [sent.command!, sent.purpose!, listPendingSecrets()[0]!.command, listPendingSecrets()[0]!.purpose]) {
      expect(text).not.toMatch(UNSAFE);
      expect(text).not.toContain("\n");
    }
    expect(sent.command).toContain(`sudo ls${B}nTo: owner@example.com${B}u202E`);
    expect(sent.purpose).toContain(`${B}r${B}n`);
    resetSecretBroker();
  });

  test("a form's question, options and draft email fields are cleaned; the body keeps its own line breaks", async () => {
    const { FormBroker } = await import("../src/agent/form-broker");
    const { getForm } = await import("../src/stores/forms");
    db = openDatabase(":memory:");
    const { createThread } = await import("../src/stores/threads");
    const threadID = createThread(db, "ea").id;
    const frames: Array<Record<string, unknown>> = [];
    const broker = new FormBroker({ db, emit: (frame) => frames.push(frame as never), ownerWaitMs: 50 });
    await broker.request({
      threadID, turnID: null, kind: "email", question: "Send this?\u202E",
      email: { from: "me@x.com\nBcc: z@evil", to: "a@x.com\u200B", subject: "Hi\nTo: forged", body: "line one\nline two\u202Etail" },
    }, new AbortController().signal);
    await broker.request({ threadID, turnID: null, kind: "choice", question: "Which?\u2066", options: ["a\nb", "c\u200Dd"] }, new AbortController().signal);

    const [email, choice] = frames.filter((frame) => frame.type === "form.request") as Array<{ question: string; options?: string[]; email?: { from: string; to: string; subject: string; body: string } }>;
    expect(email!.question).not.toMatch(UNSAFE);
    for (const field of [email!.email!.from, email!.email!.to, email!.email!.subject]) { expect(field).not.toMatch(UNSAFE); expect(field).not.toContain("\n"); }
    expect(email!.email!.body.split("\n")).toHaveLength(2);
    expect(email!.email!.body).not.toMatch(UNSAFE);
    expect(email!.email!.body).toContain(`${B}u202E`);
    for (const option of choice!.options!) { expect(option).not.toMatch(UNSAFE); expect(option).not.toContain("\n"); }
    // The stored row is what a reconnect replays: it is clean too.
    const row = db.query<{ id: string }, []>("SELECT id FROM forms ORDER BY created_at LIMIT 1").get()!;
    expect(getForm(db, row.id)!.email!.subject).not.toContain("\n");
  });
});

describe("a rule whose target is no longer inside scratch never matches", () => {
  const saved = process.env.AGNI_SCRATCH_DIR;
  afterEach(() => { if (saved === undefined) delete process.env.AGNI_SCRATCH_DIR; else process.env.AGNI_SCRATCH_DIR = saved; });

  test("moving the scratch folder away from a remembered write does not leave the rule matching", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { findApprovalRule } = await import("../src/stores/approval-rules");
    const root = mkdtempSync(join(tmpdir(), "agni-int7a-rules-"));
    process.env.AGNI_SCRATCH_DIR = join(root, "scratch");
    db = openDatabase(":memory:");
    const target = join(root, "scratch", "notes.md");
    db.run("INSERT INTO approval_rules (id, agent_id, tool_name, target, created_at) VALUES ('rul_in', 'ea', 'write_file', ?, ?)", [target, new Date().toISOString()]);
    expect(findApprovalRule(db, "ea", "write_file", target)?.id).toBe("rul_in");

    process.env.AGNI_SCRATCH_DIR = join(root, "somewhere-else");
    expect(findApprovalRule(db, "ea", "write_file", target)).toBeNull();
    // Back where it was, the rule is alive: finding it did not revoke it.
    process.env.AGNI_SCRATCH_DIR = join(root, "scratch");
    expect(findApprovalRule(db, "ea", "write_file", target)?.id).toBe("rul_in");
  });
});
