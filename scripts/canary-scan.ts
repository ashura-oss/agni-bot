/**
 * `bun run scan:canary` — the leak detector.
 *
 * Two jobs, one command.
 *
 * 1. EVAL-004 (default). After a run that planted canary strings (a private
 *    agent's words), check the places a private agent's text must never reach:
 *    the model-visible transcript, durable facts, delegation rows, thread
 *    titles, carried summaries, and the log file. The owner-facing transcript
 *    is deliberately not scanned: the owner opens the agent's DM directly.
 *
 *      AGNI_CANARY="CANARY-ONE,CANARY-TWO" bun run scan:canary
 *      AGNI_DB_PATH=data/agni.sqlite AGNI_LOG_PATH=data/agni.log bun run scan:canary
 *
 * 2. Secrets (`--secrets`, Sprint 3 S3-03). A secret planted in the vault
 *    (a provider key, say) must be found nowhere in plaintext: not in the vault
 *    file, not in the database or its write-ahead log, not in any log, not in a
 *    captured frame log, not in any other file under AGNI_HOME. Here the owner
 *    transcript is not exempt: nothing may hold the value. A file counts as a
 *    hit when it holds the value as UTF-8, UTF-16, base64 (any alignment) or hex.
 *
 *      AGNI_HOME=/tmp/agni-test bun run scan:canary --secrets --canary=sk-planted-0123456789 \
 *        --frames=frames.jsonl --require-vault
 *
 * Flags (each also works in the default mode, to add a source):
 *   --canary=a,b      the values to look for (or AGNI_CANARY)
 *   --secrets         scan raw bytes of everything under AGNI_HOME (or --home=DIR)
 *   --home=DIR        the home to scan (default: AGNI_HOME)
 *   --vault=FILE      the vault file (default: HOME/vault.bin)
 *   --db=FILE         the database (default: AGNI_DB_PATH, then HOME/data/agni.sqlite)
 *   --log=FILE        a log file (default: AGNI_LOG_PATH, then HOME/logs)
 *   --frames=FILE     a captured frame log; the file must exist
 *   --require-vault   exit 2 when there is no vault file (so a scan of nothing cannot pass)
 *
 * Exit: 0 clean, 1 a hit, 2 the scan could not run (no canary, a named file missing) or
 * could not look at everything: a file it could not stat or read, a folder it could not
 * list, a file over the size limit. Each is named on stderr. A hit still exits 1 (the leak
 * is proven), but a scan that skipped something never says "clean".
 * In `--secrets` mode a hit never prints the value, only its first four characters and length.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { openDatabaseReadOnly } from "../apps/server/src/db";
import { scanDatabaseForCanaries, scanTextForCanaries, type CanaryHit } from "../apps/server/src/db/canary";

/** A byte-level hit in a file. */
export interface FileHit {
  sink: string;
  path: string;
  encoding: string;
  canary: string;
}

const DEFAULT_MAX_FILE_BYTES = 512 * 1024 * 1024;
/** The size above which a file is not read. `AGNI_CANARY_MAX_FILE_BYTES` lowers it (the tests do). A skipped file fails the scan. */
const maxFileBytes = (): number => {
  const value = Number(process.env.AGNI_CANARY_MAX_FILE_BYTES);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_FILE_BYTES;
};
const MIN_CANARY_LENGTH = 8;

/** Every byte pattern a value could be stored as. A canary shorter than a few characters would match noise, so callers reject those. */
export function encodings(canary: string): Array<{ name: string; bytes: Buffer }> {
  const utf8 = Buffer.from(canary, "utf8");
  const out: Array<{ name: string; bytes: Buffer }> = [
    { name: "utf-8", bytes: utf8 },
    { name: "utf-16le", bytes: Buffer.from(canary, "utf16le") },
    { name: "hex", bytes: Buffer.from(utf8.toString("hex"), "utf8") },
    { name: "hex-upper", bytes: Buffer.from(utf8.toString("hex").toUpperCase(), "utf8") },
  ];
  // base64 looks different depending on where the value starts in the stream: three alignments.
  for (let offset = 0; offset < 3; offset++) {
    const padded = Buffer.concat([Buffer.alloc(offset), utf8]);
    let text = padded.toString("base64").replace(/=+$/, "");
    // Characters that mix in the padding bytes before, or the unknown bytes after, are not the value's own.
    text = text.slice(Math.ceil((offset * 8) / 6));
    if (padded.length % 3 !== 0) text = text.slice(0, -1);
    if (text.length >= 8) out.push({ name: offset === 0 ? "base64" : `base64+${offset}`, bytes: Buffer.from(text, "utf8") });
  }
  return out;
}

