/**
 * The eval server only ever runs on a throwaway home: an `agni-eval-*`
 * folder directly under the OS temp folder, never the owner's ~/.agni.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { assertThrowawayHome, freePort, PLACEHOLDER_KEY, serverEnv, startEpisodeServer } from "../server";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const fresh = (): string => {
  const d = mkdtempSync(join(tmpdir(), "agni-eval-"));
  dirs.push(d);
  return d;
};

describe("throwaway home guard", () => {
  test("a fresh agni-eval-* folder under the temp folder is accepted, with scratch inside it", () => {
    const home = fresh();
    expect(() => assertThrowawayHome(home, join(home, "scratch"))).not.toThrow();
  });

  test("the owner's ~/.agni and anything inside it are refused", () => {
    expect(() => assertThrowawayHome(join(homedir(), ".agni"))).toThrow("owner's ~/.agni");
    expect(() => assertThrowawayHome(join(homedir(), ".agni", "agni-eval-x"))).toThrow("owner's ~/.agni");
  });

  test("the temp folder itself, a deeper folder, another name, or a folder elsewhere is refused", () => {
    expect(() => assertThrowawayHome(tmpdir())).toThrow("throwaway");
    expect(() => assertThrowawayHome(join(fresh(), "agni-eval-nested"))).toThrow("throwaway");
    expect(() => assertThrowawayHome(join(tmpdir(), "my-home"))).toThrow("throwaway");
    expect(() => assertThrowawayHome(join(homedir(), "agni-eval-x"))).toThrow("throwaway");
  });

  test("the server environment: placeholder key, the fixture port only when given, no AGNI_* from this process", () => {
    const home = fresh();
    const o = { home, scratch: join(home, "scratch"), baseUrl: "http://127.0.0.1:1/api/v1", model: "m", logDir: home };
    const withPort = serverEnv({ ...o, fixturePort: 4321 }, 9999);
    expect(withPort.AGNI_EVAL_FIXTURE_PORT).toBe("4321");
    expect(withPort.OPENROUTER_API_KEY).toBe(PLACEHOLDER_KEY);
    expect(withPort.AGNI_HOME).toBe(home);
    expect(serverEnv(o, 9999).AGNI_EVAL_FIXTURE_PORT).toBeUndefined();
  });

  test("a task may only adjust the eval limits; the harness's own settings cannot be overridden", () => {
    const home = fresh();
    const o = { home, scratch: join(home, "scratch"), baseUrl: "http://127.0.0.1:1/api/v1", model: "m", logDir: home };
    for (const key of ["AGNI_HOME", "AGNI_SCRATCH_DIR", "AGNI_TEST_RUN", "AGNI_KEYSTORE", "OPENROUTER_BASE_URL", "OPENROUTER_API_KEY", "AGNI_DB_PATH", "AGNI_EVAL_FIXTURE_PORT", "PATH"]) {
      expect(() => serverEnv({ ...o, env: { [key]: "" } }, 9999)).toThrow(`refused: ${key}`);
    }
    const tuned = serverEnv({ ...o, env: { AGNI_AUX_MAX_TOKENS: "" } }, 9999);
    expect(tuned.AGNI_AUX_MAX_TOKENS).toBe("");
    expect(tuned.AGNI_HOME).toBe(home);
    expect(tuned.AGNI_TEST_RUN).toBe("1");
  });

  test("a task env with a harness key is refused before anything is spawned", async () => {
    const home = fresh();
    await expect(
      startEpisodeServer({ home, scratch: join(home, "scratch"), baseUrl: "http://127.0.0.1:1/api/v1", model: "m", logDir: home, env: { AGNI_HOME: "" } }),
    ).rejects.toThrow("refused: AGNI_HOME");
  });

  test("scratch outside the home is refused", () => {
    const home = fresh();
    expect(() => assertThrowawayHome(home, join(tmpdir(), "scratch"))).toThrow("inside the throwaway home");
  });

  test("starting a server on a home that is not throwaway is refused before anything is spawned", async () => {
    // A path that does not exist and is not an eval home: if the guard were missing, the spawn itself would fail
    // with a different error, so this check can never start a server on a real home.
    const notThrowaway = join(tmpdir(), `not-an-eval-home-${process.pid}`);
    await expect(
      startEpisodeServer({ home: notThrowaway, scratch: join(notThrowaway, "scratch"), baseUrl: "http://127.0.0.1:1/api/v1", model: "m", logDir: fresh() }),
    ).rejects.toThrow("throwaway");
  });
});

describe("port race", () => {
  test("a port taken by another service is not mistaken for the server; the next port is tried", async () => {
    // Another service holds the first port and answers /health with 200, as a raced port might.
    const squatter = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ok: true }) });
    const taken = squatter.port!;
    const ports = [taken];
    const home = fresh();
    mkdirSync(join(home, "scratch"));
    try {
      const server = await startEpisodeServer({
        home,
        scratch: join(home, "scratch"),
        baseUrl: "http://127.0.0.1:1/api/v1",
        model: "m",
        logDir: home,
        pickPort: async () => ports.shift() ?? (await freePort()),
      });
      try {
        expect(server.port).not.toBe(taken);
        expect(server.token.length).toBeGreaterThan(0);
        expect((await fetch(`http://127.0.0.1:${server.port}/health`)).ok).toBe(true);
      } finally {
        await server.stop();
      }
    } finally {
      void squatter.stop(true);
    }
  }, 90_000);
});
