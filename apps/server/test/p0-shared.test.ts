import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extraHelpLines, mergeCommandTables, runExtraCommand, type CommandTable } from "../src/cli/extra-commands";
import { s2Commands } from "../src/cli/s2-commands";
import { s3Commands } from "../src/cli/s3-commands";
import { openDatabase } from "../src/db";
import { HealthTracker } from "../src/models/health";
import type { ProviderConfig } from "../src/models/providers";
import { Router } from "../src/models/router";
import { recordModelUsage, setUsageRecorder, type ModelUsageEvent } from "../src/models/usage-hook";
import { audit, setAuditSink, type AuditEvent, type AuditSink } from "../src/policy/audit-sink";
import type { ToolMeta } from "../src/policy/tool-meta";
import { startupS2 } from "../src/startup/s2";
import { startupS2Audit } from "../src/startup/s2-audit";
import { startupS2Ledger } from "../src/startup/s2-ledger";
import { startupS3Vault } from "../src/startup/s3-vault";
import { startupS3 } from "../src/startup/s3";
import { runStartupHooks } from "../src/startup";
import { registerSecret, redact } from "../src/util/redact";

const noopSink: AuditSink = { record() {} };
afterEach(() => {
  setAuditSink(noopSink);
  setUsageRecorder(() => {});
});

