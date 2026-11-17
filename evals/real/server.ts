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
 */
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { cleanChildEnv } from "../../apps/server/test/test-child-env";
import { trackTree, TREE_SPAWN_OPTIONS } from "../../apps/server/src/util/process-tree";
import { sleep } from "./util";

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

export function serverEnv(o: StartServerOptions, port: number): Record<string, string> {
  return cleanChildEnv({
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
    ...EVAL_SERVER_ENV,
    ...(o.env ?? {}),
  });
}

async function waitHealth(port: number, ms: number, child: { exitCode: number | null }): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (child.exitCode !== null) throw new Error(`the eval server exited (code ${child.exitCode}) before it was healthy`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
    } catch {
      // not listening yet
    }
    await sleep(250);
  }
  throw new Error("the eval server did not become healthy in time");
}

export async function startEpisodeServer(o: StartServerOptions): Promise<EpisodeServer> {
  assertThrowawayHome(o.home, o.scratch);
  const port = await freePort();
  const env = serverEnv(o, port);
  const child = Bun.spawn([process.execPath, "--preload", PRELOAD, SERVER_ENTRY, "serve"], {
    cwd: o.scratch,
    env,
    stdout: Bun.file(join(o.logDir, "server.out.log")),
    stderr: Bun.file(join(o.logDir, "server.err.log")),
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
    await waitHealth(port, 30_000, child);
    const pair = Bun.spawnSync([process.execPath, SERVER_ENTRY, "pair", "--name", "eval"], { env, cwd: o.scratch });
    const token = /token:\s+(\S+)/.exec(pair.stdout.toString())?.[1];
    if (!token) throw new Error(`pairing the eval server failed: ${pair.stderr.toString().slice(0, 300)}`);
    return { port, token, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
