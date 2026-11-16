import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, parse, relative, resolve } from "node:path";
import { agniHome } from "../home";
import { log } from "../log";
import { secureDirectoryIfNeeded } from "../util/private-file";
import { MIGRATIONS } from "./migrations";

/**
 * A database the owner placed outside AGNI_HOME (`AGNI_DB_PATH`) is not covered
 * by the home's owner-only folder, so on Windows its own folder gets the same.
 * A failure warns and the server carries on. Only the path the owner named is
 * treated this way: a database opened at any other path (a test, a tool) never
 * changes a folder's access rules. A drive root is never touched either, and
 * neither is anything inside the home, which the server secures itself.
 */
function secureConfiguredDatabaseFolder(path: string): void {
  const configured = process.env.AGNI_DB_PATH?.trim();
  if (!configured || resolve(configured) !== resolve(path)) return;
  const folder = dirname(resolve(path));
  if (parse(folder).root === folder) return;
  const fromHome = relative(agniHome(), folder);
  if (fromHome === "" || (!fromHome.startsWith("..") && !isAbsolute(fromHome))) return;
  secureDirectoryIfNeeded(folder, "warn");
}

/** Open (creating if needed), apply WAL mode and migrations, return the handle. */
export function openDatabase(path: string): Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
    // Before the file exists, so the database and its WAL files inherit it.
    secureConfiguredDatabaseFolder(path);
  }
  const db = new Database(path, { create: true });
  // A CLI and the daemon share this file; wait for the other writer instead of failing with SQLITE_BUSY.
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  const applied = migrate(db);
  if (applied.length > 0) log.info(`db: applied migrations ${applied.join(", ")}`);
  return db;
}

/**
 * Open the database for a CLI command (`pair`, `revoke`, `job add`, …). The
 * schema belongs to the daemon, so this never migrates: a database that is
 * behind this build is refused with a message that says how to fix it.
 */
export function openDatabaseForCLI(path: string): Database {
  if (!existsSync(path)) throw new Error(`no database at ${path} — run \`agni setup\` (or \`agni migrate\`) first`);
  const db = new Database(path, { readwrite: true, create: false });
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = ON;");
  const latest = MIGRATIONS.at(-1)?.id ?? 0;
  let current = 0;
  try {
    current = db.query<{ id: number | null }, []>("SELECT max(id) AS id FROM schema_migrations").get()?.id ?? 0;
  } catch {
    // No schema_migrations table: a database no server has ever opened.
  }
  if (current < latest) {
    db.close();
    throw new Error(
      `database ${path} is at schema ${current}, this build needs ${latest} — run \`agni setup\` (or \`agni migrate\`) first`,
    );
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
