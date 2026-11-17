/**
 * S3-02 end to end, in real child processes: `agni vault migrate` over a fixture
 * home that holds a credential in every old store, `serve` reading each of them
 * from the vault, a plaintext scan of every byte under the home, and
 * `agni vault export --yes` putting everything back.
 *
 * Throwaway AGNI_HOME under the OS temp folder, the passphrase keystore (no real
 * credential store is touched), no model is called and no real service is
 * reached: the plugins in the fixture are ones that connect without the network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanChildEnv } from "./child-env";
import { openDatabase } from "../src/db";

const ENTRY = resolve(import.meta.dir, "../src/index.ts");
const PASSPHRASE = "correct horse battery staple";
const C = {
  groq: "gsk_e2e_canary_groq_key_000001",
  custom: "sk-e2e-canary-custom-key_000002",
  urlPass: "e2e-canary-url-password-000003",
  mailPass: "e2e-canary-mail-password-000004",
  fcKey: "fc-e2e-canary-firecrawl-key-000005",
  access: "ya29.e2e-canary-plugin-access-000006",
  refresh: "1//e2e-canary-plugin-refresh-000007",
  clientSecret: "GOCSPX-e2e-canary-client-000008",
  dbAccess: "ya29.e2e-canary-db-access-000009",
  dbRefresh: "1//e2e-canary-db-refresh-000010",
  chat: "e2e-canary-chatgpt-access-000011",
};

let roots: string[] = [];
const children = new Set<ReturnType<typeof Bun.spawn>>();
afterEach(async () => {
  for (const child of children) child.kill();
  await Promise.all([...children].map((child) => child.exited));
  children.clear();
  for (const dir of roots) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  roots = [];
});

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = server.port as number;
  await server.stop(true);
  return port;
}

function childEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  return cleanChildEnv({ AGNI_HOME: home, AGNI_KEYSTORE: "passphrase", AGNI_VAULT_PASSPHRASE_FILE: join(home, "..", "pp.txt"), ...extra });
}

async function agni(home: string, args: string[]): Promise<{ code: number; out: string }> {
  const child = Bun.spawn([process.execPath, ENTRY, ...args], { cwd: tmpdir(), env: childEnv(home), stdout: "pipe", stderr: "pipe" });
  children.add(child);
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const code = await child.exited;
  children.delete(child);
  return { code, out: out + err };
}

async function serve(home: string): Promise<{ output: () => string; exited: () => boolean; port: number; stop: () => Promise<void> }> {
  const port = await freePort();
  const child = Bun.spawn([process.execPath, ENTRY, "serve"], { cwd: tmpdir(), env: childEnv(home, { AGNI_PORT: String(port) }), stdout: "pipe", stderr: "pipe" });
  children.add(child);
  let output = "";
  let exited = false;
  const read = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) output += decoder.decode(chunk);
  };
  void read(child.stdout as ReadableStream<Uint8Array>);
  void read(child.stderr as ReadableStream<Uint8Array>);
  void child.exited.then(() => { exited = true; });
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline && !exited && !/listening on/.test(output)) await Bun.sleep(100);
  if (!exited) await Bun.sleep(300);
  return { output: () => output, exited: () => exited, port, stop: async () => { child.kill(); await child.exited; children.delete(child); } };
}

const filesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? filesUnder(join(dir, name)) : [join(dir, name)]));

function hits(home: string): string[] {
  const found: string[] = [];
  for (const file of filesUnder(home)) {
    const bytes = readFileSync(file);
    for (const [name, canary] of Object.entries(C)) if (bytes.includes(canary)) found.push(`${file.slice(home.length + 1)}: ${name}`);
  }
  return found;
}

const PLUGINS = {
  version: 1,
  oauthClients: { google: { clientID: "client-id-visible", clientSecret: C.clientSecret } },
  plugins: {
    gmail: { account: "agent", enabled: true, auth: { kind: "app-password", user: "agent@example.com", pass: C.mailPass }, label: "agent@example.com" },
    firecrawl: { account: "owner", enabled: true, auth: { kind: "api-key", key: C.fcKey, url: "http://localhost:3002" } },
    "google-calendar": { account: "agent", enabled: true, auth: { kind: "oauth", access_token: C.access, refresh_token: C.refresh, expires_at: 42 } },
  },
};

function fixtureHome(): string {
  const parent = mkdtempSync(join(tmpdir(), "agni-credsE2E-"));
  roots.push(parent);
  writeFileSync(join(parent, "pp.txt"), `${PASSPHRASE}\n`);
  const home = join(parent, "home");
  mkdirSync(join(home, "data", "chatgpt"), { recursive: true });
  writeFileSync(join(home, "config.env"), `AGNI_HOST=127.0.0.1\nGROQ_API_KEY=${C.groq}\nAGNI_CUSTOM_KEY_1=${C.custom}\n`);
  writeFileSync(
    join(home, "providers.json"),
    JSON.stringify({ version: 1, models: {}, custom: [{ id: "custom", label: "Gateway", baseUrl: `https://u:${C.urlPass}@gateway.example.com/v1`, model: "m1", envKey: "AGNI_CUSTOM_KEY_1" }] }),
  );
  writeFileSync(join(home, "plugins.json"), `${JSON.stringify(PLUGINS, null, 2)}\n`);
  writeFileSync(
    join(home, "data", "chatgpt", "accounts.json"),
    JSON.stringify({ version: 1, hostID: "urn:uuid:11111111-2222-3333-4444-555555555555", activeID: null, accounts: [{ id: "a", clientID: "c", subject: "s", email: "e@x.test", model: "m", models: [], tokens: { accessToken: C.chat, refreshToken: "r", idToken: "i", expiresAt: 1, earliestRefreshAt: 0, scopes: [] }, needsLogin: false, permissionDisabled: false, welcomed: false }] }),
  );
  const db = openDatabase(join(home, "data", "agni.sqlite"));
  db.run(
    "INSERT INTO plugin_connections (id, plugin_id, account, status, account_label, scopes, capabilities, tokens, updated_at) VALUES ('plc_cal', 'calendar', 'agent', 'connected', 'me', '[]', '[]', ?, 'now')",
    [JSON.stringify({ access_token: C.dbAccess, refresh_token: C.dbRefresh, expires_at: 1 })],
  );
  db.close();
  return home;
}

describe("credentials end to end (child processes, passphrase keystore)", () => {
  test("migrate, serve from the vault, export back", async () => {
    const home = fixtureHome();
    expect(hits(home).length).toBeGreaterThan(8);

    // 1. migrate: every store reports what it moved, and not one canary is left under the home.
    const migrated = await agni(home, ["vault", "migrate"]);
    expect(migrated.out).toContain("config-env: 2 moved");
    expect(migrated.out).toContain("provider-endpoints: 1 moved");
    expect(migrated.out).toContain("plugin-secrets: 5 moved");
    expect(migrated.out).toContain("plugin-tokens: 1 moved");
    expect(migrated.out).toContain("chatgpt-accounts: 1 moved");
    expect(migrated.code).toBe(0);
    for (const canary of Object.values(C)) expect(migrated.out).not.toContain(canary);
    expect(hits(home)).toEqual([]);

    // 2. serve: the providers come from the vault, and running changes nothing about where secrets are.
    const running = await serve(home);
    try {
      expect(running.exited()).toBe(false);
      expect(running.output()).toContain("vault: open (passphrase keystore");
      expect(running.output()).toMatch(/provider groq/);
      expect(running.output()).toMatch(/provider custom/);
      for (const canary of Object.values(C)) expect(running.output()).not.toContain(canary);
      expect((await fetch(`http://127.0.0.1:${running.port}/health`)).ok).toBe(true);
    } finally {
      await running.stop();
    }
    expect(hits(home)).toEqual([]);

    // 3. export: every store is plaintext again, as it was.
    const exported = await agni(home, ["vault", "export", "--yes", "--non-interactive"]);
    expect(exported.code).toBe(0);
    const env = readFileSync(join(home, "config.env"), "utf8");
    expect(env).toContain(`GROQ_API_KEY=${C.groq}`);
    expect(env).toContain(`AGNI_CUSTOM_KEY_1=${C.custom}`);
    expect(env).toContain("AGNI_SECRETS_MODE=file");
    expect(JSON.parse(readFileSync(join(home, "providers.json"), "utf8")).custom[0].baseUrl).toContain(C.urlPass);
    expect(JSON.parse(readFileSync(join(home, "plugins.json"), "utf8"))).toEqual(PLUGINS);
    expect(readFileSync(join(home, "data", "chatgpt", "accounts.json"), "utf8")).toContain(C.chat);
    const db = new Database(join(home, "data", "agni.sqlite"), { readonly: true });
    expect(JSON.parse(db.query<{ tokens: string }, []>("SELECT tokens FROM plugin_connections WHERE id = 'plc_cal'").get()!.tokens)).toMatchObject({ access_token: C.dbAccess, refresh_token: C.dbRefresh });
    db.close();
    // File mode again: the next start needs no vault.
    expect(filesUnder(home).some((file) => file.endsWith("vault.bin"))).toBe(false);
  }, 120_000);

  test("running the migration twice changes nothing the second time", async () => {
    const home = fixtureHome();
    expect((await agni(home, ["vault", "migrate"])).code).toBe(0);
    const again = await agni(home, ["vault", "migrate"]);
    expect(again.code).toBe(0);
    expect(again.out).toContain("plugin-secrets: 0 moved");
    expect(again.out).toContain("plugin-tokens: 0 moved");
    expect(hits(home)).toEqual([]);
  }, 60_000);
});
