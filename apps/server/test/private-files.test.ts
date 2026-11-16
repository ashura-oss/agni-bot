/**
 * S1-35: files and directories that hold secrets (or that other code trusts)
 * are owner-only on every platform. POSIX uses mode bits; Windows has none, so
 * the same promise is an ACL. The ACL assertions run on Windows only; the mode
 * assertions run everywhere via `expectPrivate`.
 *
 * Each Windows case starts from a parent directory that grants Everyone read
 * through inheritance. A write that merely inherits the parent's ACL would be
 * readable by Everyone, so a passing assertion proves the code restricted it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintToken } from "../src/auth/tokens";
import { backgroundRequest } from "../src/appearance/http";
import { saveAttachment } from "../src/attachments/store";
import { readPidFile, writePidFile } from "../src/daemon";
import { openDatabase } from "../src/db";
import { HealthTracker } from "../src/models/health";
import { addProviderCredential, setProviderModel } from "../src/models/provider-settings";
import { Router } from "../src/models/router";
import { loadVapid } from "../src/push/web-push";
import { PrivateFileError, secureDirectory, isOwnerOnlyDirectory, secureDirectoryIfNeeded, secureFile, writePrivateFile, writePrivateFileSync } from "../src/util/private-file";
import { currentUserSid, windowsSystemTool } from "../src/util/windows-acl";
import { aclEntries, expectOwnerOnlyAcl, expectPrivate, withFailingAcl, withFailingAclAsync } from "./acl-helper";

const windowsOnly = process.platform !== "win32";
const created: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function remember(name: string): void {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name];
}

afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete savedEnv[name];
  }
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** A fresh directory whose inheritable ACL lets Everyone read (Windows); a plain temp dir elsewhere. */
function exposedDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agni-private-"));
  created.push(dir);
  if (process.platform === "win32") {
    execFileSync(windowsSystemTool("icacls"), [dir, "/grant", "*S-1-1-0:(OI)(CI)R"], { stdio: "pipe", windowsHide: true });
  }
  return dir;
}

/**
 * A directory inside an exposed one. It carries the exposure as an inherited
 * entry, which is what an ACL restriction removes (an explicit extra entry on
 * the directory itself is not removed by `icacls /inheritance:r`).
 */
function exposedChild(): string {
  const child = join(exposedDir(), "home");
  mkdirSync(child);
  return child;
}

/** Capture warn/error output (the logger writes to console.error). */
async function captureWarnings<T>(fn: () => T | Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    return { result: await fn(), lines };
  } finally {
    console.error = real;
  }
}

