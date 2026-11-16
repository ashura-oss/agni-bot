/**
 * What the stores do with the redaction registry when a credential is replaced, disconnected,
 * or a save fails (the Sprint 3 fix round): a replaced or disconnected credential stays masked
 * until its own expiry has passed (a revoke, confirmed or not, unmasks nothing: it does not kill an
 * access token already issued), a failed write keeps every old value masked, and a store lets go
 * only after its write succeeded.
 *
 * Each store is driven through its own public path. Throwaway homes, in-memory keystore, no
 * network (a fake token and revoke endpoint).
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db";
import { ChatGPTAuth } from "../src/models/chatgpt-auth";
import { emptyPluginsFile, savePluginsFile, type PluginsFile } from "../src/plugins/config";
import { PluginService } from "../src/plugins/service";
import { completeConnect, deleteConnection, getConnectionFor, startPending, updateTokens } from "../src/plugins/store";
import type { Config } from "../src/config";
import { lockVault, unlockVault } from "../src/secrets";
import { RETIRED_PER_SLOT, redact } from "../src/util/redact";

const HOUR = 3_600_000;
const masked = (value: string): boolean => redact(`before ${value} after`) === "before [redacted] after";

let home = "";
let savedMode: string | undefined;
beforeEach(() => {
  savedMode = process.env.AGNI_SECRETS_MODE;
  delete process.env.AGNI_SECRETS_MODE;
  lockVault();
  home = mkdtempSync(join(tmpdir(), "agni-lifecycle-"));
});
afterEach(() => {
  setSystemTime();
  lockVault();
  if (savedMode === undefined) delete process.env.AGNI_SECRETS_MODE;
  else process.env.AGNI_SECRETS_MODE = savedMode;
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** Vault mode with the vault then locked: every save is refused, and the old values stay where they were. */
async function lockedVaultMode(): Promise<void> {
  await unlockVault({ home, create: true });
  process.env.AGNI_SECRETS_MODE = "vault";
  lockVault();
}

// --- plugin connections (the database rows) ---------------------------------------------

describe("plugin connection tokens", () => {
  const blob = (i: number, expiresAt?: number) => ({
    access_token: `conn-access-${i}-zzzzzzzz`,
    refresh_token: `conn-refresh-${i}-zzzzzzzz`,
    ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
  });

  test("a replaced access token and refresh token stay masked", () => {
    const db = openDatabase(":memory:");
    try {
      const row = startPending(db, { pluginID: "gmail", account: "agent", scopes: [], capabilities: {} });
      completeConnect(db, row.id, blob(1), "a@example.com");
      updateTokens(db, row.id, blob(2));
      for (const value of [blob(1).access_token, blob(1).refresh_token, blob(2).access_token, blob(2).refresh_token]) expect(masked(value)).toBe(true);
    } finally {
      db.close();
    }
  });

  test("a replaced access token is let go at its expiry, the refresh token (no known expiry) is not", () => {
    const db = openDatabase(":memory:");
    const now = Date.now();
    try {
      const row = startPending(db, { pluginID: "gmail", account: "agent", scopes: [], capabilities: {} });
      completeConnect(db, row.id, blob(1, now + HOUR), "a@example.com");
      updateTokens(db, row.id, blob(2, now + 2 * HOUR));
      expect(masked(blob(1).access_token)).toBe(true);
      setSystemTime(new Date(now + HOUR + 1));
      expect(masked(blob(1).access_token)).toBe(false);
      expect(masked(blob(1).refresh_token)).toBe(true);
      expect(masked(blob(2).access_token)).toBe(true);
    } finally {
      db.close();
    }
  });

  test("deleting a connection keeps its tokens masked", () => {
    const db = openDatabase(":memory:");
    try {
      const row = startPending(db, { pluginID: "gmail", account: "agent", scopes: [], capabilities: {} });
      completeConnect(db, row.id, blob(1), "a@example.com");
      deleteConnection(db, row.id);
      expect(masked(blob(1).access_token)).toBe(true);
      expect(masked(blob(1).refresh_token)).toBe(true);
    } finally {
      db.close();
    }
  });

  test("a connection that goes pending again keeps its old tokens masked", () => {
    const db = openDatabase(":memory:");
    try {
      const row = startPending(db, { pluginID: "gmail", account: "agent", scopes: [], capabilities: {} });
      completeConnect(db, row.id, blob(1), "a@example.com");
      startPending(db, { pluginID: "gmail", account: "agent", scopes: [], capabilities: {} });
      expect(masked(blob(1).access_token)).toBe(true);
      expect(masked(blob(1).refresh_token)).toBe(true);
    } finally {
      db.close();
    }
  });

  test("a write that fails keeps every old value masked, even with the queue full", () => {
    const db = openDatabase(":memory:");
    try {
      const row = startPending(db, { pluginID: "gmail", account: "agent", scopes: [], capabilities: {} });
      completeConnect(db, row.id, blob(0), "a@example.com");
      // Replace until the slot's queue is full: the oldest queued values are the ones a careless release would push out.
      const rounds = 1 + Math.ceil(RETIRED_PER_SLOT / 2);
      for (let i = 1; i <= rounds; i += 1) updateTokens(db, row.id, blob(i));
      const oldest = blob(rounds - Math.ceil(RETIRED_PER_SLOT / 2));
      expect(masked(oldest.access_token)).toBe(true);
      db.run("CREATE TRIGGER refuse_update BEFORE UPDATE ON plugin_connections BEGIN SELECT RAISE(ABORT, 'refused'); END");
      expect(() => updateTokens(db, row.id, blob(99))).toThrow(/refused/);
      expect(masked(blob(rounds).access_token)).toBe(true); // what the row still holds
      expect(masked(oldest.access_token)).toBe(true); // the queue is as it was
      expect(masked(oldest.refresh_token)).toBe(true);
      expect(masked(blob(99).access_token)).toBe(true); // the new value was exposed to the provider, so it is masked too
    } finally {
      db.close();
    }
  });
});

