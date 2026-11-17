/**
 * S3-9 item 7: `agni vault migrate` and `export` move OAuth tokens in and out of
 * the database. A database that exists but is behind (migration 62 not applied)
 * must stop the command with a message that names `agni migrate`; it must not be
 * skipped as if there were no database, which would leave tokens in the clear
 * while the home switches to vault mode.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanChildEnv } from "./test-child-env";
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

    const child = Bun.spawn([process.execPath, ENTRY, "vault", "migrate"], {
      cwd: tmpdir(),
      env: cleanChildEnv({ AGNI_HOME: home, AGNI_KEYSTORE: "passphrase", AGNI_VAULT_PASSPHRASE_FILE: join(parent, "pp.txt") }),
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

describe("agni vault migrate and the database's backups (real child process)", () => {
  test("deletes the old backups that held the tokens, takes a fresh one, and says so", async () => {
    const parent = fresh();
    writeFileSync(join(parent, "pp.txt"), `${PASSPHRASE}\n`);
    const home = join(parent, "home");
    mkdirSync(join(home, "data", "backups"), { recursive: true });
    writeFileSync(join(home, "config.env"), "AGNI_HOST=127.0.0.1\n");
    const dbPath = join(home, "data", "agni.sqlite");
    const token = "ya29.cli-backup-canary-token-0123456789";
    const db = openDatabase(dbPath);
    db.run(
      "INSERT INTO plugin_connections (id, plugin_id, account, status, account_label, scopes, capabilities, tokens, error, grant_started_at, connected_at, updated_at) VALUES ('plc_x', 'calendar', 'agent', 'connected', 'me', '[]', '[]', ?, NULL, 'now', 'now', 'now')",
      [JSON.stringify({ access_token: token, refresh_token: "1//cli-backup-canary-refresh-0123456789" })],
    );
    const oldBackup = join(home, "data", "backups", "agni-20260101.db");
    db.run(`VACUUM INTO '${oldBackup.replaceAll("'", "''")}'`);
    db.close();
    expect(readFileSync(oldBackup).includes(token)).toBe(true);

    const child = Bun.spawn([process.execPath, ENTRY, "vault", "migrate"], {
      cwd: tmpdir(),
      env: cleanChildEnv({ AGNI_HOME: home, AGNI_KEYSTORE: "passphrase", AGNI_VAULT_PASSPHRASE_FILE: join(parent, "pp.txt") }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const code = await child.exited;
    expect(code).toBe(0);
    expect(err).not.toMatch(/error|stopped/i);
    expect(out).toMatch(/deleted 1 old database backup/);
    expect(out).toMatch(/fresh backup/);
    expect(existsSync(oldBackup)).toBe(false);
    const backups = readdirSync(join(home, "data", "backups"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(home, "data", "backups", backups[0]!)).includes(token)).toBe(false);
    expect(out).not.toContain(token);
  }, 60_000);
});
