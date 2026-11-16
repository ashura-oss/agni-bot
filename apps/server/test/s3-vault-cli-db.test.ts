/**
 * S3-9 item 7: `agni vault migrate` and `export` move OAuth tokens in and out of
 * the database. A database that exists but is behind (migration 62 not applied)
 * must stop the command with a message that names `agni migrate`; it must not be
 * skipped as if there were no database, which would leave tokens in the clear
 * while the home switches to vault mode.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { optionalDatabase } from "../src/cli/s3-vault";
import { DatabaseBehindError, openDatabase } from "../src/db";

const ENTRY = resolve(import.meta.dir, "../src/index.ts");
const PASSPHRASE = "correct horse battery staple";
const CANARY = "gsk_cli_db_canary_0123456789";

let roots: string[] = [];
const fresh = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "agni-vcdb-"));
  roots.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  roots = [];
});

/** A real database file, current except that migration 62 is not recorded as applied. */
function databaseBehind(path: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const db = openDatabase(path);
  db.run("DELETE FROM schema_migrations WHERE id = 62");
  db.close();
}

describe("optionalDatabase", () => {
  test("no database file is fine: there is nothing in it to move", () => {
    expect(optionalDatabase(join(fresh(), "none.sqlite"))).toBeUndefined();
  });

  test("a current database opens", () => {
    const path = join(fresh(), "agni.sqlite");
    openDatabase(path).close();
    const db = optionalDatabase(path);
    expect(db).toBeDefined();
    db?.close();
  });

  test("a database behind migration 62 is refused with a message that names `agni migrate`", () => {
    const path = join(fresh(), "agni.sqlite");
    databaseBehind(path);
    let error: unknown;
    try {
      optionalDatabase(path);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("agni migrate");
    expect(message).toContain("62");
  });

  test("openDatabaseForCLI's refusal is a typed DatabaseBehindError that lists the missing ids", async () => {
    const path = join(fresh(), "agni.sqlite");
    databaseBehind(path);
    const { openDatabaseForCLI } = await import("../src/db");
    let error: unknown;
    try {
      openDatabaseForCLI(path);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DatabaseBehindError);
    expect((error as DatabaseBehindError).missing).toEqual([62]);
  });
});

describe("agni vault migrate against a database that is behind (real child process)", () => {
  test("stops, names `agni migrate`, and leaves config.env in plaintext mode", async () => {
    const parent = fresh();
    writeFileSync(join(parent, "pp.txt"), `${PASSPHRASE}\n`);
    const home = join(parent, "home");
    mkdirSync(home, { recursive: true });
    const configEnv = `AGNI_HOST=127.0.0.1\nGROQ_API_KEY=${CANARY}\n`;
    writeFileSync(join(home, "config.env"), configEnv);
    databaseBehind(join(home, "data", "agni.sqlite"));

    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (value === undefined || /^AGNI_|API_KEY|TOKEN|SECRET|PASSWORD|^GROQ|^CEREBRAS|^NVIDIA|^OPENROUTER/i.test(name)) continue;
      env[name] = value;
    }
    const child = Bun.spawn([process.execPath, ENTRY, "vault", "migrate"], {
      cwd: tmpdir(),
      env: { ...env, AGNI_HOME: home, AGNI_KEYSTORE: "passphrase", AGNI_VAULT_PASSPHRASE_FILE: join(parent, "pp.txt") },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const code = await child.exited;
    const printed = out + err;
    expect(code).not.toBe(0);
    expect(printed).toContain("agni migrate");
    expect(printed).not.toContain(CANARY);
    // Nothing moved and the home did not switch to vault mode.
    expect(readFileSync(join(home, "config.env"), "utf8")).toBe(configEnv);
  }, 60_000);
});