describe("provider keys (config.env, providers.json): fail closed", () => {
  const FAKE_KEY = "gsk_fake_key_for_tests_0123456789";

  function useHome(): string {
    const home = exposedDir();
    remember("AGNI_HOME"); remember("AGNI_PROVIDER_CONFIG_PATH"); remember("GROQ_API_KEY");
    process.env.AGNI_HOME = home;
    delete process.env.AGNI_PROVIDER_CONFIG_PATH;
    delete process.env.GROQ_API_KEY;
    return home;
  }
  const router = () => new Router([], new HealthTracker());

  test("config.env is owner-only after a key is saved", async () => {
    const home = useHome();
    const result = await addProviderCredential(router(), "groq", FAKE_KEY);
    expect(result.ok).toBe(true);
    expect(readFileSync(join(home, "config.env"), "utf8")).toContain("GROQ_API_KEY");
    expectPrivate(join(home, "config.env"), 0o600);
  });

  test("a second key is written over the first without loosening the file", async () => {
    const home = useHome();
    await addProviderCredential(router(), "groq", FAKE_KEY);
    remember("CEREBRAS_API_KEY");
    await addProviderCredential(router(), "cerebras", `${FAKE_KEY}_b`);
    expectPrivate(join(home, "config.env"), 0o600);
  });

  test("providers.json is owner-only after a model is chosen", async () => {
    const home = useHome();
    const live = new Router([{ id: "groq", label: "Groq", baseUrl: "https://x.invalid/v1", apiKey: FAKE_KEY, model: "m" }], new HealthTracker());
    const result = await setProviderModel(live, "groq", "some-model");
    expect(result.ok).toBe(true);
    expectPrivate(join(home, "providers.json"), 0o600);
  });

  test.skipIf(windowsOnly)("when the ACL cannot be set the key is not written anywhere", async () => {
    const home = useHome();
    const result = await withFailingAclAsync(() => addProviderCredential(router(), "groq", FAKE_KEY));
    expect(result).toMatchObject({ ok: false, code: "provider_storage" });
    // A clear message that names the file and never the key.
    expect(result.ok === false && result.message).toMatch(/config\.env.*nothing was saved/);
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY);
    expect(existsSync(join(home, "config.env"))).toBe(false);
    // No temp file is left behind, and the key is not applied to the live process.
    expect(readdirSync(home)).toEqual([]);
    expect(process.env.GROQ_API_KEY).toBeUndefined();
  });

  test.skipIf(windowsOnly)("when the ACL cannot be set the model choice is not written either", async () => {
    const home = useHome();
    const live = new Router([{ id: "groq", label: "Groq", baseUrl: "https://x.invalid/v1", apiKey: FAKE_KEY, model: "m" }], new HealthTracker());
    const result = await withFailingAclAsync(() => setProviderModel(live, "groq", "some-model"));
    expect(result).toMatchObject({ ok: false, code: "provider_storage" });
    expect(readdirSync(home)).toEqual([]);
  });
});

describe("VAPID private key (push-vapid.json): fail closed", () => {
  test("the key file is owner-only", () => {
    const path = join(exposedDir(), "push-vapid.json");
    const keys = loadVapid(path);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(keys);
    expectPrivate(path, 0o600);
    expect(loadVapid(path)).toEqual(keys);
  });

  test.skipIf(windowsOnly)("when the ACL cannot be set no key is written, and the next call can still create one", () => {
    const dir = exposedDir();
    const path = join(dir, "push-vapid.json");
    expect(() => withFailingAcl(() => loadVapid(path))).toThrow();
    expect(readdirSync(dir)).toEqual([]);
    const keys = loadVapid(path);
    expect(keys.privateKey.length).toBeGreaterThan(10);
    expectPrivate(path, 0o600);
  });
});

describe("pid file: warn and continue (it holds no secret)", () => {
  test("the pid file is owner-only", () => {
    const path = join(exposedDir(), "run", "agni.pid");
    writePidFile(path, { pid: 4242, startedAt: "2026-10-16T12:00:00.000Z" });
    expect(readPidFile(path)).toEqual({ pid: 4242, startedAt: "2026-10-16T12:00:00.000Z" });
    expectPrivate(path, 0o600);
  });

  test.skipIf(windowsOnly)("when the ACL cannot be set the pid file is still written and the owner is told", async () => {
    const path = join(exposedDir(), "run", "agni.pid");
    const { lines } = await captureWarnings(() => withFailingAcl(() => writePidFile(path, { pid: 77 })));
    expect(readPidFile(path)).toEqual({ pid: 77 });
    expect(lines.some((line) => line.includes("WARN") && line.includes("pid file"))).toBe(true);
  });
});

