/**
 * S3-01 end to end, in real child processes: `agni vault migrate`, then
 * `serve` reads its provider key from the vault; a vault that cannot open
 * stops `serve` with a clear message and never falls back to the plaintext key.
 *
 * Throwaway AGNI_HOME. The passphrase keystore is used so no real credential
 * store is touched. No model is called: a provider "appearing" in the start-up
 * log is all that is checked.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ENTRY = resolve(import.meta.dir, "../src/index.ts");
const CANARY = "gsk_e2e_canary_value_0123456789";
const PASSPHRASE = "correct horse battery staple";

let roots: string[] = [];
const fresh = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "agni-e2e-"));
  roots.push(dir);
  return dir;
};
const children = new Set<ReturnType<typeof Bun.spawn>>();
afterEach(async () => {
  for (const child of children) child.kill();
  await Promise.all([...children].map((child) => child.exited));
  children.clear();
  for (const dir of roots) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  roots = [];
});

function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || /^AGNI_|API_KEY|TOKEN|SECRET|PASSWORD|^GROQ|^CEREBRAS|^NVIDIA|^OPENROUTER/i.test(name)) continue;
    env[name] = value;
  }
  return { ...env, ...extra };
}

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = server.port as number;
  await server.stop(true);
  return port;
}

async function agni(home: string, args: string[], extra: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  const child = Bun.spawn([process.execPath, ENTRY, ...args], {
    cwd: tmpdir(),
    env: cleanEnv({ AGNI_HOME: home, AGNI_KEYSTORE: "passphrase", AGNI_VAULT_PASSPHRASE_FILE: join(home, "..", "pp.txt"), ...extra }),
    stdout: "pipe",
    stderr: "pipe",
  });
  children.add(child);
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const code = await child.exited;
  children.delete(child);
  return { code, out: out + err };
}

/** Start `serve`, wait until it says it is listening or exits. Returns what it printed so far. */
async function serve(home: string, extra: Record<string, string> = {}): Promise<{ output: string; exited: boolean; code: number | null; stop: () => Promise<void> }> {
  const port = await freePort();
  const child = Bun.spawn([process.execPath, ENTRY, "serve"], {
    cwd: tmpdir(),
    env: cleanEnv({ AGNI_HOME: home, AGNI_PORT: String(port), AGNI_KEYSTORE: "passphrase", AGNI_VAULT_PASSPHRASE_FILE: join(home, "..", "pp.txt"), ...extra }),
    stdout: "pipe",
    stderr: "pipe",
  });
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
  // Let the provider lines print.
  if (!exited) await Bun.sleep(300);
  return {
    output,
    exited,
    code: child.exitCode,
    stop: async () => { child.kill(); await child.exited; children.delete(child); },
  };
}

function filesUnder(dir: string, skip: string[] = []): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (skip.includes(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path, skip));
    else out.push(path);
  }
  return out;
}

describe("vault end to end (child processes, passphrase keystore)", () => {
  test("migrate, serve from the vault, refuse on a bad passphrase", async () => {
    const parent = fresh();
    writeFileSync(join(parent, "pp.txt"), `${PASSPHRASE}\n`);
    const home = join(parent, "home");
    await Bun.write(join(home, "config.env"), `AGNI_HOST=127.0.0.1\nGROQ_API_KEY=${CANARY}\n`);

    // 1. migrate
    const migrated = await agni(home, ["vault", "migrate"]);
    expect(migrated.code).toBe(0);
    expect(migrated.out).toContain("config-env: 1 moved");
    expect(migrated.out).not.toContain(CANARY);

    // 2. no plaintext canary anywhere in the home outside the backup the owner is told about
    for (const file of filesUnder(home, ["vault-backups"])) expect(readFileSync(file).toString("latin1")).not.toContain(CANARY);

    // 3. serve: the provider is configured from the vault
    const running = await serve(home);
    try {
      expect(running.exited).toBe(false);
      expect(running.output).toContain("vault: open (passphrase keystore, 1 entries)");
      expect(running.output).toMatch(/provider groq/);
      expect(running.output).not.toContain(CANARY);
    } finally {
      await running.stop();
    }
    for (const file of filesUnder(home, ["vault-backups"])) expect(readFileSync(file).toString("latin1")).not.toContain(CANARY);

    // 4. wrong passphrase: refuses, names the reason, and does not use any plaintext key
    writeFileSync(join(parent, "pp.txt"), "a completely different passphrase\n");
    await Bun.write(join(home, "config.env"), `${readFileSync(join(home, "config.env"), "utf8")}GROQ_API_KEY=${CANARY}\n`);
    const refused = await serve(home);
    await refused.stop();
    expect(refused.exited).toBe(true);
    expect(refused.code).toBe(1);
    expect(refused.output).toContain("Agni cannot start");
    expect(refused.output).toContain("PASSPHRASE_REJECTED");
    expect(refused.output).not.toMatch(/provider groq/);
    expect(refused.output).not.toContain("listening on");
    expect(refused.output).not.toContain(CANARY);

    // 5. no passphrase at all: refuses too
    writeFileSync(join(parent, "pp.txt"), "");
    const missing = await serve(home);
    await missing.stop();
    expect(missing.code).toBe(1);
    expect(missing.output).toContain("PASSPHRASE_MISSING");
    expect(missing.output).toContain("LoadCredential");
  }, 90_000);

  test("the default (file mode) is unchanged: no vault, a plaintext key still configures a provider, no keystore touched", async () => {
    const parent = fresh();
    writeFileSync(join(parent, "pp.txt"), "");
    const home = join(parent, "home");
    await Bun.write(join(home, "config.env"), `GROQ_API_KEY=${CANARY}\n`);
    const running = await serve(home, { AGNI_KEYSTORE: "bun-secrets" });
    try {
      expect(running.exited).toBe(false);
      expect(running.output).toMatch(/provider groq/);
      expect(running.output).not.toContain("vault: open");
    } finally {
      await running.stop();
    }
    expect(filesUnder(home).some((file) => file.endsWith("vault.bin"))).toBe(false);
  }, 40_000);

  test("export --yes round trip through real processes restores the plaintext file", async () => {
    const parent = fresh();
    writeFileSync(join(parent, "pp.txt"), `${PASSPHRASE}\n`);
    const home = join(parent, "home");
    await Bun.write(join(home, "config.env"), `GROQ_API_KEY=${CANARY}\n`);
    await agni(home, ["vault", "migrate"]);
    expect(readFileSync(join(home, "config.env"), "utf8")).not.toContain(CANARY);
    const refused = await agni(home, ["vault", "export"]);
    expect(refused.code).toBe(1);
    expect(readFileSync(join(home, "config.env"), "utf8")).not.toContain(CANARY);
    const exported = await agni(home, ["vault", "export", "--yes"]);
    expect(exported.code).toBe(0);
    expect(readFileSync(join(home, "config.env"), "utf8")).toContain(`GROQ_API_KEY=${CANARY}`);
  }, 40_000);
});
