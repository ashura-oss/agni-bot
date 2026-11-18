/**
 * Starts one throwaway Agni server for one eval episode and stops it.
 *
 * - Its own AGNI_HOME (made by the caller under the OS temp folder), never
 *   the owner's `~/.agni`. A home with no secrets mode recorded runs in file
 *   mode, so no vault and no keystore are touched; `AGNI_TEST_RUN=1` and
 *   `AGNI_KEYSTORE=passphrase` make any attempt to reach the OS credential
 *   store fail instead.
 * - The environment is the test suite's clean child environment: every
 *   `AGNI_*` setting and anything that looks like a credential is removed
 *   before the episode's own values are added.
 * - The model key the server holds is a placeholder; the proxy adds the real
 *   one on the way out.
 * - `stop()` ends the server's whole process tree (only processes it started).
 * - The harness owns the home, port, scratch, keystore, model endpoint and
 *   test-run settings: a task may only adjust the limits in
 *   `EVAL_SERVER_ENV`, and the harness's own values are applied last.
 * - A start counts only when the server's own `serve.lock` names this child
 *   and the chosen port; a port taken between choosing and binding is
 *   retried on a new one.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { cleanChildEnv } from "../../apps/server/test/test-child-env";
import { trackTree, TREE_SPAWN_OPTIONS } from "../../apps/server/src/util/process-tree";
import { sleep } from "./util";
import { FIXTURE_PORT_ENV } from "./web-fixtures";

export const SERVER_ENTRY = resolve(import.meta.dir, "../../apps/server/src/index.ts");
export const PRELOAD = resolve(import.meta.dir, "preload.ts");
/** The model key the episode server sees. The real key stays in the proxy. */
export const PLACEHOLDER_KEY = "eval-proxy-holds-the-key";

/**
 * Round 5's raised limits, kept so results compare with round 5 (see the plan
 * ledger ruling). A task can override any of them with `TaskDef.env`; an
 * empty value means the product default.
 */
export const EVAL_SERVER_ENV: Record<string, string> = {
  AGNI_TURN_TIMEOUT_MS: "900000",
  AGNI_FIRST_TOKEN_TIMEOUT_MS: "90000",
  AGNI_MAX_CONCURRENT_TURNS: "8",
  AGNI_JOB_CONCURRENCY: "4",
  AGNI_AUX_MAX_TOKENS: "8000",
  AGNI_AUX_TIMEOUT_MS: "120000",
  AGNI_OFFROAD_STOP_AT: "100000",
  AGNI_OFFROAD_NUDGE_AT: "100000",
  AGNI_MAX_CHAIN_STEPS: "100",
  AGNI_MAX_DELEGATED_STEPS: "60",
  AGNI_FETCH_SUMMARY_CHARS: "3000",
};

export interface StartServerOptions {
  home: string;
  scratch: string;
  /** The proxy's base URL. */
  baseUrl: string;
  model: string;
  env?: Record<string, string>;
  /** Folder for `server.out.log` and `server.err.log`. */
  logDir: string;
  /** Chooses a port to try (default `freePort`). A seam for tests. */
  pickPort?: () => Promise<number>;
  /** The fixture server's port; the preload sends fixtures.example there and nowhere else. Without it every fixture fetch is refused. */
  fixturePort?: number;
}

export interface EpisodeServer {
  port: number;
  token: string;
  stop(): Promise<void>;
}

/**
 * Refuse any home that is not a fresh eval folder (`agni-eval-*`) directly
 * under the OS temp folder, and never the owner's `~/.agni`. Called before
 * anything is spawned, so a wrong home stops the run instead of reaching the
 * owner's data. Scratch must sit inside that home.
 */
export function assertThrowawayHome(home: string, scratch?: string): void {
  const fold = (p: string): string => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  const full = fold(home);
  const temp = fold(tmpdir());
  const owner = fold(join(homedir(), ".agni"));
  if (full === owner || full.startsWith(owner + sep)) throw new Error("refusing to run an eval server on the owner's ~/.agni");
  if (!full.startsWith(temp + sep) || fold(join(full, "..")) !== temp || !basename(full).startsWith("agni-eval-")) {
    throw new Error(`refusing to run an eval server outside a throwaway agni-eval-* home in ${resolve(tmpdir())} (got ${resolve(home)})`);
  }
  if (scratch !== undefined && !fold(scratch).startsWith(full + sep)) throw new Error(`the eval scratch folder must be inside the throwaway home (got ${resolve(scratch)})`);
}

