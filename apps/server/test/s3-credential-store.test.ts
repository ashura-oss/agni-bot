/**
 * S3-02 / migration 62: OAuth tokens in `plugin_connections`.
 *
 * File mode (the default) keeps them in the `tokens` column as before. Vault
 * mode keeps them in the vault, and the row holds only a reference in
 * `token_ref`: the column is empty, so the database file carries no credential.
 * Throwaway home and database, in-memory keystore (see preload).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db";
import { MIGRATIONS } from "../src/db/migrations";
import {
  completeConnect,
  deleteConnection,
  getConnection,
  readConnectionTokens,
  startPending,
  updateTokens,
} from "../src/plugins/store";
import { VaultError, lockVault, unlockVault, type Vault } from "../src/secrets";

const ACCESS = "ya29.canary-access-token-0123456789abcdef";
const REFRESH = "1//canary-refresh-token-0123456789abcdef";

let roots: string[] = [];
let savedMode: string | undefined;
beforeEach(() => {
  savedMode = process.env.AGNI_SECRETS_MODE;
  delete process.env.AGNI_SECRETS_MODE;
  lockVault();
});
afterEach(() => {
  lockVault();
  if (savedMode === undefined) delete process.env.AGNI_SECRETS_MODE;
  else process.env.AGNI_SECRETS_MODE = savedMode;
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  roots = [];
});

async function vaultMode(): Promise<Vault> {
  const home = mkdtempSync(join(tmpdir(), "agni-credstore-"));
  roots.push(home);
  const vault = await unlockVault({ home, create: true });
  process.env.AGNI_SECRETS_MODE = "vault";
  return vault;
}

/** Every byte of the database, as text, to look for a secret in. */
const databaseText = (db: ReturnType<typeof openDatabase>): string => Buffer.from(db.serialize()).toString("latin1");

describe("migration 62", () => {
  test("adds the token reference column and is recorded", () => {
    expect(MIGRATIONS.some((migration) => migration.id === 62)).toBe(true);
    const db = openDatabase(":memory:");
    const columns = db.query<{ name: string }, []>("PRAGMA table_info(plugin_connections)").all().map((column) => column.name);
    expect(columns).toContain("token_ref");
    expect(db.query<{ id: number }, []>("SELECT id FROM schema_migrations WHERE id = 62").get()).toEqual({ id: 62 });
    db.close();
  });
});

describe("file mode", () => {
  test("tokens stay in the column, no reference is made", () => {
    const db = openDatabase(":memory:");
    const pending = startPending(db, { pluginID: "calendar", account: "agent", scopes: ["s"], capabilities: [] });
    const row = completeConnect(db, pending.id, { access_token: ACCESS, refresh_token: REFRESH }, "me@example.com");
    expect(row.token_ref).toBeNull();
    expect(JSON.parse(row.tokens!)).toEqual({ access_token: ACCESS, refresh_token: REFRESH });
    expect(readConnectionTokens(row)).toEqual({ access_token: ACCESS, refresh_token: REFRESH });
    db.close();
  });
});

