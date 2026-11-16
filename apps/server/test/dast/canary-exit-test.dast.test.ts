import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PROTOCOL_VERSION } from "@agni/protocol";
import { installFakeMailNetwork, type FakeMailNetwork } from "../injection/fake-mail-network";
import { startDast, type Dast } from "./dast-harness";

/**
 * Sprint 3 exit test 1, run for real: secrets are entered through the real
 * socket into a real server whose home is on disk, then `scripts/canary-scan.ts`
 * looks for them in the vault, the database, the log, the frames the owner's
 * client received, and every other file under the home.
 *
 *   - "the key is kept in the vault file" needs S3-01..03 (the vault) and fails until it exists.
 *   - "found nowhere in plaintext" needs the same: today the key is written to config.env.
 */

const SCRIPT = resolve(import.meta.dir, "../../../../scripts/canary-scan.ts");
const PROVIDER_KEY = "sk-exit-test-provider-0f9e8d7c6b5a";
const PLUGIN_PASS = "app-pass-exit-test-1a2b3c4d5e6f";

let dast: Dast | undefined;
let network: FakeMailNetwork | undefined;
const restoreConsole: Array<() => void> = [];
const savedEnv: Record<string, string | undefined> = {};

afterEach(async () => {
  for (const restore of restoreConsole.splice(0)) restore();
  network?.restore();
  network = undefined;
  await dast?.stop();
  dast = undefined;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete Bun.env[key];
    else Bun.env[key] = value;
  }
});

/** Keep what the server writes to the console (its log) so it can be scanned as a log file. */
function captureLog(): string[] {
  const lines: string[] = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[level];
    console[level] = (...args: unknown[]) => {
      lines.push(args.map((arg) => (typeof arg === "string" ? arg : arg instanceof Error ? (arg.stack ?? arg.message) : JSON.stringify(arg))).join(" "));
    };
    restoreConsole.push(() => { console[level] = original; });
  }
  return lines;
}

/** Enter both secrets over a real socket as the owner's device, and keep every frame the socket received. */
async function enterSecrets(server: Dast): Promise<string[]> {
  const received: string[] = [];
  const ws = new WebSocket(server.harness.url);
  await new Promise<void>((resolveOpen, rejectOpen) => {
    ws.addEventListener("open", () => resolveOpen(), { once: true });
    ws.addEventListener("error", () => rejectOpen(new Error("cannot open socket")), { once: true });
  });
  ws.addEventListener("message", (event) => received.push(String(event.data)));
  const waitFor = async (type: string): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const found = received.map((raw) => JSON.parse(raw) as Record<string, unknown>).find((frame) => frame.type === type || (frame.type === "error" && type === "*"));
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${type}`);
      await Bun.sleep(5);
    }
  };
  ws.send(JSON.stringify({ type: "hello", v: PROTOCOL_VERSION, token: server.harness.token, device: "exit-test" }));
  await waitFor("hello.ok");

  ws.send(JSON.stringify({ type: "provider.add", providerID: "groq", apiKey: PROVIDER_KEY }));
  await waitFor("provider.add.ok");
  ws.send(JSON.stringify({ type: "plugin.configure", pluginID: "gmail", account: "agent", user: "agent@example.test", pass: PLUGIN_PASS }));
  await waitFor("plugin.state");
  // A moment for anything the server writes behind the reply.
  await Bun.sleep(100);
  ws.close();
  return received;
}

function scan(server: Dast, extra: string[]): { code: number; out: string; err: string } {
  const env = { ...process.env, AGNI_HOME: server.home } as Record<string, string>;
  for (const key of Object.keys(env)) if (key.startsWith("AGNI_") && key !== "AGNI_HOME") delete env[key];
  const run = Bun.spawnSync([process.execPath, SCRIPT, "--secrets", `--canary=${PROVIDER_KEY},${PLUGIN_PASS}`, ...extra], { env, cwd: server.home });
  return { code: run.exitCode ?? -1, out: run.stdout.toString(), err: run.stderr.toString() };
}

describe("secrets entered through the socket (exit test 1)", () => {
  async function run(): Promise<{ server: Dast; frames: string; logFile: string }> {
    savedEnv.GROQ_API_KEY = Bun.env.GROQ_API_KEY;
    network = installFakeMailNetwork();
    const log = captureLog();
    dast = await startDast({ files: true });
    const frames = await enterSecrets(dast);
    const framesFile = join(dast.home, "frames.jsonl");
    writeFileSync(framesFile, `${frames.join("\n")}\n`);
    const logFile = join(dast.home, "logs", "agni.log");
    writeFileSync(logFile, `${log.join("\n")}\n`);
    return { server: dast, frames: framesFile, logFile };
  }

  test("the reply frames the client received do not hold either secret", async () => {
    const { frames } = await run();
    const text = readFileSync(frames, "utf8");
    expect(text).not.toContain(PROVIDER_KEY);
    expect(text).not.toContain(PLUGIN_PASS);
    // And the capture is not empty: the replies really were recorded.
    expect(text).toContain("provider.add.ok");
  });

  test("the server's log does not hold either secret", async () => {
    const { logFile } = await run();
    const text = readFileSync(logFile, "utf8");
    expect(text).not.toContain(PROVIDER_KEY);
    expect(text).not.toContain(PLUGIN_PASS);
    expect(text).toContain("hello from");
  });

  test("the database does not hold either secret", async () => {
    const { server } = await run();
    const result = scan(server, [`--db=${join(server.home, "data", "agni.sqlite")}`]);
    expect(result.err).not.toMatch(/database|agent_memories|plugin_connections/);
  });

  test("the key is kept in an encrypted vault file under the home (S3-01)", async () => {
    const { server } = await run();
    const vault = join(server.home, "vault.bin");
    expect(existsSync(vault)).toBe(true);
    expect(statSync(vault).size).toBeGreaterThan(0);
  });

  test("the scan finds neither secret anywhere under the home, in the log or in the frames, and exits 0", async () => {
    const { server, frames } = await run();
    const result = scan(server, [`--frames=${frames}`]);
    // The scanner masks values, so this message is safe to show; it names the files that still hold a secret.
    expect({ code: result.code, leaks: result.err.trim() }).toEqual({ code: 0, leaks: "" });
  });
});
