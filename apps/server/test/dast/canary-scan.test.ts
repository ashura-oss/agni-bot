import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase } from "../../src/db";
import { rememberFact } from "../../src/tools/facts";

/**
 * S3-03 / Sprint 3 exit test 1: `scripts/canary-scan.ts`. A value planted as a
 * secret must be found nowhere in plaintext: not in the vault file, the
 * database (or its write-ahead log), a log, a captured frame log, or any other
 * file under the home. Each test runs the real script as a child process on a
 * throwaway AGNI_HOME and reads its exit code, so "exit non-zero on a hit" is
 * what is tested, not an internal function.
 */

const SCRIPT = resolve(import.meta.dir, "../../../../scripts/canary-scan.ts");
const CANARY = "sk-canary-planted-7f3a91c2d4e8";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Home {
  home: string;
  vault: string;
  db: string;
  log: string;
  frames: string;
}

/** A believable home with nothing secret in it: a real database, an encrypted-looking vault, a log and a frame capture. */
function makeHome(): Home {
  const home = mkdtempSync(join(tmpdir(), "agni-canary-"));
  dirs.push(home);
  mkdirSync(join(home, "data"), { recursive: true });
  mkdirSync(join(home, "logs"), { recursive: true });
  mkdirSync(join(home, "scratch"), { recursive: true });
  const db = join(home, "data", "agni.sqlite");
  openDatabase(db).close();
  const vault = join(home, "vault.bin");
  writeFileSync(vault, encryptedVault({ provider_groq: "a-different-secret-value-1234567890" }));
  const log = join(home, "logs", "agni.log");
  writeFileSync(log, "2026-11-16T10:00:00.000Z INFO  server listening\n");
  const frames = join(home, "frames.jsonl");
  writeFileSync(frames, `${JSON.stringify({ type: "hello.ok", seq: 1 })}\n${JSON.stringify({ type: "provider.add.ok", seq: 2, providers: [] })}\n`);
  writeFileSync(join(home, "config.env"), "AGNI_PORT=8787\n");
  return { home, vault, db, log, frames };
}

