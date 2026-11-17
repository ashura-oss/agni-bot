/**
 * What `agni setup` needs to decide the secrets mode of a home: is a mode already recorded, and is the home fresh
 * (made just now, holding nothing that depends on the mode it was made in)? Read-only; nothing here opens the vault.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnvFile } from "../home";
import { secretClassifier } from "./classify";
import { plaintextSecretNames } from "./env";
import type { SecretsMode } from "./types";

type Env = Record<string, string | undefined>;

export interface RecordedMode {
  mode: SecretsMode;
  /** The process environment (the shell, or the service unit), or `config.env` in the home. */
  source: "environment" | "config.env";
}

const asMode = (value: string): SecretsMode => (value.trim().toLowerCase() === "vault" ? "vault" : "file");

/**
 * The mode someone chose for this home, or `undefined` when none did. The environment wins over `config.env`, as in
 * `loadHomeEnv`. Any non-empty value counts as a choice (a mistyped one reads as `file`, as `secretsMode` reads it).
 * `loadHomeEnv` copies `config.env` into the environment at start, so a value that matches the file is reported as
 * coming from the file: only a value the file does not hold came from the shell or the service unit.
 */
export function recordedSecretsMode(home: string, env: Env = process.env): RecordedMode | undefined {
  const path = join(home, "config.env");
  const inFile = existsSync(path) ? parseEnvFile(readFileSync(path, "utf8")).AGNI_SECRETS_MODE?.trim() : undefined;
  const fromEnv = env.AGNI_SECRETS_MODE?.trim();
  if (fromEnv) {
    const same = inFile !== undefined && inFile !== "" && asMode(inFile) === asMode(fromEnv);
    return { mode: asMode(fromEnv), source: same ? "config.env" : "environment" };
  }
  return inFile ? { mode: asMode(inFile), source: "config.env" } : undefined;
}

/**
 * True when nothing in `home` depends on the mode it was made in: no vault, no database, no plugin or provider file,
 * and no credential written in `config.env`. A `config.env` that is only the template (every key empty or commented)
 * does not count, because the installer writes that before `agni setup` runs. A home with a recorded mode is not
 * fresh: the owner's choice stands.
 */
export function homeIsFresh(home: string, env: Env = process.env): boolean {
  const keeps = [
    join(home, "vault.bin"),
    env.AGNI_DB_PATH?.trim() || join(home, "data", "agni.sqlite"),
    join(home, "agni.sqlite"),
    env.AGNI_PLUGINS_PATH?.trim() || join(home, "plugins.json"),
    env.AGNI_PROVIDER_CONFIG_PATH?.trim() || join(home, "providers.json"),
  ];
  if (keeps.some((path) => existsSync(path))) return false;
  if (recordedSecretsMode(home, env)) return false;
  return plaintextSecretNames(join(home, "config.env"), secretClassifier({ env, home })).length === 0;
}
