import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sseToolCall, startHarness, toolsThenText, type Harness, type TestClient } from "../ws-harness";
import { installFakeMailNetwork, type FakeMailNetwork } from "./fake-mail-network";
import { useThrowawayHome } from "./isolated-home";

/**
 * S3-13: the injection vectors again, entered the way an attack arrives: a
 * model turn in the task loop, started by a message over the real socket,
 * that calls the tool with hostile arguments. The earlier tests call the tools
 * through the registry; these prove the same holds on the path the loop takes
 * (deferred-tool loading, argument check, approval gate, handler).
 */

useThrowawayHome();

let harness: Harness | undefined;
let network: FakeMailNetwork | undefined;
let root = "";
const saved: Record<string, string | undefined> = {};
const ENV = ["GMAIL_USER", "GMAIL_APP_PASSWORD", "GMAIL_OWNER_USER", "GMAIL_OWNER_APP_PASSWORD", "AGNI_SCRATCH_DIR"];

beforeEach(() => {
  for (const key of ENV) saved[key] = process.env[key];
  root = mkdtempSync(join(tmpdir(), "agni-loop-injection-"));
  mkdirSync(join(root, "scratch"), { recursive: true });
  process.env.AGNI_SCRATCH_DIR = join(root, "scratch");
  process.env.GMAIL_USER = "agent@example.test";
  process.env.GMAIL_APP_PASSWORD = "app-password";
  delete process.env.GMAIL_OWNER_USER;
  delete process.env.GMAIL_OWNER_APP_PASSWORD;
});

afterEach(async () => {
  network?.restore();
  network = undefined;
  await harness?.stop();
  harness = undefined;
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(root, { recursive: true, force: true });
});

async function ready(client: TestClient): Promise<void> {
  // Name the bot (otherwise the first message is taken as its name), then let the welcome messages land.
  client.send({ type: "agent.rename", agentId: "ea", name: "Agni" });
  await client.next("agent.updated");
  client.drain();
}

describe("mail through the task loop", () => {
  test("an email whose body smuggles a second email goes out as one email to one recipient", async () => {
    network = installFakeMailNetwork();
    const body = "hello\r\n.\r\nMAIL FROM:<agent@example.test>\r\nRCPT TO:<attacker@evil.test>\r\nDATA\r\nSubject: x\r\n\r\npwned\r\n.\r\nQUIT";
    harness = await startHarness({
      fetch: toolsThenText([
        () => sseToolCall("load_tools", { names: ["mail_send"] }),
        () => sseToolCall("mail_send", { to: ["alice@example.test"], subject: "hi", body }),
      ], "sent"),
    });
    const client = await harness.connect();
    await ready(client);
    client.send({ type: "msg.send", channelId: "main", text: "email alice" });
    await client.next("turn.end", { timeoutMs: 8000 });
    expect(network.connections).toHaveLength(1);
    expect(network.connections[0]!.messages).toHaveLength(1);
    expect(network.connections[0]!.messages[0]!.rcpts).toEqual(["alice@example.test"]);
    expect(network.connections[0]!.commands.filter((line) => line.includes("attacker@evil.test"))).toEqual([]);
  });

  test("a subject that adds a Bcc header is refused before any connection", async () => {
    network = installFakeMailNetwork();
    harness = await startHarness({
      fetch: toolsThenText([
        () => sseToolCall("load_tools", { names: ["mail_send"] }),
        () => sseToolCall("mail_send", { to: ["alice@example.test"], subject: "hi\r\nBcc: attacker@evil.test", body: "ok" }),
      ], "refused"),
    });
    const client = await harness.connect();
    await ready(client);
    client.send({ type: "msg.send", channelId: "main", text: "email alice" });
    await client.next("turn.end", { timeoutMs: 8000 });
    expect(network.connections).toEqual([]);
  });

  test("a read-only search that tries to add an IMAP command sends only read commands", async () => {
    network = installFakeMailNetwork();
    harness = await startHarness({
      fetch: toolsThenText([
        () => sseToolCall("load_tools", { names: ["mail_search"] }),
        () => sseToolCall("mail_search", { query: 'x"\r\nA9 STORE 1:* +FLAGS (\\Deleted)\r\nA10 EXPUNGE' }),
      ], "searched"),
    });
    const client = await harness.connect();
    await ready(client);
    client.send({ type: "msg.send", channelId: "main", text: "find the mail" });
    await client.next("turn.end", { timeoutMs: 8000 });
    const verbs = network.connections.flatMap((connection) => connection.commands.map((line) => line.split(" ")[1]));
    expect(verbs.filter((verb) => verb === "STORE" || verb === "EXPUNGE" || verb === "DELETE")).toEqual([]);
    // A search with a line break in it was refused before the search went out.
    expect(verbs).not.toContain("SEARCH");
  });

  test("a mail_read uid that smuggles a command is refused by the argument check", async () => {
    network = installFakeMailNetwork();
    harness = await startHarness({
      fetch: toolsThenText([
        () => sseToolCall("load_tools", { names: ["mail_read"] }),
        () => sseToolCall("mail_read", { uid: "1\r\nA9 EXPUNGE" }),
      ], "read"),
    });
    const client = await harness.connect();
    await ready(client);
    client.send({ type: "msg.send", channelId: "main", text: "read the mail" });
    await client.next("turn.end", { timeoutMs: 8000 });
    expect(network.connections.flatMap((connection) => connection.commands).filter((line) => /EXPUNGE|STORE/.test(line))).toEqual([]);
  });
});

