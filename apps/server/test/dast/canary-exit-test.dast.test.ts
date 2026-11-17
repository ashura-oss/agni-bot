import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PROTOCOL_VERSION } from "@agni/protocol";
import { AGNI_ONLY, cleanChildEnv } from "../test-child-env";
import { installFakeMailNetwork, type FakeMailNetwork } from "../injection/fake-mail-network";
import { lockVault, unlockVault } from "../../src/secrets";
import { startDast, type Dast } from "./dast-harness";

/**
 * Sprint 3 exit test 1, run for real: secrets are entered through the real
 * socket into a real server whose home is on disk, then `scripts/canary-scan.ts`
 * looks for them in the vault, the database, the log, the frames the owner's
 * client received, and every other file under the home.
 *
 * The home is in vault mode (`AGNI_SECRETS_MODE=vault`, the state `agni vault migrate`
 * leaves it in) with the vault unlocked on the test keystore, so no real credential store
 * is touched. A home still in the default file mode keeps its keys in `config.env` until
 * the owner migrates; that is a product decision, not something this test can assume.
 */

const SCRIPT = resolve(import.meta.dir, "../../../../scripts/canary-scan.ts");
const PROVIDER_KEY = "sk-exit-test-provider-0f9e8d7c6b5a";
const PLUGIN_PASS = "app-pass-exit-test-1a2b3c4d5e6f";

let dast: Dast | undefined;
let network: FakeMailNetwork | undefined;
const restoreConsole: Array<() => void> = [];
const savedEnv: Record<string, string | undefined> = {};

afterEach(async () => {
  lockVault();
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

/** Open a socket as the owner's device and keep every frame it receives. */
async function openOwnerSocket(server: Dast): Promise<{ ws: WebSocket; received: string[]; waitFor: (type: string) => Promise<Record<string, unknown>> }> {
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
  return { ws, received, waitFor };
}

/** Enter both secrets over a real socket as the owner's device, and keep every frame the socket received. */
async function enterSecrets(server: Dast): Promise<string[]> {
  const { ws, received, waitFor } = await openOwnerSocket(server);
  ws.send(JSON.stringify({ type: "provider.add", providerID: "groq", apiKey: PROVIDER_KEY }));
  await waitFor("provider.add.ok");
  ws.send(JSON.stringify({ type: "plugin.configure", pluginID: "gmail", account: "agent", user: "agent@example.test", pass: PLUGIN_PASS }));
  await waitFor("plugin.state");
  // A moment for anything the server writes behind the reply.
  await Bun.sleep(100);
  ws.close();
  return received;
}

function scan(server: Dast, extra: string[], canaries: string[] = [PROVIDER_KEY, PLUGIN_PASS]): { code: number; out: string; err: string } {
  const env = cleanChildEnv({ AGNI_HOME: server.home }, AGNI_ONLY);
  const run = Bun.spawnSync([process.execPath, SCRIPT, "--secrets", `--canary=${canaries.join(",")}`, ...extra], { env, cwd: server.home });
  return { code: run.exitCode ?? -1, out: run.stdout.toString(), err: run.stderr.toString() };
}

describe("secrets entered through the socket (exit test 1)", () => {
  async function run(): Promise<{ server: Dast; frames: string; logFile: string }> {
    savedEnv.GROQ_API_KEY = Bun.env.GROQ_API_KEY;
    savedEnv.AGNI_SECRETS_MODE = Bun.env.AGNI_SECRETS_MODE;
    network = installFakeMailNetwork();
    const log = captureLog();
    dast = await startDast({ files: true });
    Bun.env.AGNI_SECRETS_MODE = "vault";
    await unlockVault({ home: dast.home, create: true });
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

/**
 * Sprint 3 fix round 6. The first exit-test run entered secrets and looked for them; it never asked what the
 * server does when an upstream echoes one back. A server that answers HTTP 500 and reflects the Authorization
 * header it was sent used to leave the bearer in `plugin_connections.error` (and so in the database's
 * write-ahead log) while the `plugin.state` frame showed it masked.
 */
describe("a server that echoes the bearer in its error (exit test 1, upstream echo)", () => {
  const BEARER = "mcp-bearer-exit-test-7a6b5c4d3e2f1089";
  let mock: ReturnType<typeof Bun.serve> | undefined;
  afterEach(() => {
    void mock?.stop(true);
    mock = undefined;
  });

  test("the scan of the whole home, the log and the frames finds no bearer and exits 0", async () => {
    savedEnv.AGNI_SECRETS_MODE = Bun.env.AGNI_SECRETS_MODE;
    const log = captureLog();
    dast = await startDast({ files: true });
    Bun.env.AGNI_SECRETS_MODE = "vault";
    await unlockVault({ home: dast.home, create: true });
    // The mock MCP server: every request is a 500 whose body reflects the request headers.
    mock = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => new Response(`upstream exploded; request headers: ${JSON.stringify({ authorization: request.headers.get("authorization") })}`, { status: 500 }),
    });
    // The owner flags the plugin local, which is what lets it point at a loopback server.
    writeFileSync(join(dast.home, "plugins.json"), JSON.stringify({ version: 1, plugins: { notion: { account: "owner", enabled: true, auth: { kind: "mcp" }, local: true } } }));

    const { ws, received } = await openOwnerSocket(dast);
    ws.send(JSON.stringify({ type: "plugin.configure", pluginID: "notion", account: "owner", url: `http://127.0.0.1:${mock.port}/mcp`, key: BEARER }));
    const deadline = Date.now() + 5000;
    while (!received.some((raw) => raw.includes("upstream exploded"))) {
      if (Date.now() > deadline) throw new Error("the failed connection never reached the owner's client");
      await Bun.sleep(10);
    }
    await Bun.sleep(100);
    ws.close();

    // The failure really was stored, and the frame the owner saw is masked: the scan is not looking at nothing.
    const stored = new Database(join(dast.home, "data", "agni.sqlite"), { readonly: true });
    const row = stored.query<{ error: string }, []>("SELECT error FROM plugin_connections WHERE plugin_id = 'notion'").get();
    stored.close();
    expect(row?.error).toContain("upstream exploded");
    expect(received.join("\n")).toContain("[redacted]");

    const framesFile = join(dast.home, "frames.jsonl");
    writeFileSync(framesFile, `${received.join("\n")}\n`);
    writeFileSync(join(dast.home, "logs", "agni.log"), `${log.join("\n")}\n`);
    const result = scan(dast, [`--frames=${framesFile}`], [BEARER]);
    expect({ code: result.code, leaks: result.err.trim() }).toEqual({ code: 0, leaks: "" });
  });
});