export async function freePort(): Promise<number> {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

/** The server environment. A task's `env` may only adjust `EVAL_SERVER_ENV`; the harness's own settings go last. */
export function serverEnv(o: StartServerOptions, port: number): Record<string, string> {
  const taskEnv = o.env ?? {};
  const refused = Object.keys(taskEnv).filter((key) => !Object.hasOwn(EVAL_SERVER_ENV, key));
  if (refused.length > 0) {
    throw new Error(`a task may only adjust the eval limits (${Object.keys(EVAL_SERVER_ENV).join(", ")}); refused: ${refused.join(", ")}`);
  }
  return cleanChildEnv({
    ...EVAL_SERVER_ENV,
    ...taskEnv,
    AGNI_TEST_RUN: "1",
    AGNI_KEYSTORE: "passphrase",
    AGNI_HOME: o.home,
    AGNI_PORT: String(port),
    AGNI_HOST: "127.0.0.1",
    AGNI_SCRATCH_DIR: o.scratch,
    OPENROUTER_API_KEY: PLACEHOLDER_KEY,
    OPENROUTER_BASE_URL: o.baseUrl,
    OPENROUTER_MODEL: o.model,
    AGNI_USER_FIRST_NAME: "Sam",
    ...(o.fixturePort !== undefined ? { [FIXTURE_PORT_ENV]: String(o.fixturePort) } : {}),
  });
}

/** How many ports to try when the chosen one is taken between choosing it and binding it. */
export const PORT_ATTEMPTS = 3;

class PortTaken extends Error {}

/**
 * How a failed bind shows in the server's log. Bun 1.4.3 on Windows says "Failed to start server. Is port N in use?" with
 * no EADDRINUSE code, and `serve` then stays alive without listening (its uncaught-exception handler logs the error), so
 * the log is read while the child still runs.
 */
const PORT_TAKEN = /already in use|EADDRINUSE|address in use|Is port \d+ in use/i;

/** The log files of one start attempt: `server.out.log` and `server.err.log` for the first, `server.2.out.log` ... after. */
export function logNames(attempt: number): { out: string; err: string } {
  return attempt === 1 ? { out: "server.out.log", err: "server.err.log" } : { out: `server.${attempt}.out.log`, err: `server.${attempt}.err.log` };
}

function logText(logDir: string, attempt: number): string {
  const names = logNames(attempt);
  return [names.out, names.err]
    .map((name) => join(logDir, name))
    .filter((path) => existsSync(path))
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
}

/**
 * Wait until this child is listening on `port`: its `serve.lock` names the child's pid and the port (the server writes the
 * port only after it has bound it), and `/health` answers. A service that already held the port cannot pass, because the
 * lock would not name it.
 */
async function waitListening(home: string, logDir: string, attempt: number, port: number, child: { pid: number; exitCode: number | null }, ms: number): Promise<void> {
  const lockPath = join(home, "serve.lock");
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const taken = PORT_TAKEN.test(logText(logDir, attempt));
    if (taken) throw new PortTaken(`port ${port} was taken`);
    if (child.exitCode !== null) throw new Error(`the eval server exited (code ${child.exitCode}) before it was listening`);
    try {
      const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown; port?: unknown };
      if (lock.pid === child.pid && lock.port === port && (await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
    } catch {
      // not listening yet
    }
    await sleep(250);
  }
  throw new Error("the eval server did not start listening in time");
}

export async function startEpisodeServer(o: StartServerOptions): Promise<EpisodeServer> {
  assertThrowawayHome(o.home, o.scratch);
  const pickPort = o.pickPort ?? freePort;
  let lastError: unknown;
  for (let attempt = 1; attempt <= PORT_ATTEMPTS; attempt++) {
    try {
      return await startOnPort(o, await pickPort(), attempt);
    } catch (error) {
      lastError = error;
      if (!(error instanceof PortTaken)) throw error;
    }
  }
  throw lastError instanceof Error ? new Error(`${lastError.message} on ${PORT_ATTEMPTS} tries`) : lastError;
}

async function startOnPort(o: StartServerOptions, port: number, attempt: number): Promise<EpisodeServer> {
  const env = serverEnv(o, port);
  const logs = logNames(attempt);
  const child = Bun.spawn([process.execPath, "--preload", PRELOAD, SERVER_ENTRY, "serve"], {
    cwd: o.scratch,
    env,
    stdout: Bun.file(join(o.logDir, logs.out)),
    stderr: Bun.file(join(o.logDir, logs.err)),
    ...TREE_SPAWN_OPTIONS,
  });
  // trackTree takes Node's `kill(): boolean`; Bun's subprocess returns nothing.
  const tree = trackTree({
    pid: child.pid,
    kill: (signal) => {
      child.kill(signal);
      return true;
    },
  });
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await tree.kill();
    await Promise.race([child.exited, sleep(10_000)]);
    tree.release();
  };
  try {
    await waitListening(o.home, o.logDir, attempt, port, child, 30_000);
    const pair = Bun.spawnSync([process.execPath, SERVER_ENTRY, "pair", "--name", "eval"], { env, cwd: o.scratch });
    const token = /token:\s+(\S+)/.exec(pair.stdout.toString())?.[1];
    if (!token) throw new Error(`pairing the eval server failed: ${pair.stderr.toString().slice(0, 300)}`);
    return { port, token, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
