/**
 * Shared setup for the DAST suite (S3-12): a throwaway in-process server, the
 * same `startServer` the daemon runs, with its own AGNI_HOME, share folder and
 * web folder, and an in-memory database. Nothing here touches `~/.agni`.
 *
 * Not a test file (no `.test.`), so bun does not collect it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config";
import { openDatabase } from "../../src/db";
import { startHarness, type Harness } from "../ws-harness";

/** Environment the server reads at request time; cleared so a developer's shell cannot change a result. */
const ENV_KEYS = [
  "AGNI_HOME",
  "AGNI_DEV",
  "AGNI_ALLOWED_ORIGINS",
  "AGNI_PUBLIC_ORIGIN",
  "AGNI_SHARE_DIR",
  "AGNI_WEB_DIR",
  "AGNI_DB_PATH",
  "AGNI_PLUGINS_PATH",
] as const;

export const SHELL_MARKER = "<!doctype html><html><head><title>app</title></head><body>agni-app-shell</body></html>";

export interface Dast {
  harness: Harness;
  /** The throwaway AGNI_HOME. */
  home: string;
  /** `http://127.0.0.1:<port>` */
  base: string;
  port: number;
  /** A file outside the web folder whose contents must never be served. */
  secretFile: string;
  secretText: string;
  stop(): Promise<void>;
}

export interface DastOptions {
  config?: Partial<Config>;
  /**
   * Keep the database and the plugins file on disk inside the throwaway home,
   * as a real install does (`data/agni.sqlite`, `plugins.json`), instead of in
   * memory. The canary scan needs files to look at.
   */
  files?: boolean;
}

export async function startDast(options: DastOptions = {}): Promise<Dast> {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  const home = mkdtempSync(join(tmpdir(), "agni-dast-"));
  const web = join(home, "web");
  const share = join(home, "share");
  mkdirSync(web, { recursive: true });
  mkdirSync(share, { recursive: true });
  writeFileSync(join(web, "index.html"), SHELL_MARKER);
  const secretText = `DAST-SECRET-${crypto.randomUUID()}`;
  const secretFile = join(home, "secret.txt");
  writeFileSync(secretFile, secretText);
  process.env.AGNI_HOME = home;
  process.env.AGNI_WEB_DIR = web;
  process.env.AGNI_SHARE_DIR = share;

  let harness: Harness;
  try {
    if (options.files) {
      mkdirSync(join(home, "data"), { recursive: true });
      mkdirSync(join(home, "logs"), { recursive: true });
      const dbPath = join(home, "data", "agni.sqlite");
      harness = await startHarness({
        db: openDatabase(dbPath),
        config: { ...options.config, dbPath, pluginsPath: join(home, "plugins.json"), logPath: join(home, "logs", "agni.log") },
      });
    } else {
      harness = await startHarness(options.config ? { config: options.config } : {});
    }
  } catch (error) {
    restoreEnv(saved);
    rmSync(home, { recursive: true, force: true });
    throw error;
  }
  return {
    harness,
    home,
    base: harness.base,
    port: harness.server.port,
    secretFile,
    secretText,
    async stop() {
      await harness.stop();
      restoreEnv(saved);
      rmSync(home, { recursive: true, force: true });
    },
  };
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

/** A WebSocket upgrade request sent as plain HTTP, so a refusal is a status code, not a failed handshake. */
export function upgrade(base: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/ws`, {
    headers: {
      upgrade: "websocket",
      connection: "Upgrade",
      "sec-websocket-version": "13",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      ...headers,
    },
  });
}

/**
 * One raw HTTP/1.1 request over a plain socket, returned as text (status line,
 * headers, body). The URL parser in `fetch` would fold `%2e%2e` and `..` away
 * before they left the client; an attacker's client does not.
 */
export async function rawHttp(port: number, requestLine: string, headers: Record<string, string> = {}): Promise<{ status: number; head: string; body: string }> {
  const lines = [requestLine, `Host: 127.0.0.1:${port}`, "Connection: close", ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), "", ""];
  let text = "";
  const done = Promise.withResolvers<void>();
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      data(_s, data) { text += new TextDecoder().decode(data); },
      close() { done.resolve(); },
      error() { done.resolve(); },
      open(s) { s.write(lines.join("\r\n")); },
    },
  });
  await Promise.race([done.promise, Bun.sleep(3000)]);
  socket.end();
  const split = text.indexOf("\r\n\r\n");
  const head = split >= 0 ? text.slice(0, split) : text;
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? 0);
  return { status, head, body: split >= 0 ? text.slice(split + 4) : "" };
}

/** The Set-Cookie attributes of a response, lower-cased, name excluded: `["httponly", "max-age=60", ...]`. */
export function cookieAttributes(response: Response): { name: string; value: string; attrs: string[] } | null {
  const raw = response.headers.getSetCookie()[0] ?? response.headers.get("set-cookie");
  if (!raw) return null;
  const [pair, ...attrs] = raw.split(";").map((part) => part.trim());
  const eq = pair!.indexOf("=");
  return { name: pair!.slice(0, eq), value: pair!.slice(eq + 1), attrs: attrs.map((a) => a.toLowerCase()) };
}

export function maxAgeSeconds(attrs: string[]): number | null {
  const found = attrs.find((attr) => attr.startsWith("max-age="));
  return found ? Number(found.slice("max-age=".length)) : null;
}
