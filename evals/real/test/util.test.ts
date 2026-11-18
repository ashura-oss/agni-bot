import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ctx } from "../types";
import { hasNumber, numbersIn, rd, rng, snapshot, w } from "../util";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
/** Only the folder fields the file helpers read. */
function scratchCtx(): Ctx {
  const scratch = mkdtempSync(join(tmpdir(), "agni-eval-util-"));
  dirs.push(scratch);
  return { scratch } as Ctx;
}

describe("eval util", () => {
  test("rng is the same for the same seed", () => {
    const a = rng(1001);
    const b = rng(1001);
    expect([a.int(1, 100), a.int(1, 100), a.int(1, 100)]).toEqual([b.int(1, 100), b.int(1, 100), b.int(1, 100)]);
    expect(rng(1001).next()).not.toBe(rng(1002).next());
  });

  test("numbers are found with $ and thousands separators", () => {
    expect(numbersIn("Total paid: $12,345.67 and 8")).toEqual([12345.67, 8]);
    expect(hasNumber("Total outstanding: $1,000.00", 1000)).toBe(true);
    expect(hasNumber("Total outstanding: $1,000.05", 1000)).toBe(false);
  });

  test("snapshot changes when a file changes", () => {
    const ctx = scratchCtx();
    w(ctx, "a/b.txt", "one");
    const before = snapshot(ctx);
    expect(Object.keys(before)).toEqual(["a/b.txt"]);
    writeFileSync(join(ctx.scratch, "a", "b.txt"), "two");
    expect(snapshot(ctx)["a/b.txt"]).not.toBe(before["a/b.txt"]);
    expect(rd(ctx, "a/b.txt")).toBe("two");
    expect(rd(ctx, "missing.txt")).toBeNull();
  });
});
