/**
 * INV-07 (one key for a path): a refusal is recorded under a path key and later calls are matched against
 * the same kind of key, so recording and matching must be ONE function (policy/path-key.ts):
 * the real path (`realpathSync.native` of the path, or of its longest existing prefix, with the missing tail
 * kept), with case folded where the file system folds it (win32 and darwin).
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { scenarioTest, useScenarios, say } from "../scenarios/harness";
import { canonicalPathKey, foldKey } from "../../src/policy/path-key";
import { assessCall, policyFor } from "../../src/policy/metadata";
import type { ToolResource } from "../../src/policy/tool-meta";
import { pathResource, shellFacts } from "../../src/policy/resources";
import { call, playTurn, resultJson, scripted } from "./support";

const WINDOWS = process.platform === "win32";
const scenarios = useScenarios();
const shell = (path: string): string => path.replaceAll("\\", "/");

const roots: string[] = [];
const tempRoot = (): string => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "agni-keys-")));
  roots.push(root);
  return root;
};
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

describe("INV-07 case is folded where the file system folds it", () => {
  test.each<[NodeJS.Platform, boolean]>([
    ["win32", true],
    ["darwin", true],
    ["linux", false],
  ])("%s folds case: %s", (platform, folds) => {
    expect(foldKey("/Work/Denied.TXT", platform)).toBe(folds ? "/work/denied.txt" : "/Work/Denied.TXT");
  });

  test("a path that does not exist is keyed the same on darwin however it is spelled, and not on linux", () => {
    const root = tempRoot();
    const mixed = join(root, "Missing", "Denied.TXT");
    const lower = join(root, "missing", "denied.txt");
    expect(canonicalPathKey(mixed, root, "darwin")).toBe(canonicalPathKey(lower, root, "darwin"));
    expect(canonicalPathKey(mixed, root, "win32")).toBe(canonicalPathKey(lower, root, "win32"));
    expect(canonicalPathKey(mixed, root, "linux")).not.toBe(canonicalPathKey(lower, root, "linux"));
  });
});

describe("INV-07 the key is the real path of the longest part that exists", () => {
  test("a relative path is under the base, the missing tail is kept, and `..` is applied", () => {
    const root = tempRoot();
    mkdirSync(join(root, "sub"));
    expect(canonicalPathKey("sub/../sub/new.txt", root, "linux")).toBe(join(root, "sub", "new.txt"));
  });

  test("a folder link is followed, even for a file that does not exist yet", () => {
    const root = tempRoot();
    mkdirSync(join(root, "real"));
    try { symlinkSync(join(root, "real"), join(root, "link"), WINDOWS ? "junction" : "dir"); } catch { return; /* no privilege to link */ }
    expect(canonicalPathKey(join(root, "link", "new.txt"), root, "linux")).toBe(join(root, "real", "new.txt"));
  });

  test.skipIf(!WINDOWS)("on Windows the on-disk spelling is used: the key does not depend on how the owner typed the case", () => {
    const root = tempRoot();
    mkdirSync(join(root, "MixedDir"));
    writeFileSync(join(root, "MixedDir", "File.txt"), "x");
    // Not folded here (linux): what is left is what the file system says, so `mixeddir` and `MIXEDDIR` agree before any folding.
    expect(canonicalPathKey(join(root, "mixeddir", "file.txt"), root, "linux")).toBe(join(root, "MixedDir", "File.txt"));
    expect(canonicalPathKey(join(root, "MIXEDDIR", "FILE.TXT"), root, "linux")).toBe(join(root, "MixedDir", "File.txt"));
  });
});

describe("INV-07 a refusal made on one spelling covers every spelling of the file", () => {
  test("every route a refusal is recorded or matched by keys the file as its real path, folded where the file system folds", () => {
    const root = tempRoot();
    const scratch = join(root, "scratch");
    mkdirSync(scratch);
    const file = join(scratch, "Denied.txt");
    writeFileSync(file, "x");
    const saved = process.env.AGNI_SCRATCH_DIR;
    process.env.AGNI_SCRATCH_DIR = scratch;
    try {
      // The oracle is the file system's own answer, not the function under test: the native real path, folded on Windows.
      const real = realpathSync.native(file);
      const expected = WINDOWS ? real.toLowerCase() : real;
      const keyOf = (resources: ToolResource[]): string[] => resources.map((resource) => resource.value);
      const spellings = ["Denied.txt", file, ...(WINDOWS ? [file.toUpperCase(), file.toLowerCase(), file.replaceAll("\\", "/")] : [])];
      for (const spelling of spellings) {
        const routes = {
          pathResource: keyOf([pathResource(spelling)]),
          write_file: keyOf(assessCall(policyFor("write_file"), { path: spelling, content: "x" }).resources),
          read_file: keyOf(assessCall(policyFor("read_file"), { path: spelling }).resources),
          shell: keyOf(shellFacts(`rm ${shell(spelling)}`, scratch).resources),
        };
        expect({ spelling, routes }).toEqual({ spelling, routes: { pathResource: [expected], write_file: [expected], read_file: [expected], shell: [expected] } });
      }
    } finally {
      if (saved === undefined) delete process.env.AGNI_SCRATCH_DIR; else process.env.AGNI_SCRATCH_DIR = saved;
    }
  });

  if (WINDOWS) scenarioTest("after the owner refuses rm of q1, a write_file to Q1 (another case) is refused with no card", async () => {
    const s = await scenarios.start();
    mkdirSync(s.scratch, { recursive: true });
    const target = join(s.scratch, "q1");
    writeFileSync(target, "original");
    s.model.queue(...scripted(true, [
      call("bash", { command: `rm ${shell(target)}` }, "call_rm"),
      call("write_file", { path: join(s.scratch, "Q1"), content: "overwritten" }, "call_route"),
      say("Done."),
    ]));
    const a = await s.connect({ label: "A" });
    const report = await playTurn(s, a, "clean up q1", { answer: () => "reject" });
    const record = report.calls.find((entry) => entry.callID === "call_route");
    expect(record, "the bot never tried the route; the script is out of step").toBeDefined();
    expect(record!.card, "another spelling of the refused file raised a card").toBeNull();
    expect(Object.hasOwn(resultJson(record), "error")).toBe(true);
  });
});
