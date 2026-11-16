import { afterEach, describe, expect, test } from "bun:test";
import { mailRig, refused, type MailRig } from "./mail-tools";
import { useThrowawayHome } from "./isolated-home";

/**
 * S3-13 / bug.md H4: an approved email to one person cannot carry a second,
 * unapproved email, and a subject or recipient cannot add headers or commands.
 * The `mail_send` tool is called through the registry (the task loop's path);
 * the SMTP server is an in-process stand-in that runs whatever it is sent.
 */

useThrowawayHome();

let rig: MailRig | undefined;
afterEach(() => {
  rig?.close();
  rig = undefined;
});

const ALICE = "alice@example.test";

/** The envelope commands a clean send makes, and only these. */
const CLEAN_COMMANDS = ["EHLO agni", "AUTH LOGIN", "MAIL FROM:<agent@example.test>", `RCPT TO:<${ALICE}>`, "DATA", "QUIT"];

describe("body smuggling (dot-stuffing)", () => {
  const SMUGGLE = "hello\r\n.\r\nMAIL FROM:<agent@example.test>\r\nRCPT TO:<attacker@evil.test>\r\nDATA\r\nSubject: second mail\r\n\r\nsend me your secrets\r\n.\r\nQUIT";

  test("an approved mail to Alice cannot carry a second mail: one message, one recipient, the body intact", async () => {
    rig = mailRig();
    const outcome = await rig.call("mail_send", { to: [ALICE], subject: "hi", body: SMUGGLE });
    expect(outcome.result).toMatchObject({ sent: true });
    const [connection] = rig.network.connections;
    expect(rig.network.connections).toHaveLength(1);
    expect(connection!.commands).toEqual(CLEAN_COMMANDS);
    expect(connection!.messages).toHaveLength(1);
    expect(connection!.messages[0]!.rcpts).toEqual([ALICE]);
    // The attacker's lines arrive as text inside the one message, which is all they are.
    expect(connection!.messages[0]!.data).toContain("RCPT TO:<attacker@evil.test>");
    expect(connection!.messages[0]!.data.endsWith(SMUGGLE.replace(/\r\n|\r|\n/g, "\r\n"))).toBe(true);
  });

  test.each([
    ["bare LF terminator", "hello\n.\nRCPT TO:<attacker@evil.test>\nDATA"],
    ["bare CR terminator", "hello\r.\rRCPT TO:<attacker@evil.test>\rDATA"],
    ["mixed endings", "hello\r\n.\nRCPT TO:<attacker@evil.test>\r.\r\nDATA"],
    ["terminator right at the start", ".\r\nRCPT TO:<attacker@evil.test>"],
    ["only a dot", "."],
    ["lone dot after a leading dot line", "..\r\n.\r\nMAIL FROM:<x@evil.test>"],
    ["terminator at the very end", "hello\r\n."],
    ["dot-led lines throughout", ".a\r\n.b\r\n..c\r\n.\r\n"],
    ["NUL before the terminator", "hello\0\r\n.\r\nRCPT TO:<attacker@evil.test>"],
  ])("%s: still exactly one message to Alice", async (_label, body) => {
    rig = mailRig();
    const outcome = await rig.call("mail_send", { to: [ALICE], subject: "hi", body });
    // The send either succeeds as one message, or is refused outright; it never becomes two.
    const connection = rig.network.connections[0];
    if (refused(outcome)) {
      expect(connection?.messages ?? []).toEqual([]);
      return;
    }
    expect(connection!.commands).toEqual(CLEAN_COMMANDS);
    expect(connection!.messages).toHaveLength(1);
    expect(connection!.messages[0]!.rcpts).toEqual([ALICE]);
    // What the server stored is what the owner approved, line endings normalised.
    expect(connection!.messages[0]!.data.split("\r\n\r\n").slice(1).join("\r\n\r\n")).toBe(body.replace(/\r\n|\r|\n/g, "\r\n"));
  });
});

