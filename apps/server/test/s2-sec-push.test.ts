/**
 * Sprint 2 security round, item 4 (push): a Web Push subscription is a URL the server will POST to, so it is
 * accepted only when it is an https address of a public host with well-formed keys, and checked again (with a
 * fresh lookup) when a push is sent.
 */
import { createECDH } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { createFetchSender, pushEndpointProblem, assertPublicPushEndpoint, subscriptionProblem } from "../src/push/web-push";
import { resolver } from "../src/tools/fetch-url";
import { startHarness, type Harness } from "./ws-harness";

const ecdh = createECDH("prime256v1");
ecdh.generateKeys();
const GOOD_KEYS = { p256dh: ecdh.getPublicKey().toString("base64url"), auth: Buffer.from("0123456789abcdef").toString("base64url") };

let harness: Harness | undefined;
const realLookup = resolver.lookup;
afterEach(async () => {
  await harness?.stop(); harness = undefined;
  resolver.lookup = realLookup;
});

describe("an endpoint the server may post to", () => {
  const REFUSED: Array<[string, string]> = [
    ["plain http", "http://push.example.com/abc"],
    ["a loopback address", "https://127.0.0.1/abc"],
    ["a private address", "https://10.0.0.5/abc"],
    ["the cloud metadata address", "https://169.254.169.254/latest"],
    ["a private IPv6 address", "https://[fd00::1]/abc"],
    ["an IPv4-mapped loopback address", "https://[::ffff:7f00:1]/abc"],
    ["localhost", "https://localhost/abc"],
    ["a name under .localhost", "https://push.localhost/abc"],
    ["a .local name", "https://printer.local/abc"],
    ["a .internal name", "https://api.internal/abc"],
    ["a name with no dot", "https://intranet/abc"],
    ["credentials in the address", "https://user:pass@push.example.com/abc"],
    ["an odd port", "https://push.example.com:8443/abc"],
    ["another scheme", "ftp://push.example.com/abc"],
    ["something that is not an address", "not a url"],
  ];
  for (const [name, endpoint] of REFUSED) {
    test(`${name} is refused`, () => {
      expect(pushEndpointProblem(endpoint)).not.toBeNull();
    });
  }

  test("an https address of a named host is accepted", () => {
    expect(pushEndpointProblem("https://fcm.googleapis.com/fcm/send/abc")).toBeNull();
    expect(pushEndpointProblem("https://updates.push.services.mozilla.com:443/wpush/v2/abc")).toBeNull();
  });

  test("a name that resolves to a private address is refused when a push is sent", async () => {
    resolver.lookup = (async () => [{ address: "10.1.2.3", family: 4 }]) as never;
    await expect(assertPublicPushEndpoint("https://push.example.com/abc")).rejects.toThrow(/private|reserved|blocked/);
    resolver.lookup = (async () => [{ address: "8.8.8.8", family: 4 }, { address: "192.168.0.9", family: 4 }]) as never;
    await expect(assertPublicPushEndpoint("https://push.example.com/abc")).rejects.toThrow(/private|reserved|blocked/);
    resolver.lookup = (async () => [{ address: "8.8.8.8", family: 4 }]) as never;
    await expect(assertPublicPushEndpoint("https://push.example.com/abc")).resolves.toBeUndefined();
  });

  test("the default sender checks the endpoint before it sends", async () => {
    let requests = 0;
    const real = globalThis.fetch;
    globalThis.fetch = (async () => { requests++; return new Response(null, { status: 201 }); }) as unknown as typeof fetch;
    try {
      await expect(createFetchSender()("https://127.0.0.1/abc", { method: "POST", headers: {}, body: new Uint8Array() })).rejects.toThrow();
      expect(requests).toBe(0);
    } finally { globalThis.fetch = real; }
  });
});

describe("the keys of a subscription", () => {
  test("well-formed keys are accepted", () => {
    expect(subscriptionProblem({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: GOOD_KEYS })).toBeNull();
  });

  const BAD: Array<[string, { p256dh: string; auth: string }]> = [
    ["not base64url", { ...GOOD_KEYS, p256dh: "not base64url!!" }],
    ["a p256dh of the wrong length", { ...GOOD_KEYS, p256dh: Buffer.alloc(33, 1).toString("base64url") }],
    ["an auth secret of the wrong length", { ...GOOD_KEYS, auth: Buffer.alloc(8, 1).toString("base64url") }],
  ];
  for (const [name, keys] of BAD) {
    test(`${name} is refused`, () => {
      expect(subscriptionProblem({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys })).not.toBeNull();
    });
  }
});

describe("push.subscribe over the socket", () => {
  test("a subscription to a private address is answered with an error and stores nothing", async () => {
    harness = await startHarness();
    const client = await harness.connect();
    client.send({ type: "push.subscribe", subscription: { endpoint: "https://127.0.0.1:9/abc", keys: GOOD_KEYS } });
    const error = await client.next("error");
    expect(error.code).toBe("bad_subscription");
    expect(harness.db.query("SELECT count(*) AS n FROM push_subscriptions").get()).toEqual({ n: 0 });
  });

  test("a good subscription is stored", async () => {
    harness = await startHarness();
    const client = await harness.connect();
    client.send({ type: "push.subscribe", subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: GOOD_KEYS } });
    // push.subscribe has no answer; the next request that does is the sync point.
    client.send({ type: "push.vapid.get" });
    await client.next("push.vapid").catch(() => undefined);
    await Bun.sleep(50);
    expect(harness.db.query("SELECT count(*) AS n FROM push_subscriptions").get()).toEqual({ n: 1 });
  });
});