// --- disconnecting a plugin (revoke with the provider) ---------------------------------------

describe("disconnecting an OAuth plugin", () => {
  const ACCESS = "disconnect-access-token-1111";
  const REFRESH = "disconnect-refresh-token-2222";

  /** A connected calendar plugin, and a fake provider whose revoke answer the test chooses. */
  async function connected(revoke: () => Response) {
    const db = openDatabase(":memory:");
    const pluginsPath = join(home, "plugins.json");
    writeFileSync(pluginsPath, JSON.stringify({ version: 1, oauthClients: { google: { clientID: "cid", clientSecret: "csecret" } }, plugins: {} }));
    const service = new PluginService({ config: { host: "127.0.0.1", port: 8787 } as Config, db, emit: () => {}, pluginsPath, now: () => Date.now() });
    service.fetchOverride = (async (url: string | URL | Request) => {
      if (String(url).includes("/revoke")) return revoke();
      if (String(url).includes("/token")) return Response.json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 });
      return Response.json({ email: "agni@example.test" });
    }) as typeof fetch;
    const state = new URL(service.connect("calendar", "agent").authorizeURL!).searchParams.get("state")!;
    expect((await service.completeSignIn(state, "code-1")).plugin).toBe("calendar");
    return { service, db, id: getConnectionFor(db, "calendar", "agent")!.id };
  }

  test("a revoke the provider refused keeps both tokens masked", async () => {
    const { service, db, id } = await connected(() => new Response("no", { status: 400 }));
    try {
      expect((await service.disconnect(id)).error).toBeUndefined();
      expect(masked(ACCESS)).toBe(true);
      expect(masked(REFRESH)).toBe(true);
    } finally {
      db.close();
    }
  });

  test("a revoke that could not be sent keeps both tokens masked", async () => {
    const { service, db, id } = await connected(() => {
      throw new Error("network down");
    });
    try {
      expect((await service.disconnect(id)).error).toBeUndefined();
      expect(masked(ACCESS)).toBe(true);
      expect(masked(REFRESH)).toBe(true);
    } finally {
      db.close();
    }
  });

  test("a confirmed revoke of the refresh token keeps every token of the row masked until its own expiry", async () => {
    const { service, db, id } = await connected(() => new Response("{}", { status: 200 }));
    try {
      expect((await service.disconnect(id)).error).toBeUndefined();
      // The revoke named the refresh token: an access token already issued stays valid until it expires.
      expect(masked(ACCESS)).toBe(true);
      expect(masked(REFRESH)).toBe(true);
      setSystemTime(new Date(Date.now() + 2 * HOUR));
      expect(masked(ACCESS)).toBe(false); // its own expiry has passed
      expect(masked(REFRESH)).toBe(true); // no known expiry: only the queue's age lets it go
    } finally {
      db.close();
    }
  });

  test("after a refused revoke the access token is let go at its expiry, the refresh token is not", async () => {
    const { service, db, id } = await connected(() => new Response("no", { status: 400 }));
    try {
      await service.disconnect(id);
      setSystemTime(new Date(Date.now() + 2 * HOUR));
      expect(masked(ACCESS)).toBe(false);
      expect(masked(REFRESH)).toBe(true);
    } finally {
      db.close();
    }
  });
});

// --- plugins.json ------------------------------------------------------------------------