describe("attachments and appearance images: warn and continue", () => {
  async function database() {
    const dir = exposedDir();
    const dbPath = join(dir, "data", "agni.sqlite");
    mkdirSync(join(dir, "data"));
    const db = openDatabase(dbPath);
    const { device, token } = await mintToken(db, "acl-test");
    return { dir, dbPath, db, device, token };
  }
  const note = () => new File(["hello, attachment"], "note.txt", { type: "text/plain" });
  const png = () => new File([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64")], "pixel.png", { type: "image/png" });

  test("the attachments directory and a saved attachment are owner-only", async () => {
    const { dir, dbPath, db, device } = await database();
    try {
      const info = await saveAttachment(db, dbPath, device.id, note());
      const stored = db.query<{ path: string }, [string]>("SELECT path FROM attachments WHERE id = ?").get(info.id)!.path;
      expectPrivate(join(dir, "data", "attachments"), 0o700);
      expectPrivate(stored, 0o600);
    } finally { db.close(); }
  });

  test.skipIf(windowsOnly)("when the ACL cannot be set the attachment is still saved and the owner is told", async () => {
    const { dbPath, db, device } = await database();
    try {
      const { result, lines } = await captureWarnings(() => withFailingAclAsync(() => saveAttachment(db, dbPath, device.id, note())));
      expect(result.name).toBe("note.txt");
      expect(lines.some((line) => line.includes("WARN") && line.includes("attachments"))).toBe(true);
    } finally { db.close(); }
  });

  test("the backgrounds directory and an uploaded image are owner-only", async () => {
    const { dir, dbPath, db, token } = await database();
    try {
      const body = new FormData(); body.append("file", png());
      const response = await backgroundRequest(new Request("http://localhost/backgrounds", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body }), db, dbPath);
      expect(response.status).toBe(201);
      const { id } = await response.json() as { id: string };
      expectPrivate(join(dir, "data", "backgrounds"), 0o700);
      expectPrivate(join(dir, "data", "backgrounds", id), 0o600);
    } finally { db.close(); }
  });

  test.skipIf(windowsOnly)("when the ACL cannot be set the image is still saved and the owner is told", async () => {
    const { dbPath, db, token } = await database();
    try {
      const body = new FormData(); body.append("file", png());
      const { result, lines } = await captureWarnings(() => withFailingAclAsync(() =>
        backgroundRequest(new Request("http://localhost/backgrounds", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body }), db, dbPath)));
      expect(result.status).toBe(201);
      expect(lines.some((line) => line.includes("WARN") && line.includes("backgrounds"))).toBe(true);
    } finally { db.close(); }
  });
});

describe("secureDirectory and secureFile (AGNI_HOME at boot, config.env at setup)", () => {
  test("a directory with files already in it, and files added later, end up owner-only", () => {
    const home = exposedChild();
    mkdirSync(join(home, "data"));
    writeFileSync(join(home, "config.env"), "GROQ_API_KEY=x\n");
    writeFileSync(join(home, "data", "agni.sqlite"), "db");
    secureDirectory(home, "throw");
    writeFileSync(join(home, "later.txt"), "x");
    expectPrivate(home, 0o700);
    // POSIX: the helper does nothing (setup keeps its chmod), so only assert the ACL on Windows.
    if (process.platform === "win32") {
      for (const path of ["config.env", join("data"), join("data", "agni.sqlite"), "later.txt"]) expectOwnerOnlyAcl(join(home, path));
    }
  });

  test.skipIf(windowsOnly)("running it twice changes nothing", () => {
    const home = exposedChild();
    secureDirectory(home, "throw");
    const first = aclEntries(home);
    secureDirectory(home, "throw");
    expect(aclEntries(home)).toEqual(first);
  });

  test.skipIf(windowsOnly)("fail closed throws a PrivateFileError that names the directory; warn logs and continues", async () => {
    const home = exposedDir();
    expect(() => withFailingAcl(() => secureDirectory(home, "throw"))).toThrow(PrivateFileError);
    expect(() => withFailingAcl(() => secureDirectory(home, "throw"))).toThrow(home);
    const { lines } = await captureWarnings(() => withFailingAcl(() => secureDirectory(home, "warn")));
    expect(lines.some((line) => line.includes("WARN") && line.includes(home))).toBe(true);
  });

  test.skipIf(windowsOnly)("secureFile makes one file owner-only and throws when it cannot", () => {
    const dir = exposedDir();
    const file = join(dir, "config.env");
    writeFileSync(file, "x");
    secureFile(file);
    expectOwnerOnlyAcl(file);
    expect(() => withFailingAcl(() => secureFile(file))).toThrow(PrivateFileError);
  });
});