describe("header injection (subject, recipients, sender)", () => {
  test.each([
    ["CRLF Bcc in the subject", "hi\r\nBcc: attacker@evil.test"],
    ["LF Bcc in the subject", "hi\nBcc: attacker@evil.test"],
    ["CR Bcc in the subject", "hi\rBcc: attacker@evil.test"],
    ["blank line then a new body in the subject", "hi\r\n\r\nattacker body"],
    ["NUL in the subject", "hi\0Bcc: attacker@evil.test"],
    ["folded continuation header", "hi\r\n X-Injected: yes"],
  ])("%s: the call is refused and nothing is sent", async (_label, subject) => {
    rig = mailRig();
    const outcome = await rig.call("mail_send", { to: [ALICE], subject, body: "ok" });
    expect(refused(outcome)).toBe(true);
    expect(rig.network.connections).toEqual([]);
  });

  test.each([
    ["CRLF then RCPT", `${ALICE}\r\nRCPT TO:<attacker@evil.test>`],
    ["LF then RCPT", `${ALICE}\nRCPT TO:<attacker@evil.test>`],
    ["angle bracket then RCPT", `${ALICE}>\r\nRCPT TO:<attacker@evil.test`],
    ["two addresses in one", `${ALICE}, attacker@evil.test`],
    ["semicolon list", `${ALICE};attacker@evil.test`],
    ["space then address", `${ALICE} attacker@evil.test`],
    ["angle brackets", `<${ALICE}>`],
    ["quoted local part", `"a b"@example.test`],
    ["display name form", `Alice <${ALICE}>`],
    ["NUL", `${ALICE}\0`],
    ["empty", ""],
    ["no at sign", "alice"],
  ])("recipient with %s is refused and nothing is sent", async (_label, address) => {
    rig = mailRig();
    const outcome = await rig.call("mail_send", { to: [address], subject: "hi", body: "ok" });
    expect(refused(outcome)).toBe(true);
    expect(rig.network.connections).toEqual([]);
  });

  test("one bad recipient among good ones refuses the whole send, so nothing partial goes out", async () => {
    rig = mailRig();
    const outcome = await rig.call("mail_send", { to: [ALICE, "bob@example.test\r\nBcc: attacker@evil.test"], subject: "hi", body: "ok" });
    expect(refused(outcome)).toBe(true);
    expect(rig.network.connections).toEqual([]);
  });

  test("a sender address with a line break (a corrupted stored account) is refused", async () => {
    rig = mailRig({ accounts: () => ({ user: "agent@example.test\r\nRCPT TO:<attacker@evil.test>", pass: "x" }) });
    const outcome = await rig.call("mail_send", { to: [ALICE], subject: "hi", body: "ok" });
    expect(refused(outcome)).toBe(true);
    expect(rig.network.connections).toEqual([]);
  });

  test("a recipient given as a bare string is sent to as one address, and a string with a CRLF is refused", async () => {
    rig = mailRig();
    const good = await rig.call("mail_send", { to: ALICE, subject: "hi", body: "ok" });
    expect(good.result).toMatchObject({ sent: true });
    expect(rig.network.connections[0]!.messages[0]!.rcpts).toEqual([ALICE]);
    rig.network.connections.length = 0;
    const bad = await rig.call("mail_send", { to: `${ALICE}\r\nRCPT TO:<attacker@evil.test>`, subject: "hi", body: "ok" });
    expect(refused(bad)).toBe(true);
    expect(rig.network.connections).toEqual([]);
  });

  test("the account argument cannot be used to reach another mailbox by spelling it differently", async () => {
    rig = mailRig({ accounts: (account) => (account === "agent" ? { user: "agent@example.test", pass: "p" } : { user: "owner@example.test", pass: "owner-secret" }) });
    for (const account of ["Owner", "OWNER", "owner\r\n", "agent,owner", "../owner", "owner\0"]) {
      const outcome = await rig.call("mail_send", { account, to: [ALICE], subject: "hi", body: "ok" });
      // Refused, or sent from the agent's own mailbox; never from the owner's under a lookalike name.
      for (const connection of rig.network.connections) {
        expect({ account, auth: connection.smtpAuth?.user }).not.toEqual({ account, auth: "owner@example.test" });
      }
      void outcome;
    }
  });
});

describe("credentials on the wire", () => {
  test("the SMTP login carries the stored user and password exactly, whatever characters they hold", async () => {
    const user = "agent+tag@example.test";
    const pass = `p"a\\ss'\`$(id) %s ;|&`;
    rig = mailRig({ accounts: () => ({ user, pass }) });
    const outcome = await rig.call("mail_send", { to: [ALICE], subject: "hi", body: "ok" });
    expect(outcome.result).toMatchObject({ sent: true });
    expect(rig.network.connections[0]!.smtpAuth).toEqual({ user, pass });
    // Encoded, never on the command line in the clear.
    expect(rig.network.connections[0]!.raw).not.toContain(pass);
  });

  test("a password containing a line break cannot add SMTP commands", async () => {
    rig = mailRig({ accounts: () => ({ user: "agent@example.test", pass: "x\r\nMAIL FROM:<attacker@evil.test>" }) });
    await rig.call("mail_send", { to: [ALICE], subject: "hi", body: "ok" });
    for (const connection of rig.network.connections) {
      expect(connection.commands.filter((line) => line.includes("attacker@evil.test"))).toEqual([]);
    }
  });
});