describe("plugins.json", () => {
  const config = (i: number): PluginsFile => {
    const file = emptyPluginsFile();
    file.plugins["google-calendar"] = {
      account: "agent",
      enabled: true,
      auth: { kind: "oauth", access_token: `ya29.file-access-${i}-zzzz`, refresh_token: `1//file-refresh-${i}-zzzz`, expires_at: Date.now() + HOUR },
    };
    return file;
  };

  test("a replaced token stays masked", () => {
    const path = join(home, "plugins.json");
    savePluginsFile(path, config(1));
    savePluginsFile(path, config(2));
    expect(masked("ya29.file-access-1-zzzz")).toBe(true);
    expect(masked("1//file-refresh-1-zzzz")).toBe(true);
    expect(masked("ya29.file-access-2-zzzz")).toBe(true);
  });

  test("a save that fails keeps the old values masked, and the new ones", async () => {
    const path = join(home, "plugins.json");
    await unlockVault({ home, create: true });
    process.env.AGNI_SECRETS_MODE = "vault";
    savePluginsFile(path, config(1));
    lockVault(); // vault mode, vault locked: the next save is refused
    expect(() => savePluginsFile(path, config(2))).toThrow();
    expect(masked("ya29.file-access-1-zzzz")).toBe(true);
    expect(masked("1//file-refresh-1-zzzz")).toBe(true);
    expect(masked("ya29.file-access-2-zzzz")).toBe(true);
  });

  test("a save that fails leaves the queue of replaced values as it was, even when it is full", async () => {
    const path = join(home, "plugins.json");
    await unlockVault({ home, create: true });
    process.env.AGNI_SECRETS_MODE = "vault";
    const rounds = RETIRED_PER_SLOT + 3;
    for (let i = 1; i <= rounds; i += 1) savePluginsFile(path, config(i));
    const oldest = rounds - RETIRED_PER_SLOT; // the oldest value the full queue still holds
    expect(masked(`ya29.file-access-${oldest}-zzzz`)).toBe(true);
    expect(masked(`ya29.file-access-${oldest - 1}-zzzz`)).toBe(false);
    lockVault();
    expect(() => savePluginsFile(path, config(rounds + 1))).toThrow();
    expect(masked(`ya29.file-access-${oldest}-zzzz`)).toBe(true); // a release that ran before the write would have pushed it out
    expect(masked(`ya29.file-access-${rounds}-zzzz`)).toBe(true);
    expect(masked(`ya29.file-access-${rounds + 1}-zzzz`)).toBe(true);
  });
});

// --- the ChatGPT accounts ----------------------------------------------------------------

