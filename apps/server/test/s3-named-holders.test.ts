/**
 * Every registration of a secret names its holder (Sprint 3 fix round). The anonymous holder
 * (`registerSecret`) is one shared hold that anything can let go of, so a secret registered that way is
 * unmasked by an unrelated cleanup. These tests let go of the anonymous hold (`unregisterSecret`) and
 * check the value is still masked: it is held under a name.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintToken, verifyToken } from "../src/auth/tokens";
import { migrateChatgptAccounts, migratePluginTokens } from "../src/credentials/migrators";
import { openDatabase } from "../src/db";
import { lockVault, unlockVault } from "../src/secrets";
import { redact } from "../src/util/redact";
import { clearSecretsForTests, unregisterSecret } from "../src/util/redact-core";

const heldByName = (value: string): boolean => {
  unregisterSecret(value);
  return redact(`before ${value} after`) === "before [redacted] after";
};

let home = "";
const savedHome = process.env.AGNI_HOME;
const savedDb = process.env.AGNI_DB_PATH;
beforeEach(() => {
  lockVault();
  home = mkdtempSync(join(tmpdir(), "agni-holders-"));
  process.env.AGNI_HOME = home;
  delete process.env.AGNI_DB_PATH;
});
afterEach(() => {
  lockVault();
  if (savedHome === undefined) delete process.env.AGNI_HOME;
  else process.env.AGNI_HOME = savedHome;
  if (savedDb === undefined) delete process.env.AGNI_DB_PATH;
  else process.env.AGNI_DB_PATH = savedDb;
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("pairing tokens", () => {
  test("a minted token is held under its device, not anonymously", async () => {
    const db = openDatabase(":memory:");
    try {
      const { token } = await mintToken(db, "phone");
      expect(heldByName(token)).toBe(true);
    } finally {
      db.close();
    }
  });

  test("a token seen again at verification is held under its device, not anonymously", async () => {
    const db = openDatabase(":memory:");
    try {
      const { token } = await mintToken(db, "phone");
      clearSecretsForTests(); // a restart: the token is only in the database, as a hash
      expect(await verifyToken(db, token)).not.toBeNull();
      expect(heldByName(token)).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe("the migrators", () => {
  const context = () => ({ home, backupDir: join(home, "data", "backups") });

  test("the tokens inside a connection's blob are held under the migration, not anonymously", async () => {
    const db = openDatabase(":memory:");
    try {
      db.run(
        "INSERT INTO plugin_connections (id, plugin_id, account, status, account_label, scopes, capabilities, tokens, error, grant_started_at, connected_at, updated_at) VALUES ('plc_h', 'calendar', 'agent', 'connected', 'me', '[]', '[]', ?, NULL, 'now', 'now', 'now')",
        [JSON.stringify({ access_token: "ya29.holder-access-0000000001", refresh_token: "1//holder-refresh-0000000002" })],
      );
      const vault = await unlockVault({ home, create: true });
      expect(migratePluginTokens(vault, { ...context(), db })).toBe(1);
      expect(heldByName("ya29.holder-access-0000000001")).toBe(true);
      expect(heldByName("1//holder-refresh-0000000002")).toBe(true);
    } finally {
      db.close();
    }
  });

  test("the tokens of a ChatGPT account are held under the migration, not anonymously", async () => {
    mkdirSync(join(home, "data", "chatgpt"), { recursive: true });
    writeFileSync(
      join(home, "data", "chatgpt", "accounts.json"),
      JSON.stringify({ version: 1, accounts: [{ id: "acc1", tokens: { accessToken: "chat-access-000000000003", refreshToken: "chat-refresh-000000000004", idToken: "chat-id-token-0000000005" } }] }),
    );
    const vault = await unlockVault({ home, create: true });
    expect(migrateChatgptAccounts(vault, context())).toBe(1);
    for (const value of ["chat-access-000000000003", "chat-refresh-000000000004", "chat-id-token-0000000005"]) expect(heldByName(value)).toBe(true);
  });
});