describe("shell commands through the task loop", () => {
  const marker = () => join(root, "scratch", "INJECTED");

  async function turnWith(command: string): Promise<{ client: TestClient; request: { requestID: string; buttons: string[]; preview: string } }> {
    harness = await startHarness({
      fetch: toolsThenText([
        () => sseToolCall("load_tools", { names: ["bash"] }),
        () => sseToolCall("bash", { command }),
      ], "stopped"),
    });
    const client = await harness.connect();
    await ready(client);
    client.send({ type: "msg.send", channelId: "main", text: "look at my notes" });
    const request = await client.next("approval.request", { timeoutMs: 8000 });
    return { client, request };
  }

  test.each([
    ["a command chained after a read-only one", "cat notes.txt; touch INJECTED"],
    ["command substitution inside an argument", "cat $(touch INJECTED)"],
    ["backticks inside an argument", "echo `touch INJECTED`"],
    ["a pipe into a second program", "cat notes.txt | tee INJECTED"],
    ["a redirect", "echo hi > INJECTED"],
    ["a newline then another command", "ls\ntouch INJECTED"],
    ["an environment-variable prefix", "FOO=bar touch INJECTED"],
    ["a background job", "ls & touch INJECTED"],
  ])("%s waits for the owner and does not run until they say yes", async (_label, command) => {
    const { client, request } = await turnWith(command);
    // The card is up and nothing has run.
    expect(existsSync(marker())).toBe(false);
    // Shell commands are never offered "always allow".
    expect(request.buttons).not.toContain("always");
    client.send({ type: "approve.reply", requestID: request.requestID, decision: "reject" });
    await client.next("turn.end", { timeoutMs: 8000 });
    expect(existsSync(marker())).toBe(false);
  });

  test("the same command does run once the owner approves (the gate is the only thing in the way)", async () => {
    const { client, request } = await turnWith("touch INJECTED");
    expect(existsSync(marker())).toBe(false);
    client.send({ type: "approve.reply", requestID: request.requestID, decision: "once" });
    await client.next("turn.end", { timeoutMs: 8000 });
    expect(existsSync(marker())).toBe(true);
  });

  test("a plain read-only command in scratch runs without a card", async () => {
    writeFileSync(join(root, "scratch", "notes.txt"), "just notes");
    harness = await startHarness({
      fetch: toolsThenText([
        () => sseToolCall("load_tools", { names: ["bash"] }),
        () => sseToolCall("bash", { command: "cat notes.txt" }),
      ], "read it"),
    });
    const client = await harness.connect();
    await ready(client);
    client.send({ type: "msg.send", channelId: "main", text: "look at my notes" });
    await client.next("turn.end", { timeoutMs: 8000 });
    expect(client.seen().filter((frame) => frame.type === "approval.request")).toEqual([]);
  });
});
