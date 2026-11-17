/**
 * S3-02: the ChatGPT accounts store. File mode keeps `chatgpt/accounts.json`;
 * vault mode keeps the same JSON as one vault entry (`chatgpt/accounts`) and
 * never writes the file. A plaintext file still on disk in vault mode is used
 * once and removed at the first save. No network: the accounts are seeded.
 * Throwaway home, in-memory keystore.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redact } from "../src/util/redact";
import { clearSecretsForTests } from "../src/util/redact-core";

import { ChatGPTAuth } from "../src/models/chatgpt-auth";
import { lockVault, unlockVault, type Vault } from "../src/secrets";

const ACCESS = "canary-chatgpt-access-token-aaaa1111";
const REFRESH = "canary-chatgpt-refresh-token-bbbb2222";
const ID_TOKEN = "canary-chatgpt-id-token-cccc3333";

function accountsJson(access = ACCESS): string {
  return JSON.stringify({
    version: 1,
    hostID: "urn:uuid:11111111-2222-3333-4444-555555555555",
    activeID: "acc1",
    accounts: [
      {
        id: "acc1",
        clientID: "client-1",
        subject: "sub-1",
        email: "owner@example.test",
        model: "m1",
        models: [{ id: "m1", label: "Model one", vision: false }],
        tokens: { accessToken: access, refreshToken: REFRESH, idToken: ID_TOKEN, expiresAt: Date.now() + 3_600_000, earliestRefreshAt: 0, scopes: ["resource.invoke", "chatgpt.tokens.use.direct"] },
        needsLogin: false,
        permissionDisabled: false,
        welcomed: false,
      },
    ],
  });
}

let home = "";
let path = "";
let savedMode: string | undefined;
const cleanups: Array<() => void> = [];
beforeEach(() => {
  savedMode = process.env.AGNI_SECRETS_MODE;
  delete process.env.AGNI_SECRETS_MODE;
  lockVault();
  home = mkdtempSync(join(tmpdir(), "agni-chatgptvault-"));
  path = join(home, "data", "chatgpt", "accounts.json");
  mkdirSync(join(home, "data", "chatgpt"), { recursive: true });
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  lockVault();
  if (savedMode === undefined) delete process.env.AGNI_SECRETS_MODE;
  else process.env.AGNI_SECRETS_MODE = savedMode;
  rmSync(home, { recursive: true, force: true });
});

async function vaultMode(): Promise<Vault> {
  const vault = await unlockVault({ home, create: true });
  process.env.AGNI_SECRETS_MODE = "vault";
  return vault;
}

function open(): ChatGPTAuth {
  const auth = new ChatGPTAuth({ filePath: path, fetchFn: fetch });
  cleanups.push(() => auth.stop());
  return auth;
}

const filesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? filesUnder(join(dir, name)) : [join(dir, name)]));
const filesContaining = (needle: string): string[] => filesUnder(home).filter((file) => readFileSync(file).includes(needle));

describe("file mode", () => {
  test("reads and writes accounts.json as before", async () => {
    writeFileSync(path, accountsJson());
    const auth = open();
    expect(await auth.accessToken()).toBe(ACCESS);
    await auth.acknowledge("acc1");
    expect(JSON.parse(readFileSync(path, "utf8")).accounts[0].welcomed).toBe(true);
  });
});

describe("file mode with the vault open (a migration that stopped part way)", () => {
  test("accounts the migration already moved are read from the vault when there is no file", async () => {
    const vault = await unlockVault({ home, create: true }); // mode stays file
    vault.set("chatgpt/accounts", accountsJson());
    expect(await open().accessToken()).toBe(ACCESS);
  });

  test("a file that is there is newer than a stale vault entry and wins", async () => {
    const vault = await unlockVault({ home, create: true });
    vault.set("chatgpt/accounts", accountsJson("canary-chatgpt-stale-access-9999"));
    writeFileSync(path, accountsJson());
    expect(await open().accessToken()).toBe(ACCESS);
  });
});

describe("vault mode", () => {
  test("accounts are read from the vault entry", async () => {
    const vault = await vaultMode();
    vault.set("chatgpt/accounts", accountsJson());
    const auth = open();
    expect(await auth.accessToken()).toBe(ACCESS);
    expect(auth.provider()?.id).toBe("chatgpt");
  });

  test("a change is saved to the vault and the file is never created", async () => {
    const vault = await vaultMode();
    vault.set("chatgpt/accounts", accountsJson());
    const auth = open();
    await auth.acknowledge("acc1");
    expect(JSON.parse(vault.get("chatgpt/accounts")!).accounts[0].welcomed).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(filesContaining(ACCESS)).toEqual([]);
    expect(filesContaining(REFRESH)).toEqual([]);
  });

  test("the tokens are registered for redaction when loaded and when saved", async () => {
    const vault = await vaultMode();
    vault.set("chatgpt/accounts", accountsJson());
    clearSecretsForTests();
    const auth = open();
    for (const token of [ACCESS, REFRESH, ID_TOKEN]) expect(redact(token)).toBe("[redacted]");
    clearSecretsForTests();
    await auth.acknowledge("acc1");
    for (const token of [ACCESS, REFRESH, ID_TOKEN]) expect(redact(token)).toBe("[redacted]");
  });

  test("a plaintext file left over is used, then moved into the vault and removed at the first save", async () => {
    const vault = await vaultMode();
    writeFileSync(path, accountsJson());
    const auth = open();
    expect(await auth.accessToken()).toBe(ACCESS);
    expect(vault.has("chatgpt/accounts")).toBe(false);
    await auth.acknowledge("acc1");
    expect(vault.has("chatgpt/accounts")).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(filesContaining(ACCESS)).toEqual([]);
  });

  test("with the vault locked a save is refused and the plaintext file is left exactly as it was", async () => {
    await vaultMode();
    const stored = accountsJson();
    writeFileSync(path, stored);
    lockVault();
    const auth = open();
    expect(await auth.accessToken()).toBe(ACCESS);
    await expect(auth.acknowledge("acc1")).rejects.toThrow();
    expect(readFileSync(path, "utf8")).toBe(stored);
  });

  test("an entry that is not valid JSON is not overwritten", async () => {
    const vault = await vaultMode();
    vault.set("chatgpt/accounts", "{ not json");
    const savedFlag = process.env.AGNI_CHATGPT;
    process.env.AGNI_CHATGPT = "1";
    cleanups.push(() => {
      if (savedFlag === undefined) delete process.env.AGNI_CHATGPT;
      else process.env.AGNI_CHATGPT = savedFlag;
    });
    const auth = open();
    expect(auth.state().status).not.toBe("connected");
    await expect(auth.start("device")).rejects.toThrow(/could not be read/);
    expect(vault.get("chatgpt/accounts")).toBe("{ not json");
  });
});