/** AES-256-GCM over the JSON, framed the way a vault file would be: magic, nonce, tag, ciphertext. */
function encryptedVault(secrets: Record<string, string>): Buffer {
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(JSON.stringify(secrets), "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from("AGNIVLT1"), nonce, cipher.getAuthTag(), body]);
}

interface Run {
  code: number;
  out: string;
  err: string;
}

async function scan(home: Home | null, args: string[], env: Record<string, string | undefined> = {}): Promise<Run> {
  const clean: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(clean)) if (key.startsWith("AGNI_")) delete clean[key];
  const child = Bun.spawn([process.execPath, SCRIPT, ...args], {
    cwd: home?.home ?? tmpdir(),
    env: { ...clean, ...(home ? { AGNI_HOME: home.home } : {}), ...env } as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, out, err };
}

const secretsScan = (home: Home, extra: string[] = []) => scan(home, ["--secrets", `--canary=${CANARY}`, "--require-vault", ...extra]);

describe("a clean home", () => {
  test("every source clean: exit 0 and a line saying so", async () => {
    const home = makeHome();
    const run = await secretsScan(home, [`--frames=${home.frames}`]);
    expect({ code: run.code, err: run.err.trim() }).toEqual({ code: 0, err: "" });
    expect(run.out).toContain("clean");
  });

  test("an encrypted vault that holds the canary does not trip the scan (the value is not in it as text)", async () => {
    const home = makeHome();
    writeFileSync(home.vault, encryptedVault({ provider_openrouter: CANARY }));
    const run = await secretsScan(home, [`--frames=${home.frames}`]);
    expect(run.code).toBe(0);
  });
});

describe("a hit in any one place fails the scan", () => {
  test("the vault holding the value in plaintext (the vault is not encrypted)", async () => {
    const home = makeHome();
    writeFileSync(home.vault, JSON.stringify({ provider_openrouter: CANARY }));
    const run = await secretsScan(home);
    expect(run.code).toBe(1);
    expect(run.err).toMatch(/vault/);
    expect(run.err).toContain("not encrypted");
  });

  test("the database", async () => {
    const home = makeHome();
    const db = openDatabase(home.db);
    rememberFact(db, { fact: `my key is ${CANARY}` });
    db.close();
    const run = await secretsScan(home);
    expect(run.code).toBe(1);
    expect(run.err).toMatch(/database|agent_memories/);
  });

  test("the database's write-ahead log, before it is checkpointed into the main file", async () => {
    const home = makeHome();
    const db = new Database(home.db);
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA wal_autocheckpoint = 0");
    db.run("CREATE TABLE IF NOT EXISTS canary_probe (value TEXT)");
    db.run("INSERT INTO canary_probe (value) VALUES (?)", [CANARY]);
    try {
      const run = await secretsScan(home);
      expect(run.code).toBe(1);
      expect(run.err).toMatch(/-wal|database/);
    } finally {
      db.close();
    }
  });

  test("a log file", async () => {
    const home = makeHome();
    writeFileSync(home.log, `2026-11-16 INFO provider added with key ${CANARY}\n`);
    const run = await secretsScan(home);
    expect(run.code).toBe(1);
    expect(run.err).toMatch(/log/);
  });

  test("a captured frame log", async () => {
    const home = makeHome();
    writeFileSync(home.frames, `${JSON.stringify({ type: "error", seq: 3, message: `bad key ${CANARY}` })}\n`);
    const run = await secretsScan(home, [`--frames=${home.frames}`]);
    expect(run.code).toBe(1);
    expect(run.err).toMatch(/frame-log/);
  });

  test.each([
    ["config.env (the plaintext file the vault replaces)", "config.env", `OPENROUTER_API_KEY=${CANARY}\n`],
    ["providers.json", "providers.json", JSON.stringify({ custom: [{ apiKey: CANARY }] })],
    ["plugins.json", "plugins.json", JSON.stringify({ plugins: { gmail: { auth: { pass: CANARY } } } })],
    ["a ChatGPT accounts file", join("data", "chatgpt", "accounts.json"), JSON.stringify({ accounts: [{ refresh: CANARY }] })],
    ["a file in scratch", join("scratch", "notes.txt"), `remember ${CANARY}`],
    ["a backup copy of the database", join("data", "backups", "agni-2026.sqlite"), `x${CANARY}x`],
  ])("%s", async (_label, rel, content) => {
    const home = makeHome();
    mkdirSync(join(home.home, rel, ".."), { recursive: true });
    writeFileSync(join(home.home, rel), content);
    const run = await secretsScan(home);
    expect(run.code).toBe(1);
    expect(run.err).toContain(rel.replaceAll("\\", "/").split("/").pop()!);
  });

  test.each([
    ["UTF-16 (a Windows tool's text file)", Buffer.from(`key=${CANARY}`, "utf16le")],
    ["base64, value at the start of a group", Buffer.from(Buffer.from(`${CANARY} and then more text`).toString("base64"))],
    ["base64, value one byte into a group", Buffer.from(Buffer.from(`k${CANARY} and then more text`).toString("base64"))],
    ["base64, value two bytes into a group", Buffer.from(Buffer.from(`ky${CANARY} and then more text`).toString("base64"))],
    ["base64 at the very end of the file", Buffer.from(Buffer.from(`ky${CANARY}`).toString("base64"))],
    ["hex", Buffer.from(Buffer.from(CANARY).toString("hex"))],
    ["binary with the value in the middle", Buffer.concat([randomBytes(512), Buffer.from(CANARY), randomBytes(512)])],
  ])("the value stored as %s", async (_label, bytes) => {
    const home = makeHome();
    writeFileSync(join(home.home, "scratch", "dump.bin"), bytes);
    const run = await secretsScan(home);
    expect(run.code).toBe(1);
    expect(run.err).toContain("dump.bin");
  });

  test("several canaries: one clean and one leaked still fails, naming the leaked one only", async () => {
    const home = makeHome();
    writeFileSync(join(home.home, "config.env"), "OTHER_KEY=second-canary-value-0000\n");
    const run = await scan(home, ["--secrets", `--canary=${CANARY},second-canary-value-0000`, "--require-vault"]);
    expect(run.code).toBe(1);
    expect(run.err).toContain("seco…");
    expect(run.err).not.toContain("sk-c…");
  });
});

describe("the report", () => {
  test("never prints the value in secrets mode (the report goes into logs and CI output)", async () => {
    const home = makeHome();
    writeFileSync(join(home.home, "config.env"), `KEY=${CANARY}\n`);
    const run = await secretsScan(home);
    expect(run.code).toBe(1);
    expect(run.err + run.out).not.toContain(CANARY);
    expect(run.err).toContain("sk-c…");
  });
});

describe("a scan that could not look is not a pass", () => {
  test("no canary given", async () => {
    const home = makeHome();
    expect((await scan(home, ["--secrets"])).code).toBe(2);
  });

  test("a canary too short to mean anything", async () => {
    const home = makeHome();
    expect((await scan(home, ["--secrets", "--canary=abc"])).code).toBe(2);
  });

  test("--require-vault with no vault file", async () => {
    const home = makeHome();
    rmSync(home.vault);
    const run = await secretsScan(home);
    expect(run.code).toBe(2);
    expect(run.err).toContain("vault");
  });

  test("a frame log that was named but is not there", async () => {
    const home = makeHome();
    const run = await secretsScan(home, [`--frames=${join(home.home, "nope.jsonl")}`]);
    expect(run.code).toBe(2);
  });

  test("--secrets with no home to look in", async () => {
    expect((await scan(null, ["--secrets", `--canary=${CANARY}`])).code).toBe(2);
  });
});

describe("the EVAL-004 mode still works as it did", () => {
  test("a canary in a model-visible sink is reported and fails; a clean database passes", async () => {
    const home = makeHome();
    const clean = await scan(home, [`--canary=${CANARY}`], { AGNI_DB_PATH: home.db, AGNI_LOG_PATH: home.log });
    expect(clean.code).toBe(0);
    const db = openDatabase(home.db);
    rememberFact(db, { fact: `private: ${CANARY}`, scope: "agent", agentID: "researcher", visibility: "private" });
    db.close();
    const leaked = await scan(home, [`--canary=${CANARY}`], { AGNI_DB_PATH: home.db, AGNI_LOG_PATH: home.log });
    expect(leaked.code).toBe(1);
    expect(leaked.err).toContain("agent_memories");
  });

  test("the default mode does not look at files under the home (the owner transcript is allowed to hold the words)", async () => {
    const home = makeHome();
    writeFileSync(join(home.home, "config.env"), `KEY=${CANARY}\n`);
    const run = await scan(home, [`--canary=${CANARY}`], { AGNI_DB_PATH: home.db, AGNI_LOG_PATH: home.log });
    expect(run.code).toBe(0);
  });
});
