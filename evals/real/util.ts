/**
 * Helpers shared by the real-model eval tasks: seeded randomness, number
 * matching, fixture files and snapshots, and reads of the episode database.
 * Imported from the round-5 in-app harness (2026-11-16, `common.ts` and the
 * helper block of `jobs.ts`), with its fixed paths removed.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Ctx } from "./types";

export const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));
export const sha = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** A small seeded generator (mulberry32), so a task's fixture is the same for the same rep. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number): number => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: T[]): T => xs[Math.floor(next() * xs.length)]!,
    shuffle: <T>(xs: T[]): T[] => {
      const out = [...xs];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    },
  };
}

export function money(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Every number in a text, with thousands separators and `$` removed. */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/-?\$?\d[\d,]*(?:\.\d+)?/g)) {
    const n = Number(m[0].replace(/[$,]/g, ""));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

export function hasNumber(text: string, value: number, tol = 0.011): boolean {
  return numbersIn(text).some((n) => Math.abs(n - value) <= tol);
}

export const r2 = (n: number): number => Math.round(n * 100) / 100;
export const lines = (text: string): string[] => text.split(/\r?\n/);

/** Write a fixture file into the episode's scratch folder. */
export function w(ctx: Ctx, rel: string, text: string): void {
  const path = join(ctx.scratch, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** Read a file from scratch, or null when it does not exist. */
export function rd(ctx: Ctx, rel: string): string | null {
  const path = join(ctx.scratch, rel);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

export function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

/** Every file in scratch, relative path (forward slashes) to sha256. */
export function snapshot(ctx: Ctx): Record<string, string> {
  return Object.fromEntries(walk(ctx.scratch).map((p) => [relative(ctx.scratch, p).replaceAll("\\", "/"), sha(readFileSync(p))]));
}

/** Write a fixture web page; it is served at `${ctx.webBase}/${path}`. */
export function writeWeb(ctx: Ctx, path: string, html: string): void {
  const file = join(ctx.webDir, `${path}.html`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
}

export function page(title: string, body: string): string {
  return `<!doctype html><html><head><title>${title}</title></head><body><nav>Home | Products | Pricing | Support | Contact</nav>${body}<footer>(c) 2026 &middot; All rights reserved &middot; Terms &middot; Privacy</footer></body></html>`;
}

export interface ToolRow {
  tool: string;
  args: any;
  result: string | null;
  ok: number;
  error: string | null;
  agent: string;
  thread: string;
  turn: string;
  at: string;
  callId: string;
  durationMs: number | null;
}

export function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** Every tool call in the episode, oldest first, with the bot that made it. */
export function toolRows(ctx: Ctx): ToolRow[] {
  const db = ctx.db();
  try {
    return db
      .query<Omit<ToolRow, "args"> & { args: string }, []>(
        `SELECT tc.tool_name tool, tc.args args, tc.result result, tc.ok ok, tc.error error, th.agent_id agent,
                tc.thread_id thread, tc.turn_id turn, tc.created_at at, tc.call_id callId, tc.duration_ms durationMs
         FROM tool_calls tc LEFT JOIN threads th ON th.id = tc.thread_id
         ORDER BY tc.created_at, tc.rowid`,
      )
      .all()
      .map((row) => ({ ...row, args: safeJson(row.args) }));
  } finally {
    db.close();
  }
}

export const argsText = (row: ToolRow): string => JSON.stringify(row.args ?? {});

/** Wait until no turn is running and no turn or routine job is running or due. True when it went quiet in time. */
export async function waitQuiet(ctx: Ctx, maxMs: number, stableMs = 4000): Promise<boolean> {
  const t0 = Date.now();
  let quietSince = 0;
  while (Date.now() - t0 < maxMs) {
    const db = ctx.db();
    let busy = 0;
    try {
      const soon = new Date(Date.now() + 2500).toISOString();
      busy = db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) n FROM jobs WHERE kind IN ('turn','routine') AND enabled=1 AND (state='running' OR (state='queued' AND run_at <= ?))",
        )
        .get(soon)!.n;
    } finally {
      db.close();
    }
    if (busy === 0 && ctx.client.running().length === 0) {
      if (!quietSince) quietSince = Date.now();
      if (Date.now() - quietSince >= stableMs) return true;
    } else {
      quietSince = 0;
    }
    await sleep(500);
  }
  return false;
}

/** The main assistant's conversation id. */
export function getConv(ctx: Ctx): string {
  const db = ctx.db();
  try {
    return db.query<{ id: string }, []>("SELECT id FROM conversations WHERE agent_id IN ('ea','agni') ORDER BY created_at LIMIT 1").get()!.id;
  } finally {
    db.close();
  }
}

/** Close the current session block (as the owner's /new does) and return the carried summary. */
export async function rotateSession(ctx: Ctx): Promise<string> {
  const conv = getConv(ctx);
  const before = ctx.client.sessionStarts.length;
  ctx.client.send({ type: "session.new", conversationID: conv });
  const t0 = Date.now();
  while (ctx.client.sessionStarts.length === before && Date.now() - t0 < 200_000) await sleep(300);
  const db = ctx.db();
  try {
    return db.query<{ summary: string | null }, [string]>("SELECT summary FROM conversations WHERE id = ?").get(conv)?.summary ?? "";
  } finally {
    db.close();
  }
}
