/**
 * A stand-in for the mail network, for the injection tests (S3-13).
 *
 * The mail clients open a TLS socket with `tls.connect`. This replaces that one
 * function with a socket that talks to an in-process SMTP or IMAP server which
 * behaves like a real, permissive one: it answers `OK` to every command it is
 * sent, including ones the client never meant to send. Whatever an attacker
 * smuggles into a command line therefore shows up here as a command that a real
 * server would have run, and the tests assert on the list of commands.
 *
 * No socket is ever opened and nothing leaves the process.
 *
 * Not a test file (no `.test.`), so bun does not collect it.
 */
import { EventEmitter } from "node:events";
import tls from "node:tls";

export interface SmtpMessage {
  from: string;
  rcpts: string[];
  /** The message as the server reads it, de-stuffed as RFC 5321 4.5.2 says a server must. */
  data: string;
}

export interface Connection {
  kind: "smtp" | "imap";
  host: string;
  port: number;
  /** Every complete command line the server read outside a DATA section, in order. */
  commands: string[];
  /** Everything the client wrote, as the server saw it. */
  raw: string;
  /** Delivered messages (SMTP only). */
  messages: SmtpMessage[];
  /** Decoded AUTH LOGIN user and password (SMTP only). */
  smtpAuth?: { user: string; pass: string };
  /** The two strings of the IMAP LOGIN command, parsed strictly as quoted strings (IMAP only). */
  imapLogin?: { user: string; pass: string } | "malformed";
}

const CRLF = "\r\n";

class FakeSocket extends EventEmitter {
  destroyed = false;
  private pending = "";
  private inData = false;
  private dataLines: string[] = [];
  private mailFrom = "";
  private rcpts: string[] = [];
  private authStep: "none" | "user" | "pass" = "none";
  readonly connection: Connection;

  constructor(kind: "smtp" | "imap", host: string, port: number, private readonly script: ImapScript) {
    super();
    this.connection = { kind, host, port, commands: [], raw: "", messages: [] };
    setImmediate(() => this.reply(kind === "smtp" ? `220 fake.smtp ready${CRLF}` : `* OK fake imap ready${CRLF}`));
  }

  /** The client's write: record it, then answer line by line like a real server. */
  write(chunk: string | Uint8Array): boolean {
    if (this.destroyed) return false;
    const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    this.connection.raw += text;
    this.pending += text;
    let at: number;
    while ((at = this.pending.indexOf(CRLF)) >= 0) {
      const line = this.pending.slice(0, at);
      this.pending = this.pending.slice(at + 2);
      if (this.connection.kind === "smtp") this.smtpLine(line);
      else this.imapLine(line);
    }
    return true;
  }

  end(): void {
    this.destroy();
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }

  setEncoding(): this {
    return this;
  }

  private reply(text: string): void {
    if (this.destroyed) return;
    setImmediate(() => { if (!this.destroyed) this.emit("data", Buffer.from(text)); });
  }

  // --- SMTP ------------------------------------------------------------------

  private smtpLine(line: string): void {
    if (this.inData) {
      if (line === ".") {
        this.inData = false;
        // A server undoes dot-stuffing: one leading dot is removed from each line that has two.
        const data = this.dataLines.map((l) => (l.startsWith("..") ? l.slice(1) : l)).join(CRLF);
        this.connection.messages.push({ from: this.mailFrom, rcpts: [...this.rcpts], data });
        this.dataLines = [];
        this.mailFrom = "";
        this.rcpts = [];
        return this.reply(`250 queued${CRLF}`);
      }
      this.dataLines.push(line);
      return;
    }
    if (this.authStep === "user") {
      this.authStep = "pass";
      this.connection.smtpAuth = { user: Buffer.from(line, "base64").toString(), pass: "" };
      return this.reply(`334 UGFzc3dvcmQ6${CRLF}`);
    }
    if (this.authStep === "pass") {
      this.authStep = "none";
      this.connection.smtpAuth = { user: this.connection.smtpAuth?.user ?? "", pass: Buffer.from(line, "base64").toString() };
      return this.reply(`235 authenticated${CRLF}`);
    }
    this.connection.commands.push(line);
    const verb = line.split(/[ :]/)[0]!.toUpperCase();
    switch (verb) {
      case "EHLO": return this.reply(`250 fake.smtp${CRLF}`);
      case "AUTH": this.authStep = "user"; return this.reply(`334 VXNlcm5hbWU6${CRLF}`);
      case "MAIL": this.mailFrom = /<([^>]*)>/.exec(line)?.[1] ?? ""; return this.reply(`250 ok${CRLF}`);
      case "RCPT": this.rcpts.push(/<([^>]*)>/.exec(line)?.[1] ?? ""); return this.reply(`250 ok${CRLF}`);
      case "DATA": this.inData = true; return this.reply(`354 end with <CRLF>.<CRLF>${CRLF}`);
      case "QUIT": return this.reply(`221 bye${CRLF}`);
      // A server that does not recognise a line says so; the client treats >= 400 as failure.
      default: return this.reply(`502 unknown command${CRLF}`);
    }
  }

