/**
 * F3 review (Sprint 5 hotfix). 1: the gate judged a fetch's URL without its fragment, but web_fetch sent the raw URL, and
 * with a Firecrawl key the whole URL, fragment included, went to a third party: `https://named.example/#<data>` passed as
 * the page the owner named. The tools now send the URL the gate judged. 2: the front-page rule ignored port and userinfo;
 * it now compares origins.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { decide } from "../src/policy/engine";
import { resetPolicyHooks } from "../src/policy/hooks";
import { noopAuditSink, setAuditSink } from "../src/policy/audit-sink";
import { addTaint } from "../src/policy/context";
import { originsNamedIn } from "../src/policy/egress";
import type { Decision, RunContext } from "../src/policy/types";
import { buildTaskToolRegistry } from "../src/tools/task-registry";
import { webFetch } from "../src/tools/web";
import { policyRig, type PolicyRig } from "./policy-fixture";

const ctx = { threadID: "thr_f3r", turnID: "trn_f3r", signal: new AbortController().signal };

describe("the fetch tools send the URL the gate judged", () => {
  const realFetch = globalThis.fetch;
  const saved = { key: process.env.AGNI_FIRECRAWL_API_KEY, url: process.env.AGNI_FIRECRAWL_URL };
  let sent: string[] = [];
  let db: Database | undefined;
  beforeEach(() => {
    sent = [];
    process.env.AGNI_FIRECRAWL_API_KEY = "fc-test-key";
    delete process.env.AGNI_FIRECRAWL_URL;
    globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
      sent.push(`${String(input)} ${String(init?.body ?? "")}`);
      return new Response(JSON.stringify({ data: { markdown: "page text", metadata: { title: "Page" } } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (saved.key === undefined) delete process.env.AGNI_FIRECRAWL_API_KEY; else process.env.AGNI_FIRECRAWL_API_KEY = saved.key;
    if (saved.url === undefined) delete process.env.AGNI_FIRECRAWL_URL; else process.env.AGNI_FIRECRAWL_URL = saved.url;
    db?.close();
    db = undefined;
  });

  test("the web_fetch handler sends Firecrawl the URL without its fragment", async () => {
    db = openDatabase(":memory:");
    const handler = buildTaskToolRegistry(db).get("web_fetch")!.handler as (args: unknown, ctx: unknown) => Promise<{ url: string }>;
    const result = await handler({ url: "https://93.184.216.34/page#private-notes" }, ctx);
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("https://api.firecrawl.dev/v1/scrape");
    expect(sent[0]).toContain('"url":"https://93.184.216.34/page"');
    expect(sent.join("\n")).not.toContain("private-notes");
    expect(result.url).toBe("https://93.184.216.34/page");
  });

  test("webFetch itself drops a fragment before it calls Firecrawl", async () => {
    await webFetch({ url: "https://93.184.216.34/page#private-notes" });
    expect(sent.join("\n")).not.toContain("private-notes");
  });

  test("the handlers refuse a URL that does not normalise", async () => {
    db = openDatabase(":memory:");
    const registry = buildTaskToolRegistry(db);
    for (const name of ["web_fetch", "link_save"]) {
      const handler = registry.get(name)!.handler as (args: unknown, ctx: unknown) => Promise<unknown>;
      await expect(handler({ url: "ftp://example.com/file" }, ctx), name).rejects.toThrow(/http or https URL/);
    }
    expect(sent).toEqual([]);
  });

  test("link_save stores the URL the gate judged", async () => {
    db = openDatabase(":memory:");
    const handler = buildTaskToolRegistry(db).get("link_save")!.handler as (args: unknown, ctx: unknown) => Promise<{ url: string }>;
    const saved = await handler({ url: "https://blocked.invalid/x#private-notes" }, { ...ctx, hostAllowed: () => true });
    expect(saved.url).toBe("https://blocked.invalid/x");
    expect(JSON.stringify(db.query("SELECT url FROM links").all())).not.toContain("private-notes");
  });
});

describe("the front page of a named host is matched by origin", () => {
  let rig: PolicyRig;
  beforeEach(() => { rig = policyRig(); });
  afterEach(() => { rig.close(); resetPolicyHooks(); setAuditSink(noopAuditSink); });
  const act = (run: RunContext, url: string): Decision => decide(run, { tool: "web_fetch", args: { url }, callID: "call_f3r" });
  const tainted = (run: RunContext): RunContext => { addTaint(run, { kind: "web", label: "evil.example/post", tool: "web_fetch", at: "2026-11-18T10:00:00Z" }); return run; };

  test("same origin's front page runs; another port, scheme or userinfo does not", () => {
    const run = tainted(rig.another({ ownerText: ["summarize https://evil.example/post for me"] }));
    expect(act(run, "https://evil.example/").action).toBe("run");
    expect(act(run, "https://evil.example:8443/").action).toBe("ask");
    expect(act(run, "http://evil.example/").action).toBe("ask");
    expect(act(run, "https://attacker@evil.example/").action).not.toBe("run");
    expect(act(run, "https://a:b@evil.example/").action).not.toBe("run");
  });

  test("a bare host names both schemes on the default port only", () => {
    const run = tainted(rig.another({ ownerText: ["have a look at www.example.org"] }));
    expect(act(run, "https://www.example.org/").action).toBe("run");
    expect(act(run, "http://www.example.org/").action).toBe("run");
    expect(act(run, "https://www.example.org:444/").action).toBe("ask");
  });

  test("originsNamedIn", () => {
    expect([...originsNamedIn(["see https://Evil.Example:8443/post and www.example.org, not install.sh"])].sort()).toEqual([
      "http://www.example.org", "https://evil.example:8443", "https://www.example.org",
    ]);
  });
});
