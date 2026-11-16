/**
 * S1-36 and S1-06: where a path points, and which writes ask.
 *
 * Relative paths resolve against the scratch directory (never the server's
 * working directory), Windows paths compare case-insensitively, and inside
 * scratch only a write that would overwrite an existing file asks.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalBroker } from "../src/agent/approval-broker";
import { confineToScratch, isInsidePath, isOutsideScratch, resolveWritePath, writeFile } from "../src/tools/write-file";
import { glob, grep } from "../src/tools/search";

const broker = new ApprovalBroker({
  db: null as unknown as Database,
  emit: () => undefined,
  waitForDecision: async () => null,
});

let root: string;
let scratch: string;
let savedScratch: string | undefined;
let savedCwd: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agni-t3-paths-"));
  scratch = join(root, "scratch");
  mkdirSync(scratch, { recursive: true });
  savedScratch = process.env.AGNI_SCRATCH_DIR;
  process.env.AGNI_SCRATCH_DIR = scratch;
  savedCwd = process.cwd();
  // A server started from somewhere else entirely: not scratch, not the repo.
  mkdirSync(join(root, "elsewhere"), { recursive: true });
  process.chdir(join(root, "elsewhere"));
});

afterEach(() => {
  process.chdir(savedCwd);
  if (savedScratch === undefined) delete process.env.AGNI_SCRATCH_DIR;
  else process.env.AGNI_SCRATCH_DIR = savedScratch;
  rmSync(root, { recursive: true, force: true });
});

describe("S1-36: relative paths resolve against scratch", () => {
  test("a relative path is inside scratch, not relative to the server's cwd", () => {
    expect(isOutsideScratch("notes/today.md", scratch)).toBe(false);
    expect(resolveWritePath("notes/today.md")).toBe(join(confineToScratch(scratch), "notes", "today.md"));
  });

  test("isOutsideScratch without a base keeps the OS meaning (the bash cwd is handed to the OS, which uses the process cwd)", () => {
    expect(isOutsideScratch("notes/today.md")).toBe(true);
  });

  test("a relative path that climbs out of scratch is outside", () => {
    expect(isOutsideScratch("../elsewhere/x.txt", scratch)).toBe(true);
    expect(isOutsideScratch("a/../../x.txt", scratch)).toBe(true);
    expect(() => confineToScratch("../x.txt")).toThrow("outside the scratch directory");
  });

  test("writeFile puts a relative path under scratch and leaves the cwd alone", () => {
    const result = writeFile({ path: "out/report.txt", content: "hello" });
    expect(readFileSync(join(scratch, "out", "report.txt"), "utf8")).toBe("hello");
    expect(existsSync(join(root, "elsewhere", "out"))).toBe(false);
    expect(result.path).toBe(resolveWritePath("out/report.txt")!);
    expect(result.created).toBe(true);
  });

  test("grep and glob take scratch-relative roots", () => {
    mkdirSync(join(scratch, "docs"), { recursive: true });
    writeFileSync(join(scratch, "docs", "a.txt"), "needle here\n");
    expect(grep({ pattern: "needle", path: "docs" }).matches.map((m) => m.line)).toEqual([1]);
    expect(glob({ pattern: "*.txt", path: "docs" }).matches).toEqual(["a.txt"]);
  });

  test("a symlink in scratch that points outside is still outside", () => {
    mkdirSync(join(root, "secret"), { recursive: true });
    try { symlinkSync(join(root, "secret"), join(scratch, "link"), "junction"); } catch { return; }
    expect(isOutsideScratch("link/key.txt", scratch)).toBe(true);
    expect(() => confineToScratch("link/key.txt")).toThrow("outside the scratch directory");
  });
});

describe("S1-36: Windows paths compare case-insensitively", () => {
  test("isInsidePath honours the case flag", () => {
    expect(isInsidePath("C:\\Users\\Me\\scratch", "c:\\users\\me\\SCRATCH\\a.txt", true, "\\")).toBe(true);
    expect(isInsidePath("C:\\Users\\Me\\scratch", "c:\\users\\me\\SCRATCH\\a.txt", false, "\\")).toBe(false);
    // A sibling that shares a prefix is never inside, whatever the case rule.
    expect(isInsidePath("C:\\Users\\Me\\scratch", "C:\\Users\\Me\\scratch-x\\a.txt", true, "\\")).toBe(false);
    expect(isInsidePath("/a/scratch", "/a/scratch", false, "/")).toBe(true);
  });

  test.skipIf(process.platform !== "win32")("a differently-cased absolute path into scratch is inside on win32", () => {
    expect(isOutsideScratch(join(scratch.toUpperCase(), "a.txt"))).toBe(false);
    expect(isOutsideScratch(join(scratch.toLowerCase(), "a.txt"))).toBe(false);
    expect(() => confineToScratch(join(scratch.toUpperCase(), "a.txt"))).not.toThrow();
  });
});

describe("S1-06: inside scratch only overwriting asks", () => {
  test("writing a new file inside scratch is free", () => {
    expect(broker.requiresApproval("write_file", { path: join(scratch, "new.md"), content: "x" })).toBe(false);
    expect(broker.requiresApproval("write_file", { path: "new.md", content: "x" })).toBe(false);
    expect(broker.requiresApproval("write_file", { path: "deep/new/dir/new.md", content: "x" })).toBe(false);
  });

  test("overwriting an existing file inside scratch asks", () => {
    writeFileSync(join(scratch, "keep.md"), "precious");
    expect(broker.requiresApproval("write_file", { path: join(scratch, "keep.md"), content: "" })).toBe(true);
    // The same file named relatively, and with a case change on Windows.
    expect(broker.requiresApproval("write_file", { path: "keep.md", content: "x" })).toBe(true);
    expect(broker.requiresApproval("write_file", { path: "./sub/../keep.md", content: "x" })).toBe(true);
    if (process.platform === "win32") {
      expect(broker.requiresApproval("write_file", { path: join(scratch, "KEEP.MD"), content: "x" })).toBe(true);
    }
  });

  test("appending to an existing file inside scratch stays free (it destroys nothing)", () => {
    writeFileSync(join(scratch, "log.md"), "one\n");
    expect(broker.requiresApproval("write_file", { path: "log.md", content: "two\n", append: true })).toBe(false);
    expect(broker.requiresApproval("write_file", { path: "log.md", content: "two\n", append: false })).toBe(true);
  });

  test("outside scratch always asks, new file or not", () => {
    expect(broker.requiresApproval("write_file", { path: join(root, "elsewhere", "brand-new.txt"), content: "x" })).toBe(true);
    expect(broker.requiresApproval("write_file", { path: "../elsewhere/brand-new.txt", content: "x" })).toBe(true);
    expect(broker.requiresApproval("write_file", { path: "", content: "x" })).toBe(true);
  });
});