  // --- IMAP ------------------------------------------------------------------

  private imapLine(line: string): void {
    const match = /^(\S+) (\S+)(?: (.*))?$/.exec(line);
    if (!match) return this.reply(`* BAD unparseable${CRLF}`);
    const [, tag, verbRaw, args = ""] = match as unknown as [string, string, string, string?];
    const verb = verbRaw.toUpperCase();
    this.connection.commands.push(line);
    switch (verb) {
      case "LOGIN":
        this.connection.imapLogin = parseTwoQuotedStrings(args);
        return this.reply(`${tag} OK logged in${CRLF}`);
      case "SELECT": return this.reply(`* 3 EXISTS${CRLF}* 0 RECENT${CRLF}${tag} OK [READ-WRITE] selected${CRLF}`);
      case "SEARCH": return this.reply(`* SEARCH ${this.script.searchHits.join(" ")}${CRLF}${tag} OK done${CRLF}`);
      case "FETCH": {
        const uid = /^(\d+)/.exec(args)?.[1] ?? "1";
        const raw = `From: a@example.test${CRLF}To: b@example.test${CRLF}Subject: s${uid}${CRLF}Date: today${CRLF}${CRLF}body ${uid}`;
        return this.reply(`* ${uid} FETCH (FLAGS (\\Seen) RFC822 {${raw.length}}${CRLF}${raw})${CRLF}${tag} OK done${CRLF}`);
      }
      // Every other command, a destructive one included, a permissive server runs.
      default: return this.reply(`${tag} OK ${verb} done${CRLF}`);
    }
  }
}

export interface ImapScript {
  searchHits: number[];
}

/** Parse `"a\"b" "c\\d"` the way an IMAP server does; anything else is malformed (a server would answer BAD). */
export function parseTwoQuotedStrings(text: string): { user: string; pass: string } | "malformed" {
  const strings: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === " ") { i++; continue; }
    if (text[i] !== '"') return "malformed";
    i++;
    let value = "";
    for (;;) {
      if (i >= text.length) return "malformed";
      const ch = text[i]!;
      if (ch === "\\") {
        const next = text[i + 1];
        if (next !== '"' && next !== "\\") return "malformed";
        value += next;
        i += 2;
        continue;
      }
      if (ch === '"') { i++; break; }
      value += ch;
      i++;
    }
    strings.push(value);
  }
  return strings.length === 2 ? { user: strings[0]!, pass: strings[1]! } : "malformed";
}

/** Un-quote one IMAP quoted string argument, e.g. the criteria after `TEXT `; null when it is not exactly one. */
export function unquoteImapString(text: string): string | null {
  const parsed = parseTwoQuotedStrings(`${text} ""`);
  return parsed === "malformed" ? null : parsed.user;
}

export interface FakeMailNetwork {
  connections: Connection[];
  /** Restore the real `tls.connect`. */
  restore(): void;
}

/** Replace `tls.connect` for the mail clients. Which fake answers is decided by the port the client dials. */
export function installFakeMailNetwork(options: { imapPort?: number; smtpPort?: number; searchHits?: number[] } = {}): FakeMailNetwork {
  const imapPort = options.imapPort ?? 993;
  const smtpPort = options.smtpPort ?? 465;
  const original = tls.connect;
  const connections: Connection[] = [];
  (tls as unknown as { connect: unknown }).connect = (port: number, host: string, _options?: unknown, callback?: () => void) => {
    const kind = port === smtpPort ? "smtp" : port === imapPort ? "imap" : null;
    if (kind === null) throw new Error(`the fake mail network does not serve port ${port}`);
    const socket = new FakeSocket(kind, host, port, { searchHits: options.searchHits ?? [1, 2] });
    connections.push(socket.connection);
    if (callback) setImmediate(callback);
    return socket as unknown as tls.TLSSocket;
  };
  return {
    connections,
    restore() {
      (tls as unknown as { connect: unknown }).connect = original;
    },
  };
}
