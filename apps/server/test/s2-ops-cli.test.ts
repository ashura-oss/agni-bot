/**
 * S2-12 / S2-13 from the command line: `agni audit verify`, `agni pause`,
 * `agni resume`, run through the real entry point against a throwaway home.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db";
import { SqliteAuditSink } from "../src/stores/audit";
import { readPauseState } from "../src/policy/pause";
import { extraHelpLines } from "../src/cli/extra-commands";

let home: string;
let dbPath: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agni-s2-cli-"));
  mkdirSync(join(home, "data"), { recursive: true });
  dbPath = join(home, "data", "agni.sqlite");
  const db = openDatabase(dbPath);
  const sink = new SqliteAuditSink(db);
  for (let i = 0; i < 4; i += 1) sink.record({ kind: "config.changed", actor: "device_1", detail: { i } });
  db.close();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

async function agni(...argv: string[]): Promise<{ out: string; err: string; code: number }> {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/index.ts"), ...argv], {
    env: { ...process.env, AGNI_HOME: home, AGNI_DB_PATH: dbPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out, err, code };
}

describe("agni audit verify", () => {
  test("passes on an intact log", async () => {
    const result = await agni("audit", "verify");
    expect(result.code).toBe(0);
    expect(result.out).toContain("Audit log OK: 4 events");
  });

  test("fails, naming the row, after one byte of a row is flipped", async () => {
    const db = new Database(dbPath);
    const row = db.query<{ detail: string }, []>("SELECT detail FROM audit_events WHERE seq = 2").get()!;
    db.run("UPDATE audit_events SET detail = ? WHERE seq = 2", [row.detail.replace("1", "7")]);
    db.close();
    const result = await agni("audit", "verify");
    expect(result.code).toBe(1);
    expect(result.err).toContain("Audit log FAILED");
    expect(result.err).toContain("First row that does not fit: 2");
  });

  test("without a subcommand it prints the usage and fails", async () => {
    const result = await agni("audit");
    expect(result.code).toBe(1);
    expect(result.err).toContain("usage: agni audit verify");
  });
});

describe("agni pause and resume", () => {
  test("pause sets the shared state and says so; resume and pause --off lift it", async () => {
    const paused = await agni("pause");
    expect(paused.code).toBe(0);
    expect(paused.out).toContain("All bots paused. Nothing new will start.");
    let db = new Database(dbPath);
    expect(readPauseState(db).paused).toBe(true);
    expect(readPauseState(db).changedBy).toBe("cli");
    db.close();

    expect((await agni("resume")).out).toContain("Bots resumed.");
    db = new Database(dbPath);
    expect(readPauseState(db).paused).toBe(false);
    db.close();

    await agni("pause");
    const off = await agni("pause", "--off");
    expect(off.out).toContain("Bots resumed.");
  });

  test("pausing and resuming are in the audit log, and the log still verifies", async () => {
    await agni("pause");
    await agni("resume");
    const db = new Database(dbPath);
    const kinds = db.query<{ kind: string }, []>("SELECT kind FROM audit_events ORDER BY seq").all().map((row) => row.kind);
    expect(kinds.slice(-2)).toEqual(["pause.set", "pause.set"]);
    db.close();
    expect((await agni("audit", "verify")).code).toBe(0);
  });

  test("the help lists the new commands", () => {
    const help = extraHelpLines().join("\n");
    expect(help).toContain("audit verify");
    expect(help).toContain("pause");
    expect(help).toContain("resume");
  });
});