/** The bytes of one file against every encoding of every canary. */
export function scanBuffer(bytes: Buffer, canaries: string[], sink: string, path: string): FileHit[] {
  const hits: FileHit[] = [];
  for (const canary of canaries) {
    for (const { name, bytes: needle } of encodings(canary)) {
      if (needle.length > 0 && bytes.includes(needle)) {
        hits.push({ sink, path, encoding: name, canary });
        break; // one hit per canary per file is enough to fail it
      }
    }
  }
  return hits;
}

/**
 * One file against every canary. A file that cannot be statted or read, or is over the size limit, is not
 * scanned: it is recorded in `skipped` (with the reason) so the caller can refuse to call the scan clean.
 */
export function scanFile(path: string, canaries: string[], sink: string, root?: string, skipped: string[] = []): FileHit[] {
  let size: number;
  try {
    size = statSync(path).size;
  } catch (error) {
    skipped.push(`${path}: cannot stat (${(error as NodeJS.ErrnoException).code ?? "error"})`);
    return [];
  }
  if (size > maxFileBytes()) {
    skipped.push(`${path}: larger than ${maxFileBytes()} bytes`);
    return [];
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    skipped.push(`${path}: cannot read (${(error as NodeJS.ErrnoException).code ?? "error"})`);
    return [];
  }
  return scanBuffer(bytes, canaries, sink, root ? relative(root, path) || path : path);
}

