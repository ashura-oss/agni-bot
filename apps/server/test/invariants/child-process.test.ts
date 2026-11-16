/**
 * INV-08: a child process gets a clean, fixed world (S2-14; track-c C5.4 item 8).
 *
 *   - Only allowlisted environment variables reach the child: a provider key,
 *     a database URL, a variable that merely looks like a secret under some
 *     other name are all absent.
 *   - The working directory is the server's choice: a model-supplied `cwd`
 *     outside scratch does not move the command there.
 *
 * Shell is tier 3, so each command here raises a card and the owner allows it
 * once: the question is what the allowed command can see, not whether it asks.
 */
import { existsSync, mkdirSync } from "node:fs";
import { describe, expect } from "bun:test";
import { scenarioTest, useScenarios, say } from "../scenarios/harness";
import { call, playTurn, scripted } from "./support";

const scenarios = useScenarios();
const shell = (path: string): string => path.replaceAll("\\", "/");

const CANARIES: Record<string, string> = {
  // Names the current denylist catches (provider keys, *_TOKEN, *_PASSWORD): these must stay out.
  OPENROUTER_API_KEY: "sk-or-invariant-canary-0001",
  INVARIANT_SERVICE_TOKEN: "token-invariant-canary-0002",
  // Names it does not: an allowlist keeps them out, a denylist cannot.
  INVARIANT_REGISTRY_CANARY: "registry-invariant-canary-0003",
  DATABASE_URL: "postgres://owner:pw-invariant-canary-0004@db.internal/agni",
  STRIPE_LIVE_KEY: "sk_live_invariant_canary_0005",
  AWS_SESSION_BLOB: "aws-invariant-canary-0006",
};

async function withCanaries<T>(body: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(CANARIES).map((name) => [name, process.env[name]]));
  Object.assign(process.env, CANARIES);
  try {
    return await body();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

// waits for S2-4 (S2-14: environment allowlist)
describe("INV-08 child processes see only allowlisted environment variables", () => {
  scenarioTest("`printenv` in an approved shell shows none of the planted secrets", async () => {
    await withCanaries(async () => {
      const s = await scenarios.start();
      const a = await s.connect({ label: "A" });
      s.model.queue(...scripted(true, [call("bash", { command: "printenv | grep -i -E 'canary|database_url|stripe|aws_session|openrouter|invariant|^path='" }, "call_env"), say("Done.")]));
      const report = await playTurn(s, a, "show me the environment", { answer: () => "once" });
      const record = report.calls.find((entry) => entry.callID === "call_env")!;
      expect(record.result, "the shell did not run, so the check proves nothing").toContain("exitCode");
      const leaked = Object.entries(CANARIES).filter(([, value]) => record.result.includes(value)).map(([name]) => name);
      expect(leaked, "variables a child process could read").toEqual([]);
    });
  });

  scenarioTest("the same holds for a variable named in the command's own text: `echo $NAME` prints nothing", async () => {
    await withCanaries(async () => {
      const s = await scenarios.start();
      const a = await s.connect({ label: "A" });
      s.model.queue(...scripted(true, [
        call("bash", { command: "echo \"[$INVARIANT_REGISTRY_CANARY][$DATABASE_URL][$STRIPE_LIVE_KEY][$OPENROUTER_API_KEY]\"" }, "call_echo"),
        say("Done."),
      ]));
      const report = await playTurn(s, a, "echo some variables", { answer: () => "once" });
      const record = report.calls.find((entry) => entry.callID === "call_echo")!;
      expect(record.result, "a variable the shell should not have was expanded").toContain("[][][][]");
    });
  });
});

// waits for S2-4 (S2-14: server-chosen cwd)
describe("INV-08 the working directory is the server's choice", () => {
  scenarioTest("a command given a `cwd` outside scratch does not run there", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    const elsewhere = s.outside("elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    s.model.queue(...scripted(true, [
      call("bash", { command: "touch cwd-marker", cwd: shell(elsewhere) }, "call_cwd"),
      say("Done."),
    ]));
    await playTurn(s, a, "make a marker file over there", { answer: () => "once" });
    expect(existsSync(`${elsewhere}/cwd-marker`), "the shell ran in a directory the model chose outside scratch").toBe(false);
  });

  scenarioTest("a command with no `cwd` runs in scratch", async () => {
    const s = await scenarios.start();
    const a = await s.connect({ label: "A" });
    s.model.queue(...scripted(true, [call("bash", { command: "touch default-cwd-marker" }, "call_default"), say("Done.")]));
    await playTurn(s, a, "make a marker file", { answer: () => "once" });
    expect(existsSync(`${s.scratch}/default-cwd-marker`), "the shell did not run in scratch by default").toBe(true);
  });
});
