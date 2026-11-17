import { afterEach, describe, expect, test } from "bun:test";
import { unquoteImapString } from "./fake-mail-network";
import { mailRig, refused, type MailRig } from "./mail-tools";
import { useThrowawayHome } from "./isolated-home";

/**
 * S3-13 / bug.md H5: the read-only mail tools cannot be talked into running
 * other IMAP commands. `mail_search` and `mail_read` are called through the
 * registry; the IMAP server is an in-process stand-in that runs every command
 * it is sent, destructive ones included.
 */

useThrowawayHome();

let rig: MailRig | undefined;
afterEach(() => {
  rig?.close();
  rig = undefined;
});

/** Commands a read-only tool may send. Anything else on the wire is an injection. */
const READ_ONLY = new Set(["LOGIN", "SELECT", "SEARCH", "FETCH", "LOGOUT"]);

function verbs(commands: string[]): string[] {
  return commands.map((line) => line.split(" ")[1]!.toUpperCase());
}

function expectOnlyReadCommands(commands: string[]): void {
  const stray = commands.filter((line) => !READ_ONLY.has(line.split(" ")[1]?.toUpperCase() ?? ""));
  expect(stray).toEqual([]);
}

const DESTRUCTIVE_TAIL = '\r\nA9 STORE 1:* +FLAGS (\\Deleted)\r\nA10 EXPUNGE';

describe("mail_search", () => {
  test.each([
    ["a quote and CRLF STORE", `x"${DESTRUCTIVE_TAIL}`],
    ["CRLF STORE with no quote", `inbox${DESTRUCTIVE_TAIL}`],
    ["Gmail syntax then CRLF EXPUNGE", `from:boss${DESTRUCTIVE_TAIL}`],
    ["LF only", 'x"\nA9 STORE 1:* +FLAGS (\\Deleted)\nA10 EXPUNGE'],
    ["CR only", 'x"\rA9 STORE 1:* +FLAGS (\\Deleted)\rA10 EXPUNGE'],
    ["NUL", 'x"\0A9 STORE 1:* +FLAGS (\\Deleted)'],
    ["a literal marker with a line break", "{40}\r\nA9 STORE 1:* +FLAGS (\\Deleted)"],
    ["a line break at the very end", "boss\r\n"],
  ])("%s never reaches the server as a command", async (_label, query) => {
    rig = mailRig();
    const outcome = await rig.call("mail_search", { query });
    expect(refused(outcome)).toBe(true);
    for (const connection of rig.network.connections) expectOnlyReadCommands(connection.commands);
    // A search for a string with a line break never goes out at all.
    expect(rig.network.connections.flatMap((connection) => verbs(connection.commands)).filter((verb) => verb === "SEARCH")).toEqual([]);
  });

  test.each([
    ["a quote and a boolean", 'x" OR ALL "y'],
    ["a closing quote and ALL", 'x") ALL ("'],
    ["a trailing backslash", "from:boss\\"],
    ["a backslash before a quote", 'a\\" OR ALL'],
    ["a parenthesis group", "(DELETED) OR (ALL)"],
    ["IMAP keywords", "ALL DELETED UNSEEN"],
    ["a curly brace", "{5}"],
    ["a percent and a star", "*%"],
    ["unicode", "請求書 éa 😀"],
  ])("%s stays one quoted string: the server reads back exactly what was searched for", async (_label, query) => {
    rig = mailRig();
    const outcome = await rig.call("mail_search", { query });
    expect(refused(outcome)).toBe(false);
    const connection = rig.network.connections[0]!;
    expectOnlyReadCommands(connection.commands);
    const search = connection.commands.find((line) => line.split(" ")[1] === "SEARCH")!;
    const criteria = search.slice(search.indexOf("SEARCH ") + "SEARCH ".length);
    // `X-GM-RAW "…"` for Gmail syntax, `TEXT "…"` otherwise; either way, one key and one quoted string.
    const match = /^(X-GM-RAW|TEXT) (".*")$/.exec(criteria);
    expect(match).not.toBeNull();
    expect(unquoteImapString(match![2]!)).toBe(query);
  });

  test("a normal search still finds mail (the guard is not a blanket refusal)", async () => {
    rig = mailRig({ searchHits: [3, 7] });
    const outcome = await rig.call("mail_search", { query: "is:unread from:boss" });
    expect(outcome.result).toMatchObject({ count: 2 });
    expect(verbs(rig.network.connections[0]!.commands)).toEqual(["LOGIN", "SELECT", "SEARCH", "FETCH", "FETCH", "LOGOUT"]);
  });

  test("the mailbox name is fixed: the model cannot choose where to search", async () => {
    rig = mailRig();
    await rig.call("mail_search", { query: "x", mailbox: 'INBOX"\r\nA9 DELETE "Inbox', folder: "Trash" });
    for (const connection of rig.network.connections) {
      expectOnlyReadCommands(connection.commands);
      expect(connection.commands.filter((line) => line.split(" ")[1] === "SELECT")).toEqual([expect.stringMatching(/ SELECT "INBOX"$/)]);
    }
  });

  test("results are returned as data: instructions inside a message do not become commands", async () => {
    rig = mailRig({ searchHits: [1] });
    const outcome = await rig.call("mail_search", { query: "invoice" });
    expect(refused(outcome)).toBe(false);
    expectOnlyReadCommands(rig.network.connections[0]!.commands);
  });
});

