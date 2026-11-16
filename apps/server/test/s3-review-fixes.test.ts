import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db";
import { clientAddress } from "../src/auth/rate-limit";
import { mintToken, revokeDevice, verifyToken, SESSION_IDLE_MS } from "../src/auth/tokens";
import {
  REDACTED,
  MAX_SECRETS,
  redact,
  registerSecret,
  registerSecretsFromEnv,
  secretCount,
  unregisterSecret,
} from "../src/util/redact";
import { StreamRedactor } from "../src/util/redact-stream";
import { startHarness, type Harness } from "./ws-harness";

/** S3-5 review round: pairing proxy trust, /health nosniff, redaction gaps, session idle expiry, revoke wildcards. */

const registered: string[] = [];
function secret(value: string): string {
  registered.push(value);
  registerSecret(value);
  return value;
}

let harness: Harness | undefined;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["AGNI_TRUST_PROXY", "AGNI_REVIEW_TEST_API_KEY", "AGNI_REVIEW_TEST_PLAIN"];

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
  for (const value of registered.splice(0)) unregisterSecret(value);
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("pairing limit: X-Forwarded-For is believed only when the owner says a proxy is in front", () => {
  const pairWith = (base: string, headers: Record<string, string> = {}) => fetch(`${base}/auth/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base, ...headers },
    body: JSON.stringify({ code: "AAAA-AAAA", name: "x" }),
  });

  test("clientAddress ignores the header by default, even from a loopback peer", () => {
    expect(clientAddress("127.0.0.1", "198.51.100.7")).toBe("127.0.0.1");
    expect(clientAddress("::1", "198.51.100.7, 203.0.113.9")).toBe("::1");
  });

  test("clientAddress with the flag trusts only the last entry, and only from a loopback peer", () => {
    expect(clientAddress("127.0.0.1", "10.0.0.1, 198.51.100.7", true)).toBe("198.51.100.7");
    expect(clientAddress("192.0.2.5", "198.51.100.7", true)).toBe("192.0.2.5");
    expect(clientAddress("127.0.0.1", null, true)).toBe("127.0.0.1");
  });

  test("without the flag, a client that rotates X-Forwarded-For still shares one allowance", async () => {
    harness = await startHarness();
    for (let i = 0; i < 5; i++) expect((await pairWith(harness.base, { "x-forwarded-for": `198.51.100.${i}` })).status).toBe(401);
    expect((await pairWith(harness.base, { "x-forwarded-for": "203.0.113.200" })).status).toBe(429);
  });

  test("with AGNI_TRUST_PROXY=1 the proxy's entry names the caller, so another caller is not limited", async () => {
    process.env.AGNI_TRUST_PROXY = "1";
    harness = await startHarness();
    for (let i = 0; i < 5; i++) await pairWith(harness.base, { "x-forwarded-for": "198.51.100.7" });
    expect((await pairWith(harness.base, { "x-forwarded-for": "198.51.100.7" })).status).toBe(429);
    expect((await pairWith(harness.base, { "x-forwarded-for": "203.0.113.9" })).status).toBe(401);
  });

  test("the 20 a minute ceiling holds with the flag too", async () => {
    process.env.AGNI_TRUST_PROXY = "1";
    harness = await startHarness();
    let refused = 0;
    for (let i = 0; i < 40; i++) {
      if ((await pairWith(harness.base, { "x-forwarded-for": `192.0.2.${i}` })).status === 429) refused++;
    }
    expect(refused).toBe(20);
  });
});

describe("/health", () => {
  test("every answer carries nosniff: the liveness body, the full report and the 405", async () => {
    harness = await startHarness();
    const plain = await fetch(`${harness.base}/health`);
    expect(plain.status).toBe(200);
    expect(plain.headers.get("x-content-type-options")).toBe("nosniff");
    const paired = await fetch(`${harness.base}/health`, { headers: { authorization: `Bearer ${harness.token}` } });
    expect(paired.headers.get("x-content-type-options")).toBe("nosniff");
    const post = await fetch(`${harness.base}/health`, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("share routes", () => {
  test("an unpaired POST answers 401: the device check runs before the method check", async () => {
    harness = await startHarness();
    const response = await fetch(`${harness.base}/share/0123456789abcdef0123456789abcdef`, { method: "POST" });
    expect(response.status).toBe(401);
  });
});

describe("streamed text is redacted across token frames", () => {
  async function stream(deltas: string[], turnID = "t1"): Promise<{ joined: string; frames: string[] }> {
    harness = await startHarness();
    const client = await harness.connect();
    for (const delta of deltas) harness.server.emit({ type: "token", turnID, threadID: "th1", delta });
    harness.server.emit({ type: "turn.end", turnID, threadID: "th1", stopReason: "end" });
    await client.next("turn.end", { match: (frame) => frame.turnID === turnID });
    const frames = client.seen().flatMap((frame) => (frame.type === "token" && frame.turnID === turnID ? [frame.delta] : []));
    return { joined: frames.join(""), frames };
  }

  test("a secret split across three deltas never reaches the client", async () => {
    const key = secret("sk-split-ABCDEFGHIJKLMNOP-1234");
    const { joined, frames } = await stream(["the key is ", key.slice(0, 7), key.slice(7, 19), `${key.slice(19)} and more`]);
    expect(joined).toBe(`the key is ${REDACTED} and more`);
    for (const frame of frames) expect(frame).not.toContain(key.slice(0, 10));
  });

  test("plain text is delivered in full and in order before turn.end", async () => {
    secret("sk-unrelated-ZZZZZZZZZZZZ");
    const { joined } = await stream(["hello ", "there, ", "friend"]);
    expect(joined).toBe("hello there, friend");
  });

  test("with no secret registered a delta goes out at once, not held back", async () => {
    harness = await startHarness();
    const client = await harness.connect();
    const before = secretCount();
    harness.server.emit({ type: "token", turnID: "t2", threadID: "th1", delta: "immediate" });
    const frame = await client.next("token", { match: (f) => f.turnID === "t2" });
    expect(frame.delta).toBe("immediate");
    expect(secretCount()).toBe(before);
  });

  test("a reset drops the held tail of the narration it clears, and the next step streams normally", async () => {
    const key = secret("sk-reset-QQQQQQQQQQQQQQQQ");
    harness = await startHarness();
    const client = await harness.connect();
    harness.server.emit({ type: "token", turnID: "t3", threadID: "th1", delta: `thinking ${key.slice(0, 9)}` });
    harness.server.emit({ type: "token", turnID: "t3", threadID: "th1", delta: "", reset: true });
    harness.server.emit({ type: "token", turnID: "t3", threadID: "th1", delta: "answer" });
    harness.server.emit({ type: "turn.end", turnID: "t3", threadID: "th1", stopReason: "end" });
    await client.next("turn.end", { match: (f) => f.turnID === "t3" });
    const text = client.seen().flatMap((f) => (f.type === "token" ? [f.delta] : [])).join("");
    expect(text).not.toContain(key.slice(0, 9));
    expect(text.endsWith("answer")).toBe(true);
  });

  test("the hold-back costs little: 2000 short deltas through a 60-character secret", async () => {
    secret(`sk-perf-${"x".repeat(52)}`);
    harness = await startHarness();
    const start = performance.now();
    for (let i = 0; i < 2000; i++) harness.server.emit({ type: "token", turnID: "t4", threadID: "th1", delta: "word " });
    const perDelta = (performance.now() - start) / 2000;
    harness.server.emit({ type: "turn.end", turnID: "t4", threadID: "th1", stopReason: "end" });
    expect(perDelta).toBeLessThan(1);
  });
});

describe("StreamRedactor", () => {
  test("never splits a surrogate pair when it holds a tail back", () => {
    secret("😀-emoji-secret-value");
    const stream = new StreamRedactor();
    const out = stream.push("k", "ok 😀-emoji");
    expect(out).toBe("ok ");
    expect(stream.push("k", "-secret-value!")).toBe(`${REDACTED}!`);
    expect(stream.flush("k")).toBe("");
  });

  test("a held tail that never completes is released at the end of the stream", () => {
    secret("sk-never-completes-123456");
    const stream = new StreamRedactor();
    expect(stream.push("k", "see sk-never")).toBe("see ");
    expect(stream.flush("k")).toBe("sk-never");
  });
});

describe("registering secrets from the environment", () => {
  test("a secret-named variable is registered at server start; a plain one is not", async () => {
    const value = "sk-env-registered-98765432";
    process.env.AGNI_REVIEW_TEST_API_KEY = value;
    process.env.AGNI_REVIEW_TEST_PLAIN = "some-long-plain-setting-value";
    harness = await startHarness();
    registered.push(value);
    expect(redact(`error from provider: ${value}`)).toBe(`error from provider: ${REDACTED}`);
    expect(redact("some-long-plain-setting-value")).toBe("some-long-plain-setting-value");
    unregisterSecret("some-long-plain-setting-value");
  });

  test("the process PATH is never treated as a secret", async () => {
    harness = await startHarness();
    const path = process.env.PATH ?? process.env.Path ?? "";
    expect(redact(path)).toBe(path);
  });

  test("registerSecretsFromEnv skips unset and short values", () => {
    const env = { A_API_KEY: "sk-from-env-0123456789", B_API_KEY: "short", C_API_KEY: undefined };
    registered.push(env.A_API_KEY);
    registerSecretsFromEnv(["A_API_KEY", "B_API_KEY", "C_API_KEY", "D_API_KEY"], env);
    expect(redact(env.A_API_KEY)).toBe(REDACTED);
    expect(redact("short")).toBe("short");
  });
});

describe("device tokens are registered", () => {
  test("a token is masked once it is issued, and a token verified later is masked too", async () => {
    const db = openDatabase(":memory:");
    try {
      const { token } = await mintToken(db, "phone");
      registered.push(token);
      expect(redact(`Authorization: Bearer ${token}`)).toBe(`Authorization: Bearer ${REDACTED}`);
      unregisterSecret(token);
      expect(redact(token)).toBe(token);
      expect(await verifyToken(db, token)).not.toBeNull();
      expect(redact(token)).toBe(REDACTED);
    } finally {
      db.close();
    }
  });
});

describe("partial base64: the secret encoded inside a longer string", () => {
  const key = "sk-partial-KLMNOPQRSTUV-5678";
  test.each([0, 1, 2])("at byte offset %i, with every suffix length", (offset) => {
    secret(key);
    for (const suffix of ["", "x", "xy", "xyz"]) {
      const text = `${"a".repeat(offset)}${key}${suffix}`;
      for (const encode of [(b: Buffer) => b.toString("base64"), (b: Buffer) => b.toString("base64url")]) {
        const encoded = encode(Buffer.from(text));
        const out = redact(`data: ${encoded}`);
        expect(out).toContain(REDACTED);
      }
    }
  });
});

describe("registry capacity", () => {
  test("running out of room throws instead of silently leaving a secret unmasked", () => {
    const room = MAX_SECRETS - secretCount();
    for (let i = 0; i < room; i++) secret(`capacity-filler-${i}-${"y".repeat(10)}`);
    expect(secretCount()).toBe(MAX_SECRETS);
    expect(() => registerSecret("one-secret-too-many-12345")).toThrow(/secret/i);
    // Re-registering a known value is still fine.
    expect(() => registerSecret(`capacity-filler-0-${"y".repeat(10)}`)).not.toThrow();
  });
});

describe("session idle expiry (30 days, sliding)", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

  test("the limit is 30 days", () => {
    expect(SESSION_IDLE_MS).toBe(30 * DAY);
  });

  test("a token unused for 31 days is refused, one used 29 days ago is accepted", async () => {
    const db = openDatabase(":memory:");
    try {
      const stale = await mintToken(db, "stale");
      const fresh = await mintToken(db, "fresh");
      db.run("UPDATE devices SET last_seen_at = ?, created_at = ? WHERE id = ?", [iso(31 * DAY), iso(90 * DAY), stale.device.id]);
      db.run("UPDATE devices SET last_seen_at = ?, created_at = ? WHERE id = ?", [iso(29 * DAY), iso(90 * DAY), fresh.device.id]);
      expect(await verifyToken(db, stale.token)).toBeNull();
      expect(await verifyToken(db, fresh.token)).not.toBeNull();
    } finally {
      db.close();
    }
  });

  test("a device never seen is judged by when it was created", async () => {
    const db = openDatabase(":memory:");
    try {
      const old = await mintToken(db, "old");
      db.run("UPDATE devices SET created_at = ?, last_seen_at = NULL WHERE id = ?", [iso(31 * DAY), old.device.id]);
      expect(await verifyToken(db, old.token)).toBeNull();
      const brandNew = await mintToken(db, "new");
      expect(await verifyToken(db, brandNew.token)).not.toBeNull();
    } finally {
      db.close();
    }
  });

  test("last_seen_at slides forward, but at most once an hour", async () => {
    const db = openDatabase(":memory:");
    try {
      const { token, device } = await mintToken(db, "phone");
      const seen = (): string | null => db.query<{ last_seen_at: string | null }, [string]>("SELECT last_seen_at FROM devices WHERE id = ?").get(device.id)?.last_seen_at ?? null;
      await verifyToken(db, token);
      const first = seen();
      expect(first).not.toBeNull();
      await Bun.sleep(5);
      await verifyToken(db, token);
      expect(seen()).toBe(first);
      const older = iso(2 * 60 * 60 * 1000);
      db.run("UPDATE devices SET last_seen_at = ? WHERE id = ?", [older, device.id]);
      await verifyToken(db, token);
      expect(seen()).not.toBe(older);
    } finally {
      db.close();
    }
  });

  test("revoking still works, and a revoked token stays refused", async () => {
    const db = openDatabase(":memory:");
    try {
      const { token, device } = await mintToken(db, "phone");
      expect(revokeDevice(db, device.id)?.revoked_at).not.toBeNull();
      expect(await verifyToken(db, token)).toBeNull();
    } finally {
      db.close();
    }
  });

  test("an open socket keeps the device alive: the revocation sweep slides last_seen_at", async () => {
    harness = await startHarness();
    await harness.connect();
    const device = harness.db.query<{ id: string }, []>("SELECT id FROM devices LIMIT 1").get();
    harness.db.run("UPDATE devices SET last_seen_at = ? WHERE id = ?", [iso(20 * DAY), device?.id ?? ""]);
    await Bun.sleep(2600);
    const row = harness.db.query<{ last_seen_at: string }, [string]>("SELECT last_seen_at FROM devices WHERE id = ?").get(device?.id ?? "");
    expect(Date.now() - Date.parse(row?.last_seen_at ?? "")).toBeLessThan(DAY);
  });
});

describe("revokeDevice prefix match", () => {
  test("a LIKE wildcard never matches a device", async () => {
    const db = openDatabase(":memory:");
    try {
      const a = await mintToken(db, "a");
      const b = await mintToken(db, "b");
      for (const wildcard of ["%", "dev%", "d_v", "_", "dev_%"]) {
        expect(revokeDevice(db, wildcard)).toBeNull();
      }
      expect(revokeDevice(db, "")).toBeNull();
      const rows = db.query<{ revoked_at: string | null }, []>("SELECT revoked_at FROM devices").all();
      expect(rows.every((row) => row.revoked_at === null)).toBe(true);
      // A real prefix and an exact id still work.
      expect(revokeDevice(db, a.device.id.slice(0, 12))?.id).toBe(a.device.id);
      expect(revokeDevice(db, b.device.id)?.id).toBe(b.device.id);
    } finally {
      db.close();
    }
  });
});