describe("writePrivateFile", () => {
  test.skipIf(windowsOnly)("a failure leaves nothing at the path and no temporary file, and never holds the contents", async () => {
    const dir = exposedDir();
    const path = join(dir, "secret.txt");
    await expect(withFailingAclAsync(() => writePrivateFile(path, "SECRET-CONTENTS"))).rejects.toBeInstanceOf(PrivateFileError);
    expect(() => withFailingAcl(() => writePrivateFileSync(path, "SECRET-CONTENTS"))).toThrow(PrivateFileError);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("replacing an existing file keeps it owner-only and does not expose the old copy", async () => {
    const dir = exposedDir();
    const path = join(dir, "secret.txt");
    await writePrivateFile(path, "one");
    await writePrivateFile(path, "two");
    expect(readFileSync(path, "utf8")).toBe("two");
    expectPrivate(path, 0o600);
    expect(readdirSync(dir)).toEqual(["secret.txt"]);
  });
});

describe("secureDirectoryIfNeeded (AGNI_HOME at every serve start)", () => {
  test("an already owner-only directory is left alone; an exposed one is secured", () => {
    const home = exposedChild();
    expect(secureDirectoryIfNeeded(home, "throw")).toBe(true);
    expectPrivate(home, 0o700);
    if (process.platform === "win32") expect(secureDirectoryIfNeeded(home, "throw")).toBe(false);
  });

  test.skipIf(windowsOnly)("it re-applies the ACL when something loosened it, and when inheritance to new files was lost", () => {
    const home = exposedChild();
    secureDirectory(home, "throw");
    // Something re-enabled inheritance from the exposed parent.
    execFileSync(windowsSystemTool("icacls"), [home, "/inheritance:e"], { stdio: "pipe", windowsHide: true });
    expect(isOwnerOnlyDirectory(home)).toBe(false);
    expect(secureDirectoryIfNeeded(home, "throw")).toBe(true);
    expectOwnerOnlyAcl(home);
    // Owner-only but not inherited by new files: not good enough.
    const sid = currentUserSid();
    execFileSync(windowsSystemTool("icacls"), [home, "/inheritance:r", "/grant:r", `*${sid}:F`], { stdio: "pipe", windowsHide: true });
    expect(secureDirectoryIfNeeded(home, "throw")).toBe(true);
    writeFileSync(join(home, "new.txt"), "x");
    expectOwnerOnlyAcl(join(home, "new.txt"));
  });

  test.skipIf(windowsOnly)("when the ACL cannot even be read it tries to secure, and warn mode carries on", async () => {
    const home = exposedChild();
    const { lines } = await captureWarnings(() => withFailingAcl(() => secureDirectoryIfNeeded(home, "warn")));
    expect(lines.some((line) => line.includes("WARN") && line.includes(home))).toBe(true);
  });
});

describe("PDF worker environment", () => {
  test("the worker that parses an untrusted PDF gets no provider key", async () => {
    const dir = exposedChild();
    const dbPath = join(dir, "agni.sqlite");
    const db = openDatabase(dbPath);
    const { device } = await mintToken(db, "pdf-env");
    remember("OPENROUTER_API_KEY"); remember("AGNI_HOME");
    process.env.OPENROUTER_API_KEY = "fake-pdf-test-key-0123456789";
    process.env.AGNI_HOME = dir;
    const seen: Array<Record<string, string | undefined> | undefined> = [];
    const realSpawn = Bun.spawn;
    (Bun as { spawn: unknown }).spawn = ((...args: unknown[]) => {
      seen.push((args[1] as { env?: Record<string, string | undefined> } | undefined)?.env);
      return (realSpawn as (...a: unknown[]) => unknown)(...args);
    }) as unknown;
    try {
      const body = "%PDF-1.4\n%%EOF\n";
      await saveAttachment(db, dbPath, device.id, new File([body], "x.pdf", { type: "application/pdf" })).catch(() => {});
    } finally {
      (Bun as { spawn: unknown }).spawn = realSpawn;
      db.close();
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeDefined();
    expect(seen[0]!.OPENROUTER_API_KEY).toBeUndefined();
    expect(seen[0]!.PATH ?? seen[0]!.Path).toBeDefined();
  });
});