describe("mail_read", () => {
  test.each([
    ["a CRLF STORE after the number", `1${DESTRUCTIVE_TAIL}`],
    ["a number then a space and a command", "1 (FLAGS) A9 STORE 1:* +FLAGS (\\Deleted)"],
    ["a range", "1:*"],
    ["a negative number", "-1"],
    ["a float", "1.5"],
    ["an array", [1, 2]],
    ["an object", { toString: "1\r\nA9 EXPUNGE" }],
    ["a boolean", true],
    ["hex", "0x10"],
    ["exponent", "1e3\r\nA9 EXPUNGE"],
  ])("a uid that is %s is refused and sends no FETCH or other command", async (_label, uid) => {
    rig = mailRig();
    const outcome = await rig.call("mail_read", { uid });
    expect(refused(outcome)).toBe(true);
    for (const connection of rig.network.connections) {
      expectOnlyReadCommands(connection.commands);
      expect(connection.commands.filter((line) => line.split(" ")[1] === "FETCH")).toEqual([]);
    }
  });

  test("a plain number, or a number the model sent as a string, fetches exactly that message", async () => {
    rig = mailRig();
    for (const uid of [4, "4"]) {
      const outcome = await rig.call("mail_read", { uid });
      expect(refused(outcome)).toBe(false);
    }
    for (const connection of rig.network.connections) {
      expect(connection.commands.filter((line) => line.split(" ")[1] === "FETCH").map((line) => line.split(" ").slice(2).join(" "))).toEqual(["4 (FLAGS RFC822)"]);
    }
  });
});

describe("IMAP login", () => {
  test("a password with quotes and backslashes arrives exactly, as one quoted string", async () => {
    const user = "agent@example.test";
    const pass = 'pa"ss\\w\\"ord';
    rig = mailRig({ accounts: () => ({ user, pass }) });
    await rig.call("mail_search", { query: "x" });
    expect(rig.network.connections[0]!.imapLogin).toEqual({ user, pass });
  });

  test.each([
    ["CRLF STORE in the password", `x"${DESTRUCTIVE_TAIL}`],
    ["a bare LF", 'x"\nA9 STORE 1:* +FLAGS (\\Deleted)'],
    ["NUL", "x\0y"],
  ])("%s: no connection is made and no command is sent", async (_label, pass) => {
    rig = mailRig({ accounts: () => ({ user: "agent@example.test", pass }) });
    const outcome = await rig.call("mail_search", { query: "x" });
    expect(refused(outcome)).toBe(true);
    expect(rig.network.connections.flatMap((connection) => connection.commands)).toEqual([]);
  });

  test("a user name with a line break is refused the same way", async () => {
    rig = mailRig({ accounts: () => ({ user: `agent@example.test${DESTRUCTIVE_TAIL}`, pass: "x" }) });
    const outcome = await rig.call("mail_read", { uid: 1 });
    expect(refused(outcome)).toBe(true);
    expect(rig.network.connections.flatMap((connection) => connection.commands)).toEqual([]);
  });
});
