import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extraHelpLines, runExtraCommand, type CommandTable } from "../src/cli/extra-commands";
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
import { startupS3 } from "../src/startup/s3";
import { runStartupHooks } from "../src/startup";
import { registerSecret, redact } from "../src/util/redact";

const noopSink: AuditSink = { record() {} };
afterEach(() => {
  setAuditSink(noopSink);
  setUsageRecorder(() => {});
});

describe("P0 extra CLI commands", () => {
  test("both sprint tables ship empty", () => {
    expect(s2Commands).toEqual({ commands: {}, help: [] });
    expect(s3Commands).toEqual({ commands: {}, help: [] });
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
    expect(extraHelpLines()).toEqual([]);
  });

  test("runExtraCommand returns false for a command no table knows", async () => {
    expect(await runExtraCommand("nope", [])).toBe(false);
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

  test("a failed route records nothing", async () => {
    const events: ModelUsageEvent[] = [];
    setUsageRecorder((event) => { events.push(event); });
    const router = new Router([provider], new HealthTracker(), (async () => new Response("bad", { status: 400 })) as unknown as typeof fetch);
    await expect(router.route(options)).rejects.toThrow();
    expect(events).toHaveLength(0);
  });
});