/** Every file under `dir`, found without following links out of it. A folder that cannot be listed is recorded in `skipped`. */
export function walkFiles(dir: string, skipped: string[] = []): string[] {
  const files: string[] = [];
  const visit = (current: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (error) {
      skipped.push(`${current}: cannot list (${(error as NodeJS.ErrnoException).code ?? "error"})`);
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  visit(dir);
  return files;
}

/** What the file is, for the report: the vault, the database and its journal, a log, a frame capture, or any other file. */
function classify(path: string, home: string, known: { vault?: string; db?: string; frames?: string }): string {
  const abs = resolve(path);
  if (known.vault && abs === resolve(known.vault)) return "vault";
  if (known.frames && abs === resolve(known.frames)) return "frame-log";
  if (known.db && [known.db, `${known.db}-wal`, `${known.db}-shm`, `${known.db}-journal`].some((candidate) => abs === resolve(candidate))) return "database";
  const rel = relative(home, abs).replaceAll("\\", "/");
  if (/\.(sqlite3?|db)(-wal|-shm|-journal)?$/.test(rel)) return "database";
  if (/(^|\/)logs?\//.test(rel) || /\.log$/.test(rel)) return "log";
  if (/(^|\/)vault[^/]*$/.test(rel)) return "vault";
  return "file";
}

function parseArgs(argv: string[]): Map<string, string | true> {
  const flags = new Map<string, string | true>();
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq < 0) flags.set(arg.slice(2), true);
    else flags.set(arg.slice(2, eq), arg.slice(eq + 1));
  }
  return flags;
}

const mask = (canary: string): string => `${canary.slice(0, 4)}… (${canary.length} characters)`;

async function main(): Promise<number> {
  const flags = parseArgs(process.argv.slice(2));
  const text = (name: string): string | undefined => {
    const value = flags.get(name);
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const secretsMode = flags.get("secrets") === true;

  const canaries = (text("canary") ?? process.env.AGNI_CANARY ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (canaries.length === 0) {
    console.error("no canaries given — set AGNI_CANARY or pass --canary=one,two");
    return 2;
  }
  const short = canaries.filter((canary) => canary.length < MIN_CANARY_LENGTH);
  if (secretsMode && short.length > 0) {
    console.error(`a canary must be at least ${MIN_CANARY_LENGTH} characters, or the scan matches noise`);
    return 2;
  }

  const home = text("home") ?? process.env.AGNI_HOME?.trim();
  if (secretsMode && !home) {
    console.error("--secrets needs the home to scan: set AGNI_HOME or pass --home=DIR");
    return 2;
  }
  const homeDir = home ? resolve(home) : undefined;
  const vault = text("vault") ?? (homeDir ? join(homeDir, "vault.bin") : undefined);
  const dbPath = text("db") ?? process.env.AGNI_DB_PATH?.trim() ?? (homeDir ? join(homeDir, "data", "agni.sqlite") : "data/agni.sqlite");
  const logPath = text("log") ?? process.env.AGNI_LOG_PATH?.trim() ?? (homeDir ? join(homeDir, "logs", "agni.log") : "data/agni.log");
  const frames = text("frames") ?? process.env.AGNI_FRAME_LOG?.trim();

  // A source the caller named must exist: a scan that quietly looks at nothing is a false pass.
  if (text("frames") && !existsSync(text("frames")!)) {
    console.error(`the frame log ${text("frames")} does not exist`);
    return 2;
  }
  if (text("vault") && !existsSync(text("vault")!)) {
    console.error(`the vault file ${text("vault")} does not exist`);
    return 2;
  }
  if (flags.get("require-vault") === true && !(vault && existsSync(vault))) {
    console.error(`--require-vault: there is no vault file${vault ? ` at ${vault}` : ""}`);
    return 2;
  }

  const textHits: CanaryHit[] = [];
  const fileHits: FileHit[] = [];

  // --- 1. the model-visible sinks, as before ---------------------------------
  const legacy = !secretsMode || existsSync(dbPath);
  if (legacy) {
    const db = openDatabaseReadOnly(dbPath);
    try {
      textHits.push(...scanDatabaseForCanaries(db, canaries));
    } finally {
      db.close();
    }
  }
  if (existsSync(logPath)) textHits.push(...scanTextForCanaries(readFileSync(logPath, "utf8"), canaries));

  // --- 2. raw bytes of the named sources, and (secrets mode) all of the home ---
  const known = { ...(vault ? { vault } : {}), db: dbPath, ...(frames ? { frames } : {}) };
  const seen = new Set<string>();
  const skipped: string[] = [];
  // `optional`: a named source that may not exist (the database's write-ahead log). A file the walk found must be scannable.
  const scan = (path: string, sink: string, optional = true): void => {
    const abs = resolve(path);
    if (seen.has(abs) || (optional && !existsSync(abs))) return;
    seen.add(abs);
    fileHits.push(...scanFile(abs, canaries, sink, homeDir, skipped));
  };
  if (vault) scan(vault, "vault");
  if (frames) scan(frames, "frame-log");
  if (secretsMode) {
    for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) scan(path, "database");
    if (existsSync(logPath)) scan(logPath, "log");
    if (homeDir) for (const path of walkFiles(homeDir, skipped)) scan(path, classify(path, homeDir, known), false);
  }

  const total = textHits.length + fileHits.length;
  if (skipped.length > 0) {
    console.error(`${skipped.length} file(s) or folder(s) could not be scanned${total === 0 ? ", so this scan cannot say the home is clean" : ""}:`);
    for (const reason of skipped) console.error(`  skipped ${reason}`);
    if (total === 0) return 2;
  }
  if (total === 0) {
    const where = secretsMode ? `anywhere under ${homeDir}, in the log or in the frame capture` : "in any model-visible sink";
    console.log(`clean — ${canaries.length} canary string(s) found ${where}`);
    return 0;
  }

  const show = (canary: string): string => (secretsMode ? mask(canary) : `"${canary}"`);
  console.error(`LEAK — ${total} hit(s) for ${canaries.length} canary string(s):`);
  for (const hit of textHits) console.error(`  ${hit.sink} ${hit.rowID} (${hit.column}) contains ${show(hit.canary)}`);
  for (const hit of fileHits) {
    const extra = hit.sink === "vault" ? " — the vault holds the value in plaintext, so it is not encrypted" : "";
    console.error(`  ${hit.sink} ${hit.path} (${hit.encoding}) contains ${show(hit.canary)}${extra}`);
  }
  return 1;
}

if (import.meta.main) process.exit(await main());