describe("P0 extra CLI commands", () => {
  test("both sprint tables are well formed, whatever commands the sprints have filled in", () => {
    for (const table of [s2Commands, s3Commands]) {
      expect(Object.keys(table).sort()).toEqual(["commands", "help"]);
      for (const run of Object.values(table.commands)) expect(typeof run).toBe("function");
      for (const line of table.help) expect(typeof line).toBe("string");
    }
  });

  test("runExtraCommand runs a command from an injected table and passes its args", async () => {
    const seen: string[][] = [];
    const table: CommandTable = { commands: { hello: async (args) => { seen.push(args); } }, help: [] };
    expect(await runExtraCommand("hello", ["a", "b"], [table])).toBe(true);
    expect(seen).toEqual([["a", "b"]]);
  });

  test("extraHelpLines joins the help of every table in order", () => {
    const a: CommandTable = { commands: {}, help: ["  one   first"] };
    const b: CommandTable = { commands: {}, help: ["  two   second", "  three third"] };
    expect(extraHelpLines([a, b])).toEqual(["  one   first", "  two   second", "  three third"]);
    expect(extraHelpLines()).toEqual([...s2Commands.help, ...s3Commands.help]);
  });

  test("mergeCommandTables spreads commands, concatenates help, and throws on a duplicate name", () => {
    const a: CommandTable = { commands: { one: () => {} }, help: ["  one"] };
    const b: CommandTable = { commands: { two: () => {} }, help: ["  two"] };
    const merged = mergeCommandTables(a, b);
    expect(Object.keys(merged.commands)).toEqual(["one", "two"]);
    expect(merged.help).toEqual(["  one", "  two"]);
    expect(() => mergeCommandTables(a, { commands: { one: () => {} }, help: [] })).toThrow(/duplicate CLI command "one"/);
  });

  test("runExtraCommand returns false for a command no table knows", async () => {
    expect(await runExtraCommand("nope", [])).toBe(false);
  });

  test("the real entry point runs a command that only an extra table has, and lists its help", async () => {
    const home = mkdtempSync(join(tmpdir(), "agni-p0-home-"));
    const run = async (...argv: string[]) => {
      const proc = Bun.spawn(
        ["bun", "--preload", join(import.meta.dir, "p0-extra-preload.ts"), join(import.meta.dir, "../src/index.ts"), ...argv],
        { env: { ...process.env, AGNI_HOME: home }, stdout: "pipe", stderr: "pipe" },
      );
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { out, err, code };
    };
    try {
      const ran = await run("p0-extra-probe", "x", "y");
      expect(ran.err).not.toContain("unknown command");
      expect(ran.out).toContain('p0-extra-probe ran with ["x","y"]');
      expect(ran.code).toBe(0);
      expect((await run("help")).out).toContain("p0-extra-probe     test-only command");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an unknown command still prints the unknown-command error and exits 1", async () => {
    const home = mkdtempSync(join(tmpdir(), "agni-p0-home-"));
    try {
      const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/index.ts"), "definitely-not-a-command"], {
        env: { ...process.env, AGNI_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      expect(code).toBe(1);
      expect(err).toContain('unknown command "definitely-not-a-command"');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("P0 startup hooks", () => {
  test("runStartupHooks calls each hook once, in order, with the same context", async () => {
    const calls: string[] = [];
    const ctx = { db: openDatabase(":memory:"), config: {} as never };
    await runStartupHooks(ctx, [
      async (c) => { calls.push("s2"); expect(c).toBe(ctx); },
      async (c) => { calls.push("s3"); expect(c).toBe(ctx); },
    ]);
    expect(calls).toEqual(["s2", "s3"]);
    // The real hooks are callable and resolve without effect.
    await startupS2Audit(ctx);
    await startupS2Ledger(ctx);
    await startupS3Vault(ctx);
    await startupS2(ctx);
    await startupS3(ctx);
    await runStartupHooks(ctx);
    ctx.db.close();
  });
});

describe("P0 tool-meta type", () => {
  test("a ToolMeta literal compiles with the frozen shape", () => {
    const meta: ToolMeta = {
      classes: ["private-reader", "effector"],
      tier: 2,
      resources: (args) => [{ kind: "path", value: String(args.path) }],
    };
    expect(meta.resources?.({ path: "/x" })).toEqual([{ kind: "path", value: "/x" }]);
  });
});

describe("P0 audit sink", () => {
  test("audit() is a no-op until setAuditSink replaces the sink", () => {
    expect(() => audit({ kind: "x", detail: {} })).not.toThrow();
    const seen: AuditEvent[] = [];
    setAuditSink({ record: (event) => { seen.push(event); } });
    audit({ kind: "tool.call", actor: "bot", turnID: "t1", detail: { n: 1 } });
    expect(seen).toEqual([{ kind: "tool.call", actor: "bot", turnID: "t1", detail: { n: 1 } }]);
  });
});

describe("P0 audit failure mode", () => {
  test("a sink that throws propagates to the caller (fail closed)", () => {
    setAuditSink({ record() { throw new Error("audit store down"); } });
    expect(() => audit({ kind: "x", detail: {} })).toThrow("audit store down");
  });
});

describe("P0 redact", () => {
  test("redact is the identity and registerSecret does nothing", () => {
    registerSecret("hunter2");
    expect(redact("the password is hunter2")).toBe("the password is hunter2");
    expect(redact("")).toBe("");
  });
});

describe("P0 usage hook", () => {
  const provider: ProviderConfig = { id: "groq", label: "Groq", baseUrl: "https://groq.test/v1", apiKey: "k", model: "fast-small" };
  const encoder = new TextEncoder();
  const ok = (): Response => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      // The client reads usage from a chunk that also carries a delta.
      const chunk = { choices: [{ delta: { content: "hi" } }], usage: { prompt_tokens: 7, completion_tokens: 3 } };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  }), { status: 200 });
  const options = { messages: [{ role: "user" as const, content: "hi" }], firstTokenTimeoutMs: 1000, onDelta: () => {} };

  test("recordModelUsage is a no-op by default", () => {
    expect(() => recordModelUsage({ provider: "p", model: "m", latencyMs: 1 })).not.toThrow();
  });

  test("the router reports exactly one usage event per successful completion", async () => {
    const events: ModelUsageEvent[] = [];
    setUsageRecorder((event) => { events.push(event); });
    const router = new Router([provider], new HealthTracker(), (async () => ok()) as unknown as typeof fetch);
    const result = await router.route(options);
    expect(result.inputTokens).toBe(7);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      provider: "groq",
      model: "fast-small",
      inputTokens: 7,
      outputTokens: 3,
      latencyMs: result.latencyMs,
    });
    expect(events[0]!.purpose).toBeUndefined();
  });

  test("a purpose on the route options reaches the recorder", async () => {
    const events: ModelUsageEvent[] = [];
    setUsageRecorder((event) => { events.push(event); });
    const router = new Router([provider], new HealthTracker(), (async () => ok()) as unknown as typeof fetch);
    await router.route({ ...options, purpose: "summary" });
    expect(events[0]!.purpose).toBe("summary");
  });

  test("a recorder that throws does not fail the model call", async () => {
    setUsageRecorder(() => { throw new Error("ledger down"); });
    const router = new Router([provider], new HealthTracker(), (async () => ok()) as unknown as typeof fetch);
    expect((await router.route(options)).text).toBe("hi");
  });

  test("agent, job and kind on the route options reach the recorder", async () => {
    const events: ModelUsageEvent[] = [];
    setUsageRecorder((event) => { events.push(event); });
    const router = new Router([provider], new HealthTracker(), (async () => ok()) as unknown as typeof fetch);
    await router.route({ ...options, agentID: "agent_1", jobID: "job_2", rootJobID: "job_1", kind: "side" });
    expect(events[0]).toMatchObject({ agentID: "agent_1", jobID: "job_2", rootJobID: "job_1", kind: "side" });
  });

  test("a recorder that rejects asynchronously does not fail the model call", async () => {
    setUsageRecorder(async () => { throw new Error("async ledger down"); });
    const router = new Router([provider], new HealthTracker(), (async () => ok()) as unknown as typeof fetch);
    expect((await router.route(options)).text).toBe("hi");
    await new Promise((resolve) => setTimeout(resolve, 5)); // the rejection is caught, not unhandled
  });

  test("a 503 then a success records exactly one event", async () => {
    const events: ModelUsageEvent[] = [];
    setUsageRecorder((event) => { events.push(event); });
    let calls = 0;
    const flaky = (async () => (++calls === 1 ? new Response("down", { status: 503 }) : ok())) as unknown as typeof fetch;
    const result = await new Router([provider], new HealthTracker(), flaky).route(options);
    expect(calls).toBe(2);
    expect(result.attempts).toBe(2);
    expect(events).toHaveLength(1);
  });

  test("a failed route records nothing", async () => {
    const events: ModelUsageEvent[] = [];
    setUsageRecorder((event) => { events.push(event); });
    const router = new Router([provider], new HealthTracker(), (async () => new Response("bad", { status: 400 })) as unknown as typeof fetch);
    await expect(router.route(options)).rejects.toThrow();
    expect(events).toHaveLength(0);
  });
});
