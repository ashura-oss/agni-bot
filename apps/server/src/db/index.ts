import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, isAbsolute, parse, relative, resolve } from "node:path";
import { agniHome } from "../home";
import { log } from "../log";
import { isOwnerOnlyDirectory, secureDirectoryIfNeeded, secureFile, writePrivateFileSync } from "../util/private-file";
import { MIGRATIONS, type Migration } from "./migrations";

/**
 * How a database path is protected: on Windows "private" is an ACL, on macOS and
 * Linux it is a mode (700 folder, 600 files; an umask can only narrow a mode,
 * but a database created through SQLite would take 644 & ~umask, so the files are
 * made 600 first).
 *  - "folder": its folder is the server's to lock, owner-only, before SQLite
 *    opens anything, so every file made in it (the database, `-wal`, `-shm`,
 *    and the ones SQLite makes again later) inherits that from birth. This is
 *    the data folder inside AGNI_HOME, and a folder the owner's `AGNI_DB_PATH`
 *    names that the server creates or finds empty.
 *  - "files": a folder that already holds other things is not ours to change
 *    (removing inheritance could cut access to a whole profile or shared
 *    folder), so the three database files are created locked before SQLite
 *    opens them.
 * Any other database (a test, a tool, a drive root) is left alone.
 */
type Protection = "folder" | "files" | null;

function protectionFor(path: string, createdFolder: boolean): Protection {
  const folder = dirname(resolve(path));
  if (parse(folder).root === folder) return null;
  const inside = (dir: string, base: string): boolean => {
    const from = relative(base, dir);
    return from === "" || (!from.startsWith("..") && !isAbsolute(from));
  };
  if (inside(folder, agniHome())) return "folder";
  const configured = process.env.AGNI_DB_PATH?.trim();
  if (!configured || resolve(configured) !== resolve(path)) return null;
  // Ours: made by this start, empty, or already locked owner-only by an earlier start (it holds the database now).
  return createdFolder || readdirSync(folder).length === 0 || isOwnerOnlyDirectory(folder) ? "folder" : "files";
}

/** A refusal that names the database, so the owner can fix the folder or move it. */
function cannotProtect(path: string, error: unknown): Error {
  const why = error instanceof Error ? error.message : String(error);
  return new Error(`Cannot restrict the database at ${path} to your account (${why}). Refusing to start: the data would be readable by other accounts. Fix the folder's permissions or point AGNI_DB_PATH somewhere else.`, { cause: error });
}

/** The database file and its write-ahead files. */
const databaseFiles = (path: string): string[] => [path, `${path}-wal`, `${path}-shm`];

/**
 * Create each missing database file empty and owner-only (through the private
 * file helper, so it is never visible with other access), and lock the ones
 * that exist. SQLite then opens files that are already private. Throws when
 * any cannot be locked; nothing stays behind that was created here.
 */
function lockDatabaseFiles(path: string): void {
  const made: string[] = [];
  try {
    for (const file of databaseFiles(path)) {
      if (existsSync(file)) secureFile(file);
      else { writePrivateFileSync(file, ""); made.push(file); }
    }
  } catch (error) {
    for (const file of made) rmSync(file, { force: true });
    throw error;
  }
}

/**
 * Protect a database path before SQLite opens it (see `Protection`). A failure
 * refuses to start, naming the path, and leaves nothing behind it created.
 */
function protectBeforeOpen(path: string, createdFolder: boolean): Protection {
  const protection = protectionFor(path, createdFolder);
  try {
    if (protection === "folder") secureDirectoryIfNeeded(dirname(resolve(path)), "throw");
    else if (protection === "files") {
      log.warn(`${dirname(resolve(path))} already holds other files, so its access rules are left alone; the database files are restricted to your account one by one`);
      lockDatabaseFiles(path);
    }
  } catch (error) {
    throw cannotProtect(path, error);
  }
  return protection;
}

/** The write-ahead files exist once the database is in use; lock any SQLite made itself, before a row is written. */
function protectAfterOpen(db: Database, path: string, protection: Protection): void {
  if (protection !== "files") return;
  try {
    lockDatabaseFiles(path);
  } catch (error) {
    db.close();
    throw cannotProtect(path, error);
  }
}

/** Open (creating if needed), apply WAL mode and migrations, return the handle. */
export function openDatabase(path: string): Database {
  let protection: Protection = null;
  if (path !== ":memory:") {
    const created = mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    protection = protectBeforeOpen(path, created !== undefined);
  }
  const db = new Database(path, { create: true });
  // A CLI and the daemon share this file; wait for the other writer instead of failing with SQLITE_BUSY.
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = WAL;");
  protectAfterOpen(db, path, protection);
  db.exec("PRAGMA foreign_keys = ON;");
  const applied = migrate(db);
  if (applied.length > 0) log.info(`db: applied migrations ${applied.join(", ")}`);
  return db;
}

/** A database that exists but lacks migrations this version lists. `missing` holds their ids. */
export class DatabaseBehindError extends Error {
  constructor(readonly path: string, readonly current: number, readonly missing: number[]) {
    super(`database ${path} is at schema ${current}, missing migration(s) ${missing.join(", ")} — run \`agni setup\` (or \`agni migrate\`) first`);
    this.name = "DatabaseBehindError";
  }
}

/**
 * Open the database for a CLI command (`pair`, `revoke`, `job add`, …). The
 * schema belongs to the daemon, so this never migrates: a database that is
 * behind this build is refused with a message that says how to fix it. It is
 * protected exactly as the server's own open is: the CLI can be the process
 * that makes the -wal and -shm files while the daemon is stopped.
 */
export function openDatabaseForCLI(path: string, migrations: ReadonlyArray<Migration> = MIGRATIONS): Database {
  if (!existsSync(path)) throw new Error(`no database at ${path} — run \`agni setup\` (or \`agni migrate\`) first`);
  const protection = protectBeforeOpen(path, false);
  const db = new Database(path, { readwrite: true, create: false });
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = ON;");
  let current = 0;
  const applied = new Set<number>();
  try {
    for (const row of db.query<{ id: number }, []>("SELECT id FROM schema_migrations").all()) {
      applied.add(row.id);
      current = Math.max(current, row.id);
    }
  } catch {
    // No schema_migrations table: a database no server has ever opened.
  }
  protectAfterOpen(db, path, protection);
  // Every listed id must be applied, not just the highest: sprint branches add
  // migrations in separate id ranges, so a database can hold 60 and lack 54.
  const missing = migrations.map((migration) => migration.id).filter((id) => !applied.has(id));
  if (missing.length > 0) {
    db.close();
    throw new DatabaseBehindError(path, current, missing);
  }
  return db;
}

/**
 * Open a database without touching it. A scan (the canary scan) has to
 * read the live database without migrating it: the schema belongs to the
 * daemon that owns it.
 */
export function openDatabaseReadOnly(path: string): Database {
  const db = new Database(path, { create: false, readonly: true });
  db.exec("PRAGMA query_only = ON;");
  return db;
}

/** Apply pending migrations; returns the ids that ran. */
export function migrate(db: Database): number[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  const rows = db.query<{ id: number }, []>("SELECT id FROM schema_migrations").all();
  const applied = new Set(rows.map((row) => row.id));
  const ran: number[] = [];
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.run("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)", [
        migration.id,
        migration.name,
        new Date().toISOString(),
      ]);
    })();
    ran.push(migration.id);
  }
  return ran;
}

export function readMeta(db: Database, key: string): string | null {
  const row = db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key);
  return row?.value ?? null;
}

export function writeMeta(db: Database, key: string, value: string): void {
  db.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [
    key,
    value,
  ]);
}
