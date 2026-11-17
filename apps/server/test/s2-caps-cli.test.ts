/**
 * `agni policy caps` and `agni policy caps set` (S2-09): the owner reads and changes the three run limits from the
 * command line (30 minutes per run, 4 delegations at once, 10 self-scheduled jobs per bot) until the app has a screen
 * for them. Positive whole numbers only; a change that cannot be applied changes nothing and is on the audit record.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db";
import { capsReport, parseCapsSet, setCapsReport } from "../src/cli/s2-ops";
import { extraHelpLines } from "../src/cli/extra-commands";
import { RUN_CAP_DEFAULTS, getRunCaps, setRunCaps } from "../src/stores/policy-settings";

describe("parsing `policy caps set`", () => {
  test("each flag takes one positive whole number; minutes become milliseconds", () => {
    expect(parseCapsSet(["--wall-minutes", "45", "--delegations", "3", "--self-scheduled", "12", "--wakes", "7"])).toEqual({
      caps: { rootJobWallMs: 45 * 60_000, maxConcurrentDelegations: 3, maxSelfScheduledJobsPerBot: 12, maxWakesPerRequest: 7 },
    });
    expect(parseCapsSet(["--delegations", "6"])).toEqual({ caps: { maxConcurrentDelegations: 6 } });
    expect(parseCapsSet(["--wall-minutes=90"])).toEqual({ caps: { rootJobWallMs: 90 * 60_000 } });
  });

  test("the longest time limit is 7 days, the time clocks are kept", () => {
    expect(parseCapsSet(["--wall-minutes", "10080"])).toEqual({ caps: { rootJobWallMs: 7 * 86_400_000 } });
  });

  test.each([
    ["no flag at all", []],
    ["a flag with no value", ["--delegations"]],
    ["a flag followed by another flag", ["--delegations", "--wall-minutes", "5"]],
    ["zero", ["--delegations", "0"]],
    ["a negative number", ["--delegations", "-3"]],
    ["a fraction", ["--wall-minutes", "1.5"]],
    ["words", ["--self-scheduled", "ten"]],
    ["an empty value", ["--self-scheduled", ""]],
    ["an exponent", ["--wall-minutes", "1e3"]],
    ["a sign", ["--wall-minutes", "+5"]],
    ["hex", ["--wall-minutes", "0x10"]],
    ["a number too big to be exact", ["--delegations", "99999999999999999999"]],
    ["minutes that overflow as milliseconds", ["--wall-minutes", "9007199254740991"]],
    ["a time limit longer than the week clocks are kept", ["--wall-minutes", "10081"]],
    ["an unknown flag", ["--hours", "2"]],
    ["a flag twice", ["--delegations", "2", "--delegations", "3"]],
    ["wakes of zero", ["--wakes", "0"]],
    ["wakes twice", ["--wakes", "2", "--wakes", "3"]],
    ["a stray word", ["--delegations", "2", "three"]],
  ])("%s is refused with a message", (_name, args) => {
    const parsed = parseCapsSet(args);
    expect("error" in parsed, JSON.stringify(parsed)).toBe(true);
  });
});

describe("the report", () => {
  let db: Database;
  beforeEach(() => { db = openDatabase(":memory:"); });
  afterEach(() => db.close());

  test("it shows the three limits in the owner's words, defaults first", () => {
    const text = capsReport(db).join("\n");
    expect(text).toContain("30 minutes");
    expect(text).toContain("4 delegations");
    expect(text).toContain("10 self-scheduled jobs");
    expect(text).toContain("10 wakes");
    expect(text, "the time limit is per run, not per request").toContain("30 minutes per run (a turn or a job, and what it delegates)");
    expect(text).not.toContain("minutes per request");
    setRunCaps(db, { rootJobWallMs: 61 * 60_000, maxConcurrentDelegations: 1, maxSelfScheduledJobsPerBot: 1, maxWakesPerRequest: 1 });
    const changed = capsReport(db).join("\n");
    expect(changed).toContain("61 minutes");
    expect(changed).toContain("1 delegation ");
    expect(changed).toContain("1 self-scheduled job ");
    expect(changed).toContain("1 wake ");
  });

  test("a good change is applied, written to the audit log first, and reported with the new numbers", () => {
    const report = setCapsReport(db, ["--wall-minutes", "45", "--delegations", "2", "--wakes", "6"]);
    expect(report.code).toBe(0);
    expect(getRunCaps(db)).toEqual({ rootJobWallMs: 45 * 60_000, maxConcurrentDelegations: 2, maxSelfScheduledJobsPerBot: RUN_CAP_DEFAULTS.maxSelfScheduledJobsPerBot, maxWakesPerRequest: 6 });
    expect(report.lines.join("\n")).toContain("45 minutes");
    const row = db.query<{ kind: string; actor: string; detail: string }, []>("SELECT kind, actor, detail FROM audit_events ORDER BY seq DESC LIMIT 1").get();
    expect(row?.kind).toBe("run.caps.set");
    expect(row?.actor).toBe("cli");
    expect(JSON.parse(row!.detail)).toEqual({
      before: { rootJobWallMs: 30 * 60_000, maxConcurrentDelegations: 4, maxSelfScheduledJobsPerBot: 10, maxWakesPerRequest: 10 },
      after: { rootJobWallMs: 45 * 60_000, maxConcurrentDelegations: 2, maxSelfScheduledJobsPerBot: 10, maxWakesPerRequest: 6 },
    });
  });

  test("a bad value changes nothing, records nothing and exits with an error", () => {
    const report = setCapsReport(db, ["--wall-minutes", "45", "--delegations", "0"]);
    expect(report.code).toBe(1);
    expect(getRunCaps(db)).toEqual(RUN_CAP_DEFAULTS);
    expect(db.query("SELECT 1 FROM audit_events WHERE kind = 'run.caps.set'").get()).toBeNull();
    expect(report.lines.join("\n")).toContain("--delegations");
  });
});

describe("the change and its audit record are one step", () => {
  let db: Database;
  beforeEach(() => { db = openDatabase(":memory:"); });
  afterEach(() => db.close());

  test("a change that cannot be written leaves no audit record that says it was made", () => {
    db.run("CREATE TRIGGER refuse_settings BEFORE INSERT ON policy_settings BEGIN SELECT RAISE(ABORT, 'settings are read-only'); END");
    const report = setCapsReport(db, ["--delegations", "2"]);
    expect(report.code).toBe(1);
    expect(report.lines.join("\n")).toContain("settings are read-only");
    expect(db.query("SELECT 1 FROM audit_events WHERE kind = 'run.caps.set'").get(), "the log says a change was made that was not").toBeNull();
  });

  test("a time limit longer than the clocks are kept is refused by the store as well", () => {
    expect(() => setRunCaps(db, { rootJobWallMs: 7 * 86_400_000 + 1 })).toThrow(/at most 7 days/);
    expect(getRunCaps(db).rootJobWallMs).toBe(RUN_CAP_DEFAULTS.rootJobWallMs);
    setRunCaps(db, { rootJobWallMs: 7 * 86_400_000 });
    expect(getRunCaps(db).rootJobWallMs).toBe(7 * 86_400_000);
  });
});

describe("through the real entry point", () => {
  let home: string;
  let dbPath: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agni-caps-cli-"));
    mkdirSync(join(home, "data"), { recursive: true });
    dbPath = join(home, "data", "agni.sqlite");
    openDatabase(dbPath).close();
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  async function agni(...argv: string[]): Promise<{ out: string; err: string; code: number }> {
    const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/index.ts"), ...argv], {
      env: { ...process.env, AGNI_HOME: home, AGNI_DB_PATH: dbPath },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { out, err, code };
  }

  test("show, set, show again", async () => {
    const before = await agni("policy", "caps");
    expect(before.code).toBe(0);
    expect(before.out).toContain("30 minutes");
    const set = await agni("policy", "caps", "set", "--wall-minutes", "50", "--delegations", "5", "--self-scheduled", "7", "--wakes", "3");
    expect(set.code).toBe(0);
    const after = await agni("policy", "caps");
    expect(after.out).toContain("50 minutes");
    expect(after.out).toContain("5 delegations");
    expect(after.out).toContain("7 self-scheduled jobs");
    expect(after.out).toContain("3 wakes");
    const db = new Database(dbPath);
    expect(getRunCaps(db).rootJobWallMs).toBe(50 * 60_000);
    db.close();
  });

  test("a bad number exits 1, says what is wrong on stderr, and leaves the limits alone", async () => {
    const result = await agni("policy", "caps", "set", "--delegations", "-2");
    expect(result.code).toBe(1);
    expect(result.err).toContain("--delegations");
    const db = new Database(dbPath);
    expect(getRunCaps(db).maxConcurrentDelegations).toBe(RUN_CAP_DEFAULTS.maxConcurrentDelegations);
    db.close();
  });

  test("without a subcommand it prints the usage and fails", async () => {
    const result = await agni("policy");
    expect(result.code).toBe(1);
    expect(result.err).toContain("usage: agni policy caps");
  });

  test("the help lists it", () => {
    expect(extraHelpLines().join("\n")).toContain("policy caps");
  });
});
