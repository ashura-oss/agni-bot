/**
 * The eval server only ever runs on a throwaway home: an `agni-eval-*`
 * folder directly under the OS temp folder, never the owner's ~/.agni.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { assertThrowawayHome, startEpisodeServer } from "../server";

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
