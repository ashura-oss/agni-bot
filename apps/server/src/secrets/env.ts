/**
 * The bridge between `config.env` (the old plaintext home of provider keys and
 * other credentials) and the vault: entries `env/<NAME>` in the vault stand
 * for variable NAME. Used by start-up (fill `process.env` from the vault), by
 * `agni vault migrate` (move the secrets in) and `agni vault export` (move them
 * back, for rollback).
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseEnvFile } from "../home";
import { writePrivateFileSync } from "../util/private-file";
import { envEntryName, isSecretEnvName } from "./mode";
import { VaultError, type Vault } from "./types";

const ENV_PREFIX = "env/";

/** Copy the vault's `env/<NAME>` entries into `env` for variables that are not set. Returns the names set. */
export function applyVaultEnv(env: Record<string, string | undefined>, vault: Vault): string[] {
  const applied: string[] = [];
  for (const { name } of vault.list(ENV_PREFIX)) {
    const variable = name.slice(ENV_PREFIX.length);
    if (env[variable]) continue;
    const value = vault.get(name);
    if (value === undefined) continue;
    env[variable] = value;
    applied.push(variable);
  }
  return applied;
}

/** Names of credentials still in a plaintext env file with a value. Never values. */
export function plaintextSecretNames(envFile: string, isSecret: (name: string) => boolean = isSecretEnvName): string[] {
  if (!existsSync(envFile)) return [];
  return Object.entries(parseEnvFile(readFileSync(envFile, "utf8")))
    .filter(([name, value]) => value !== "" && isSecret(name))
    .map(([name]) => name);
}

const lineFor = (name: string): RegExp => new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);

function quoted(value: string): string {
  if (value !== "" && !/[\s#"']/.test(value)) return value;
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  throw new VaultError("INVALID_ENTRY", "A value holding both quote characters cannot be written to config.env.");
}

/** `text` without the lines that set any of `names`. */
function withoutLines(text: string, names: string[]): string {
  const patterns = names.map(lineFor);
  return text.split(/\r?\n/).filter((line) => !patterns.some((pattern) => pattern.test(line))).join("\n");
}

/**
 * Set variables in an env file, replacing an existing line or appending one,
 * and keeping every other line and comment. Written owner-only and atomically.
 */
export function setEnvFileValues(envFile: string, values: Record<string, string>): void {
  const text = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
  const lines = text === "" ? [] : text.replace(/\r?\n$/, "").split(/\r?\n/);
  for (const [name, value] of Object.entries(values)) {
    const line = `${name}=${quoted(value)}`;
    const at = lines.findIndex((existing) => lineFor(name).test(existing));
    if (at >= 0) lines[at] = line;
    else lines.push(line);
  }
  mkdirSync(dirname(envFile), { recursive: true, mode: 0o700 });
  writePrivateFileSync(envFile, `${lines.join("\n")}\n`);
}

/**
 * Move every credential in an env file into the vault as `env/<NAME>`.
 *  1. back the file up (owner-only) in `backupDir`;
 *  2. store each value and read it back;
 *  3. only then remove those lines from the file.
 * Any failure before step 3 leaves the file untouched. A second run finds
 * nothing to move. A value in the file replaces one already in the vault: the
 * file is the older store, so a value there means the owner just put it there.
 * Returns the names moved.
 */
export function importEnvFileSecrets(vault: Vault, envFile: string, backupDir: string, isSecret: (name: string) => boolean = isSecretEnvName): string[] {
  if (!existsSync(envFile)) return [];
  const text = readFileSync(envFile, "utf8");
  const names = Object.entries(parseEnvFile(text)).filter(([name, value]) => value !== "" && isSecret(name));
  if (names.length === 0) return [];
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  writePrivateFileSync(`${backupDir}/config.env`, text);
  for (const [name, value] of names) {
    vault.set(envEntryName(name), value);
    if (vault.get(envEntryName(name)) !== value) throw new VaultError("WRITE_FAILED", `${name} could not be read back from the vault, so config.env was not changed.`);
  }
  writePrivateFileSync(envFile, withoutLines(text, names.map(([name]) => name)));
  return names.map(([name]) => name);
}

/** Rollback: write every `env/<NAME>` entry back into the env file as plaintext. Returns the count. */
export function exportEnvEntries(vault: Vault, envFile: string): number {
  const values: Record<string, string> = {};
  for (const { name } of vault.list(ENV_PREFIX)) {
    const value = vault.get(name);
    if (value !== undefined) values[name.slice(ENV_PREFIX.length)] = value;
  }
  if (Object.keys(values).length > 0) setEnvFileValues(envFile, values);
  return Object.keys(values).length;
}
