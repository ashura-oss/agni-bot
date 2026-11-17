import { afterEach, describe, expect, test } from "bun:test";
import { redact, registerSecret, REDACTED, MIN_SECRET_LENGTH } from "../src/util/redact";
import { unregisterSecret } from "../src/util/redact-core";
import { log } from "../src/log";
import { openDatabase } from "../src/db";
import { appendMessage, createThread, titleThreadFromFirstMessage } from "../src/stores/threads";
import { startHarness, type Harness } from "./ws-harness";

/** S3-03: the redaction registry, and the three places it is applied. */

const registered: string[] = [];
function secret(value: string): string {
  registered.push(value);
  registerSecret(value);
  return value;
}
afterEach(() => {
  for (const value of registered.splice(0)) unregisterSecret(value);
});

describe("redact", () => {
  test("replaces a registered value everywhere it appears", () => {
    const key = secret("sk-test-AAAA1111BBBB2222");
    expect(redact(`key=${key} and again ${key}.`)).toBe(`key=${REDACTED} and again ${REDACTED}.`);
  });

  test("leaves text alone when nothing is registered that occurs in it", () => {
    expect(redact("nothing to see here")).toBe("nothing to see here");
  });

  test("masks the common encodings of a secret, not only the raw value", () => {
    const key = secret("p@ss/word+with spaces&more=1");
    const b64 = Buffer.from(key).toString("base64");
    const b64url = Buffer.from(key).toString("base64url");
    const url = encodeURIComponent(key);
    expect(redact(`Authorization: Basic ${b64}`)).toBe(`Authorization: Basic ${REDACTED}`);
    expect(redact(`token=${b64url}`)).toBe(`token=${REDACTED}`);
    expect(redact(`?key=${url}`)).toBe(`?key=${REDACTED}`);
  });

  test("masks the JSON-escaped form, so a secret with quotes cannot leak through a JSON frame", () => {
    const key = secret('abc"def\\ghi\nline-two-xyz');
    const encoded = JSON.stringify({ text: key });
    expect(encoded).not.toContain(key);
    const out = redact(encoded);
    expect(out).not.toContain("abc\\\"def");
    expect(JSON.parse(out)).toEqual({ text: REDACTED });
  });

  test("a value shorter than the minimum is not registered, so ordinary words stay readable", () => {
    const short = "a".repeat(MIN_SECRET_LENGTH - 1);
    registerSecret(short);
    registerSecret("");
    expect(redact(`${short} is fine and so is a`)).toBe(`${short} is fine and so is a`);
  });

  test("a longer secret that contains a shorter one is masked as a whole", () => {
    const inner = secret("innersecret1");
    const outer = secret("innersecret1-and-more-tail");
    expect(redact(`x ${outer} y ${inner} z`)).toBe(`x ${REDACTED} y ${REDACTED} z`);
  });

  test("unregister stops masking", () => {
    const key = secret("temporary-secret-9999");
    unregisterSecret(key);
    expect(redact(key)).toBe(key);
  });

  test("scanning cost stays small: 100 KB of text against 50 secrets", () => {
    for (let i = 0; i < 50; i++) secret(`perf-secret-${i}-${"x".repeat(24)}`);
    const text = "lorem ipsum dolor sit amet ".repeat(4000);
    const start = performance.now();
    for (let i = 0; i < 20; i++) redact(text);
    const perCall = (performance.now() - start) / 20;
    // Cost model: O(variants x length) native substring scans. Generous bound for a loaded CI machine.
    expect(perCall).toBeLessThan(50);
  });
});

describe("log", () => {
  test("a secret never reaches the console through the logger", () => {
    const key = secret("sk-log-leak-1234567890");
    const lines: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.join(" ")); };
    try {
      log.error(`provider rejected ${key}`, new Error(`bad key ${key}`), { header: key });
    } finally {
      console.error = originalError;
    }
    expect(lines.length).toBe(1);
    expect(lines[0]).not.toContain(key);
    expect(lines[0]).toContain(REDACTED);
  });
});

describe("stores/threads writes", () => {
  test("message text, thread titles and generated titles are stored redacted", () => {
    const key = secret("sk-store-leak-0987654321");
    const db = openDatabase(":memory:");
    try {
      const thread = createThread(db, "ea", `title ${key}`);
      expect(thread.title).toBe(`title ${REDACTED}`);
      const message = appendMessage(db, { threadID: thread.id, role: "user", text: `my key is ${key}` });
      expect(message.text).toBe(`my key is ${REDACTED}`);
      const stored = db.query<{ text: string }, [string]>("SELECT text FROM messages WHERE id = ?").get(message.id);
      expect(stored?.text).toBe(`my key is ${REDACTED}`);
      const untitled = createThread(db, "ea");
      titleThreadFromFirstMessage(db, untitled.id, `hello ${key}`);
      const row = db.query<{ title: string }, [string]>("SELECT title FROM threads WHERE id = ?").get(untitled.id);
      expect(row?.title).toBe(`hello ${REDACTED}`);
      expect(JSON.stringify(db.query("SELECT * FROM messages").all())).not.toContain(key);
    } finally {
      db.close();
    }
  });
});

describe("frame emission", () => {
  let harness: Harness | undefined;
  afterEach(async () => {
    await harness?.stop();
    harness = undefined;
  });

  test("a frame sent to a client, live or replayed, carries no registered secret", async () => {
    const key = secret("sk-frame-leak-abcdef123456");
    harness = await startHarness();
    const client = await harness.connect();
    harness.server.emit({ type: "notify", title: `Key ${key}`, body: `body "${key}"`, sound: false });
    const live = await client.next("notify");
    expect(JSON.stringify(live)).not.toContain(key);
    expect(live.title).toBe(`Key ${REDACTED}`);
    // The same frame replayed to a reconnecting client is masked too.
    const second = await harness.connect({ resyncFrom: 0 });
    const replayed = await second.next("notify");
    expect(JSON.stringify(replayed)).not.toContain(key);
  });
});

describe("debug API", () => {
  let harness: Harness | undefined;
  afterEach(async () => {
    await harness?.stop();
    harness = undefined;
  });

  test("raw job results and tool output on the debug screen are masked", async () => {
    const key = secret("sk-debug-leak-5555666677");
    harness = await startHarness();
    harness.db.run(
      "INSERT INTO jobs (id, kind, payload, state, run_at, created_at, updated_at, result) VALUES ('j1', 'routine', ?, 'done', 'now', 'now', 'now', ?)",
      [JSON.stringify({ title: `with ${key}` }), `failed: bad key ${key} "${key}"`],
    );
    const response = await fetch(`${harness.base}/debug/overview`, { headers: { authorization: `Bearer ${harness.token}` } });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(key);
    expect(text).toContain(REDACTED);
    expect(() => JSON.parse(text)).not.toThrow();
  });
});
