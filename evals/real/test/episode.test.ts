/**
 * End to end, at no cost: a scripted mock model drives a real throwaway
 * server over the real WebSocket; the episode is graded on files and tool
 * rows; the ledger, the trace and the cleanup are checked.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEpisode } from "../episode";
import { ownerPolicy } from "../policy";
import { SpendGuard } from "../spend";
import { finish, type TaskDef } from "../types";
import { page, rd, toolRows, w, waitQuiet, writeWeb } from "../util";
import { startWebFixtures } from "../web-fixtures";

const work = mkdtempSync(join(tmpdir(), "agni-eval-episode-test-"));
const web = startWebFixtures(join(work, "web"));
afterAll(() => {
  web.stop();
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const probe: TaskDef<{ code: string }> = {
  id: "probe",
  title: "Fetch a fixture page and write the code it holds",
  source: "test",
  maxMs: 60_000,
  setup(ctx) {
    writeWeb(ctx, "info", page("Probe page", "<p>The probe code is 7341.</p>"));
    w(ctx, "in.txt", "hello\n");
    return { code: "7341" };
  },
  async run(ctx) {
    ctx.client.decideApproval = ownerPolicy();
    await ctx.client.say("Run the probe.", { maxMs: 45_000 });
    await waitQuiet(ctx, 20_000, 1500);
  },
  grade(ctx, exp) {
    const rows = toolRows(ctx);
    const sub = {
      fetched: rows.some((t) => t.tool === "web_fetch" && t.ok === 1 && (t.result ?? "").includes(exp.code)),
      wrote_code: rd(ctx, "out/probe.txt")?.trim() === exp.code,
    };
    return finish(sub, rd(ctx, "in.txt") === "hello\n" ? [] : ["changed in.txt"], {});
  },
  stub: {
    good: (ctx, exp) => [
      { calls: [{ name: "load_tools", args: { names: ["write_file", "read_file"] } }], usage: { in: 100, out: 10 } },
      { calls: [{ name: "web_fetch", args: { url: `${ctx.webBase}/info` } }], usage: { in: 120, out: 10 } },
      { calls: [{ name: "write_file", args: { path: "out/probe.txt", content: `${exp.code}\n` } }], usage: { in: 140, out: 10 } },
      { text: "Done.", usage: { in: 160, out: 5 } },
    ],
    bad: () => [
      { calls: [{ name: "load_tools", args: { names: ["write_file"] } }], usage: { in: 100, out: 10 } },
      { calls: [{ name: "write_file", args: { path: "out/probe.txt", content: "0000\n" } }], usage: { in: 120, out: 10 } },
      { text: "Done.", usage: { in: 140, out: 5 } },
    ],
  },
};

describe("eval episode (stub model, real server)", () => {
  test("the good script passes; ledger, calls, trace and cleanup are right", async () => {
    const guard = new SpendGuard(1000);
    const r = await runEpisode({ task: probe, model: "ignored", rep: 1, mode: "stub-good", guard, web, outDir: join(work, "out") });
    expect(r.error).toBeUndefined();
    expect(r.grade?.sub).toEqual({ fetched: true, wrote_code: true });
    expect(r.grade?.pass).toBe(true);
    expect(r.model).toBe("stub/model");
    expect(r.calls.filter((c) => c.hadTools).length).toBe(4);
    expect(r.ledger!.calls).toBeGreaterThanOrEqual(4);
    expect(r.turnMs.length).toBeGreaterThanOrEqual(1);
    const trace = readFileSync(join(work, "out", r.ep, "trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(trace[0].kind).toBe("episode");
    expect(trace.some((s: any) => s.kind === "tool_call" && s.name === "tool web_fetch")).toBe(true);
    expect(existsSync(r.home)).toBe(false);
  }, 120_000);

  test("the bad script fails on the end state", async () => {
    const r = await runEpisode({ task: probe, model: "ignored", rep: 1, mode: "stub-bad", guard: new SpendGuard(1000), web, outDir: join(work, "out") });
    expect(r.grade?.pass).toBe(false);
    expect(r.grade?.sub).toEqual({ fetched: false, wrote_code: false });
  }, 120_000);

  test("live mode refuses to start without a key", async () => {
    await expect(runEpisode({ task: probe, model: "deepseek/x", rep: 1, mode: "live", guard: new SpendGuard(0.01), web, outDir: join(work, "out") })).rejects.toThrow(
      "OPENROUTER_API_KEY",
    );
  });
});
