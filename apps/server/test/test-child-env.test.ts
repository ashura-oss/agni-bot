/**
 * The environment a test hands to a child it starts (a `serve`, an `agni vault ...` command): the parent's `AGNI_*`
 * settings and credentials are removed so the child cannot reach the owner's home or keys, but the `AGNI_TEST_RUN`
 * marker stays, so the child refuses the operating system's credential store exactly as the test process does.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AGNI_ONLY, cleanChildEnv } from "./test-child-env";

describe("cleanChildEnv", () => {
  const source = {
    PATH: "p",
    AGNI_HOME: "/owner",
    AGNI_PORT: "1",
    AGNI_TEST_RUN: "1",
    OPENROUTER_API_KEY: "k",
    GROQ_FOO: "x",
    MY_TOKEN: "t",
  };

  test("keeps the test-run marker and the plain variables, drops the rest of AGNI_* and the credentials", () => {
    expect(cleanChildEnv({}, undefined, source)).toEqual({ PATH: "p", AGNI_TEST_RUN: "1" });
  });

  test("keeps the marker whatever its letter case (Windows names ignore case)", () => {
    expect(cleanChildEnv({}, undefined, { Agni_Test_Run: "1", AGNI_HOME: "/owner" })).toEqual({ Agni_Test_Run: "1" });
  });

  test("the extra settings are added and win; the marker can be overridden by the caller", () => {
    expect(cleanChildEnv({ AGNI_HOME: "/throwaway", AGNI_TEST_RUN: "0" }, undefined, source)).toEqual({ PATH: "p", AGNI_TEST_RUN: "0", AGNI_HOME: "/throwaway" });
  });

  test("a caller that strips only AGNI_* (the canary scan) keeps the credential-looking names", () => {
    expect(cleanChildEnv({}, AGNI_ONLY, source)).toEqual({ PATH: "p", AGNI_TEST_RUN: "1", OPENROUTER_API_KEY: "k", GROQ_FOO: "x", MY_TOKEN: "t" });
  });

  test("the environment of this test run carries the marker into the child", () => {
    expect(cleanChildEnv().AGNI_TEST_RUN).toBe("1");
  });
});

describe("test files do not strip the environment themselves", () => {
  // A copy of the strip that forgets the marker leaves a child able to open the owner's real credential store.
  test("only test-child-env.ts removes AGNI_* names from an environment", () => {
    const own: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry.name) && !/child-env(\.test)?\.ts$/.test(entry.name) && /\/\^AGNI_|startsWith\("AGNI_"\)/.test(readFileSync(path, "utf8"))) own.push(path.slice(import.meta.dir.length + 1));
      }
    };
    walk(import.meta.dir);
    expect(own.sort()).toEqual([]);
  });
});