describe("vault mode", () => {
  test("completeConnect puts the tokens in the vault and only a reference in the row", async () => {
    const vault = await vaultMode();
    const db = openDatabase(":memory:");
    const pending = startPending(db, { pluginID: "calendar", account: "agent", scopes: ["s"], capabilities: [] });
    const row = completeConnect(db, pending.id, { access_token: ACCESS, refresh_token: REFRESH, expires_at: 123 }, "me@example.com");

    expect(row.tokens).toBeNull();
    expect(row.token_ref).toBe(`plugin-token/${pending.id}`);
    expect(JSON.parse(vault.get(row.token_ref!)!)).toEqual({ access_token: ACCESS, refresh_token: REFRESH, expires_at: 123 });
    expect(readConnectionTokens(row)).toEqual({ access_token: ACCESS, refresh_token: REFRESH, expires_at: 123 });
    // The database file has neither token in any byte of it.
    expect(databaseText(db)).not.toContain(ACCESS);
    expect(databaseText(db)).not.toContain(REFRESH);
    db.close();
  });

  test("updateTokens replaces the vault copy and leaves the column empty", async () => {
    const vault = await vaultMode();
    const db = openDatabase(":memory:");
    const pending = startPending(db, { pluginID: "calendar", account: "agent", scopes: ["s"], capabilities: [] });
    completeConnect(db, pending.id, { access_token: ACCESS, refresh_token: REFRESH }, "me");
    updateTokens(db, pending.id, { access_token: `${ACCESS}-new`, refresh_token: REFRESH });
    const row = getConnection(db, pending.id)!;
    expect(row.tokens).toBeNull();
    expect(readConnectionTokens(row).access_token).toBe(`${ACCESS}-new`);
    expect(vault.list("plugin-token/").map((entry) => entry.name)).toEqual([`plugin-token/${pending.id}`]);
    expect(databaseText(db)).not.toContain(ACCESS);
    db.close();
  });

  test("a new connect wipes the old grant's vault entry, as it wipes the old column", async () => {
    const vault = await vaultMode();
    const db = openDatabase(":memory:");
    const first = startPending(db, { pluginID: "calendar", account: "agent", scopes: ["s"], capabilities: [] });
    completeConnect(db, first.id, { access_token: ACCESS, refresh_token: REFRESH }, "me");
    const again = startPending(db, { pluginID: "calendar", account: "agent", scopes: ["s"], capabilities: [] });
    expect(again.id).toBe(first.id);
    expect(again.token_ref).toBeNull();
    expect(readConnectionTokens(again)).not.toHaveProperty("access_token");
    expect(vault.has(`plugin-token/${first.id}`)).toBe(false);
    db.close();
  });

  test("deleting the connection deletes its vault entry", async () => {
    const vault = await vaultMode();
    const db = openDatabase(":memory:");
    const pending = startPending(db, { pluginID: "calendar", account: "agent", scopes: ["s"], capabilities: [] });
    completeConnect(db, pending.id, { access_token: ACCESS }, "me");
    expect(deleteConnection(db, pending.id)).toBe(true);
    expect(vault.list("plugin-token/")).toEqual([]);
    db.close();
  });

  test("a blob with no secret in it (an MCP connect) is not sent to the vault", async () => {
    const vault = await vaultMode();
    const db = openDatabase(":memory:");
    const pending = startPending(db, { pluginID: "granola", account: "owner", scopes: [], capabilities: [] });
    const row = completeConnect(db, pending.id, {}, "mcp.example.com");
    expect(row.token_ref).toBeNull();
    expect(vault.list("plugin-token/")).toEqual([]);
    expect(readConnectionTokens(row)).toEqual({});
    db.close();
  });

  test("with the vault locked a save is refused and nothing is written in plaintext", async () => {
    await vaultMode();
    const db = openDatabase(":memory:");
    const pending = startPending(db, { pluginID: "calendar", account: "agent", scopes: ["s"], capabilities: [] });
    lockVault();
    expect(() => completeConnect(db, pending.id, { access_token: ACCESS }, "me")).toThrow(VaultError);
    expect(databaseText(db)).not.toContain(ACCESS);
    expect(getConnection(db, pending.id)!.status).toBe("pending");
    db.close();
  });
});

describe("file mode with the vault open (a migration that stopped part way)", () => {
  test("a row already moved to the vault still reads its tokens", async () => {
    const home = mkdtempSync(join(tmpdir(), "agni-credstore-"));
    roots.push(home);
    const vault = await unlockVault({ home, create: true }); // mode stays file
    const db = openDatabase(":memory:");
    const pending = startPending(db, { pluginID: "calendar", account: "agent", scopes: ["s"], capabilities: [] });
    vault.set(`plugin-token/${pending.id}`, JSON.stringify({ access_token: ACCESS }));
    db.run("UPDATE plugin_connections SET tokens = NULL, token_ref = ? WHERE id = ?", [`plugin-token/${pending.id}`, pending.id]);
    expect(readConnectionTokens(getConnection(db, pending.id)!)).toEqual({ access_token: ACCESS });
    db.close();
  });
});

describe("the store's SQL", () => {
  test("no SQL in the store uses LIKE", async () => {
    const source = await Bun.file(join(import.meta.dir, "../src/plugins/store.ts")).text();
    // The operator followed by a parameter or a literal; the word may appear in a comment.
    expect(/\bLIKE\s+[?'"]/i.test(source)).toBe(false);
  });
});