describe("ChatGPT accounts", () => {
  const OLD_ACCESS = "chatgpt-lifecycle-access-old-1";
  const OLD_REFRESH = "chatgpt-lifecycle-refresh-old-1";
  const OLD_ID = "chatgpt-lifecycle-id-token-1";
  const NEW_ACCESS = "chatgpt-lifecycle-access-new-2";
  const NEW_REFRESH = "chatgpt-lifecycle-refresh-new-2";

  function seed(expiresAt: number): string {
    const path = join(home, "data", "chatgpt", "accounts.json");
    mkdirSync(join(home, "data", "chatgpt"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        hostID: "urn:uuid:11111111-2222-3333-4444-555555555555",
        activeID: "acc1",
        accounts: [
          {
            id: "acc1", clientID: "client-1", subject: "sub-1", email: "owner@example.test", model: "m1",
            models: [{ id: "m1", label: "Model one", vision: false }],
            tokens: { accessToken: OLD_ACCESS, refreshToken: OLD_REFRESH, idToken: OLD_ID, expiresAt, earliestRefreshAt: 0, scopes: ["resource.invoke", "chatgpt.tokens.use.direct"] },
            needsLogin: false, permissionDisabled: false, welcomed: false,
          },
        ],
      }),
    );
    return path;
  }

  function open(path: string, answer: (url: string) => Response): ChatGPTAuth {
    const fetchFn = (async (url: string | URL | Request) => answer(String(url))) as unknown as typeof fetch;
    return new ChatGPTAuth({ filePath: path, fetchFn });
  }

  const refreshed = (): Response =>
    new Response(JSON.stringify({ access_token: NEW_ACCESS, refresh_token: NEW_REFRESH, token_type: "bearer", expires_in: 3600, scope: "resource.invoke chatgpt.tokens.use.direct" }), {
      headers: { "content-type": "application/json" },
    });

  // A token inside the 60 s refresh window is still valid, but is renewed on the next use.
  const dueForRefresh = (): number => Date.now() + 30_000;

  test("a refresh keeps the replaced access and refresh tokens masked", async () => {
    const auth = open(seed(dueForRefresh()), () => refreshed());
    try {
      expect(await auth.accessToken()).toBe(NEW_ACCESS);
      for (const value of [OLD_ACCESS, OLD_REFRESH, NEW_ACCESS, NEW_REFRESH]) expect(masked(value)).toBe(true);
    } finally {
      auth.stop();
    }
  });

  test("a refresh whose save fails keeps the old tokens masked, and the new ones", async () => {
    const path = seed(dueForRefresh());
    await lockedVaultMode();
    const auth = open(path, () => refreshed());
    try {
      await expect(auth.accessToken()).rejects.toThrow();
      for (const value of [OLD_ACCESS, OLD_REFRESH, NEW_ACCESS, NEW_REFRESH]) expect(masked(value)).toBe(true);
    } finally {
      auth.stop();
    }
  });

  test("a refresh whose save fails leaves the queue of replaced tokens as it was, even when it is full", async () => {
    let clock = Date.now();
    let round = 0;
    const path = seed(clock + 30_000);
    const auth = new ChatGPTAuth({
      filePath: path,
      now: () => clock,
      fetchFn: (async () => {
        round += 1;
        return new Response(
          JSON.stringify({ access_token: `chatgpt-lifecycle-access-r${round}-zz`, refresh_token: `chatgpt-lifecycle-refresh-r${round}-zz`, token_type: "bearer", expires_in: 3600, scope: "resource.invoke chatgpt.tokens.use.direct" }),
          { headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    });
    try {
      // Each refresh replaces an access and a refresh token, so this fills the queue.
      const rounds = RETIRED_PER_SLOT / 2 + 3;
      for (let i = 1; i <= rounds; i += 1) {
        clock += 2 * HOUR;
        await auth.accessToken();
      }
      const oldest = `chatgpt-lifecycle-access-r${rounds - RETIRED_PER_SLOT / 2}-zz`; // the oldest access token the full queue still holds
      expect(masked(oldest)).toBe(true);
      expect(masked(`chatgpt-lifecycle-access-r${rounds - RETIRED_PER_SLOT / 2 - 1}-zz`)).toBe(false);
      await unlockVault({ home, create: true });
      process.env.AGNI_SECRETS_MODE = "vault";
      lockVault(); // the next save is refused
      clock += 2 * HOUR;
      await expect(auth.accessToken()).rejects.toThrow();
      expect(masked(oldest)).toBe(true); // a release that ran before the write would have pushed it out
      expect(masked(`chatgpt-lifecycle-access-r${rounds}-zz`)).toBe(true);
      expect(masked(`chatgpt-lifecycle-access-r${rounds + 1}-zz`)).toBe(true);
    } finally {
      auth.stop();
    }
  });

  test("a disconnect whose revoke is refused keeps the access and refresh tokens masked", async () => {
    const auth = open(seed(Date.now() + HOUR), () => new Response("no", { status: 400 }));
    try {
      await auth.disconnect("acc1");
      expect(masked(OLD_ACCESS)).toBe(true);
      expect(masked(OLD_REFRESH)).toBe(true);
    } finally {
      auth.stop();
    }
  });

  test("a disconnect whose revoke could not be sent keeps them masked too", async () => {
    const auth = open(seed(Date.now() + HOUR), () => {
      throw new Error("network down");
    });
    try {
      await auth.disconnect("acc1");
      expect(masked(OLD_ACCESS)).toBe(true);
      expect(masked(OLD_REFRESH)).toBe(true);
    } finally {
      auth.stop();
    }
  });

  test("a confirmed revoke of the refresh token keeps the access token masked until it expires", async () => {
    const expiresAt = Date.now() + HOUR;
    const auth = open(seed(expiresAt), () => new Response("{}", { status: 200 }));
    try {
      await auth.disconnect("acc1");
      // The revoke named the refresh token: the access token already issued stays valid until it expires.
      for (const value of [OLD_ACCESS, OLD_REFRESH, OLD_ID]) expect(masked(value)).toBe(true);
      setSystemTime(new Date(expiresAt + 1));
      expect(masked(OLD_ACCESS)).toBe(false); // its own expiry has passed
      expect(masked(OLD_REFRESH)).toBe(true); // no known expiry: only the queue's age lets it go
      expect(masked(OLD_ID)).toBe(true);
    } finally {
      auth.stop();
    }
  });

  test("after a refused revoke the access token is let go at its expiry, the refresh token is not", async () => {
    const expiresAt = Date.now() + HOUR;
    const auth = open(seed(expiresAt), () => new Response("no", { status: 400 }));
    try {
      await auth.disconnect("acc1");
      setSystemTime(new Date(expiresAt + 1));
      expect(masked(OLD_ACCESS)).toBe(false);
      expect(masked(OLD_REFRESH)).toBe(true);
    } finally {
      auth.stop();
    }
  });
});
