/**
 * A refreshed access token is stored with its own expiry, not the expiry of the token it replaced
 * (Sprint 3 fix round). Otherwise the token is masked only until the old expiry, and unmasked while it
 * still works, and every later call sees an expired token and refreshes again.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config";
import { openDatabase } from "../src/db";
import { pluginAccessToken } from "../src/plugins/credentials";
import { PluginService } from "../src/plugins/service";
import { redact } from "../src/util/redact";

const masked = (value: string): boolean => redact(`before ${value} after`) === "before [redacted] after";
const HOUR = 3_600_000;

let home = "";
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agni-refreshexp-"));
});
afterEach(() => {
  setSystemTime();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("accessTokenFor", () => {
  test("a refreshed token is stored with its own expiry, and the token it replaced stays masked until that expiry", async () => {
    const start = Date.now();
    const pluginsPath = join(home, "plugins.json");
    writeFileSync(
      pluginsPath,
      JSON.stringify({
        version: 1,
        oauthClients: { google: { clientID: "cid", clientSecret: "csecret" } },
        plugins: {
          calendar: { account: "agent", enabled: true, auth: { kind: "oauth", access_token: "stored-access-A-0000000", refresh_token: "stored-refresh-R-000000", expires_at: start + 30_000 } },
        },
      }),
    );
    const issued = ["fresh-access-B-00000000", "fresh-access-C-00000000"];
    const db = openDatabase(":memory:");
    try {
      const service = new PluginService({ config: { host: "127.0.0.1", port: 8787 } as Config, db, emit: () => {}, pluginsPath, now: () => Date.now() });
      service.fetchOverride = (async () => Response.json({ access_token: issued.shift(), expires_in: 3600 })) as unknown as typeof fetch;

      // A is about to expire: the call refreshes and gets B, valid for an hour.
      expect(await service.accessTokenFor("calendar", "agent")).toBe("fresh-access-B-00000000");
      const stored = JSON.parse(readFileSync(pluginsPath, "utf8")).plugins.calendar.auth as { expires_at: number };
      expect(stored.expires_at).toBeGreaterThan(start + HOUR - 5_000);

      // B is about to expire in its turn (an hour on): the call refreshes again and gets C.
      setSystemTime(new Date(start + HOUR - 30_000));
      expect(await service.accessTokenFor("calendar", "agent")).toBe("fresh-access-C-00000000");
      // B is replaced but still works for 30 more seconds: it is still masked.
      expect(masked("fresh-access-B-00000000")).toBe(true);
      setSystemTime(new Date(start + HOUR + 60_000));
      expect(masked("fresh-access-B-00000000")).toBe(false); // its own expiry has passed
      expect(masked("fresh-access-C-00000000")).toBe(true);
    } finally {
      db.close();
    }
  });

  test("a token that is still valid is returned as it is, without a refresh", async () => {
    const pluginsPath = join(home, "plugins.json");
    writeFileSync(
      pluginsPath,
      JSON.stringify({
        version: 1,
        oauthClients: { google: { clientID: "cid", clientSecret: "csecret" } },
        plugins: { calendar: { account: "agent", enabled: true, auth: { kind: "oauth", access_token: "stored-access-A-0000000", refresh_token: "stored-refresh-R-000000", expires_at: Date.now() + HOUR } } },
      }),
    );
    const db = openDatabase(":memory:");
    try {
      const service = new PluginService({ config: { host: "127.0.0.1", port: 8787 } as Config, db, emit: () => {}, pluginsPath, now: () => Date.now() });
      service.fetchOverride = (async () => {
        throw new Error("no network call expected");
      }) as unknown as typeof fetch;
      expect(await service.accessTokenFor("calendar", "agent")).toBe("stored-access-A-0000000");
    } finally {
      db.close();
    }
  });
});

describe("a refresh answer without every field", () => {
  const plugins = (auth: Record<string, unknown>): string =>
    JSON.stringify({ version: 1, oauthClients: { google: { clientID: "cid", clientSecret: "csecret" } }, plugins: { calendar: { account: "agent", enabled: true, auth: { kind: "oauth", ...auth } } } });

  test("no expires_in: a conservative one-hour expiry is stored, so the next call does not refresh again", async () => {
    const pluginsPath = join(home, "plugins.json");
    writeFileSync(pluginsPath, plugins({ access_token: "stored-access-A-0000000", refresh_token: "stored-refresh-R-000000", expires_at: Date.now() - 1_000 }));
    const db = openDatabase(":memory:");
    try {
      const service = new PluginService({ config: { host: "127.0.0.1", port: 8787 } as Config, db, emit: () => {}, pluginsPath, now: () => Date.now() });
      let refreshes = 0;
      service.fetchOverride = (async () => {
        refreshes += 1;
        return Response.json({ access_token: "fresh-access-B-00000000" }); // no expires_in
      }) as unknown as typeof fetch;
      const before = Date.now();
      expect(await service.accessTokenFor("calendar", "agent")).toBe("fresh-access-B-00000000");
      const stored = JSON.parse(readFileSync(pluginsPath, "utf8")).plugins.calendar.auth as { expires_at?: number };
      expect(stored.expires_at).toBeGreaterThanOrEqual(before + HOUR - 5_000);
      expect(stored.expires_at).toBeLessThanOrEqual(Date.now() + HOUR + 5_000);
      expect(await service.accessTokenFor("calendar", "agent")).toBe("fresh-access-B-00000000");
      expect(refreshes).toBe(1);
    } finally {
      db.close();
    }
  });

  test("a rotated refresh_token is stored, and the one it replaced stays masked", async () => {
    const pluginsPath = join(home, "plugins.json");
    writeFileSync(pluginsPath, plugins({ access_token: "stored-access-A-0000000", refresh_token: "stored-refresh-R-000000", expires_at: Date.now() - 1_000 }));
    const db = openDatabase(":memory:");
    try {
      const service = new PluginService({ config: { host: "127.0.0.1", port: 8787 } as Config, db, emit: () => {}, pluginsPath, now: () => Date.now() });
      service.fetchOverride = (async () => Response.json({ access_token: "fresh-access-B-00000000", expires_in: 3600, refresh_token: "rotated-refresh-R2-00000" })) as unknown as typeof fetch;
      await service.accessTokenFor("calendar", "agent");
      const stored = JSON.parse(readFileSync(pluginsPath, "utf8")).plugins.calendar.auth as { refresh_token?: string };
      expect(stored.refresh_token).toBe("rotated-refresh-R2-00000");
      expect(masked("rotated-refresh-R2-00000")).toBe(true);
      expect(masked("stored-refresh-R-000000")).toBe(true); // retired to the queue, not released
    } finally {
      db.close();
    }
  });

  test("a refresh that names no new refresh_token keeps the one it has", async () => {
    const pluginsPath = join(home, "plugins.json");
    writeFileSync(pluginsPath, plugins({ access_token: "stored-access-A-0000000", refresh_token: "stored-refresh-R-000000", expires_at: Date.now() - 1_000 }));
    const db = openDatabase(":memory:");
    try {
      const service = new PluginService({ config: { host: "127.0.0.1", port: 8787 } as Config, db, emit: () => {}, pluginsPath, now: () => Date.now() });
      service.fetchOverride = (async () => Response.json({ access_token: "fresh-access-B-00000000", expires_in: 3600 })) as unknown as typeof fetch;
      await service.accessTokenFor("calendar", "agent");
      expect((JSON.parse(readFileSync(pluginsPath, "utf8")).plugins.calendar.auth as { refresh_token?: string }).refresh_token).toBe("stored-refresh-R-000000");
    } finally {
      db.close();
    }
  });
});

describe("pluginAccessToken (the tools' path)", () => {
  test("stores a one-hour expiry when the answer has none, and a rotated refresh_token", async () => {
    const pluginsPath = join(home, "plugins.json");
    writeFileSync(
      pluginsPath,
      JSON.stringify({ version: 1, oauthClients: { google: { clientID: "cid", clientSecret: "csecret" } }, plugins: { calendar: { account: "agent", enabled: true, auth: { kind: "oauth", access_token: "stored-access-A-0000000", refresh_token: "stored-refresh-R-000000", expires_at: Date.now() - 1_000 } } } }),
    );
    let refreshes = 0;
    const answer = (async () => {
      refreshes += 1;
      return Response.json({ access_token: "fresh-access-B-00000000", refresh_token: "rotated-refresh-R2-00000" });
    }) as unknown as typeof fetch;
    const before = Date.now();
    expect(await pluginAccessToken(pluginsPath, "calendar", answer)).toBe("fresh-access-B-00000000");
    const stored = JSON.parse(readFileSync(pluginsPath, "utf8")).plugins.calendar.auth as { expires_at?: number; refresh_token?: string };
    expect(stored.refresh_token).toBe("rotated-refresh-R2-00000");
    expect(stored.expires_at).toBeGreaterThanOrEqual(before + HOUR - 5_000);
    expect(await pluginAccessToken(pluginsPath, "calendar", answer)).toBe("fresh-access-B-00000000");
    expect(refreshes).toBe(1);
  });
});
