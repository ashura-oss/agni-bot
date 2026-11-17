/**
 * Pure helpers with no imports, so `home.ts` can use them without a cycle.
 * Which names are secrets is decided in `classify.ts`.
 */
import type { SecretsMode } from "./types";

/**
 * `AGNI_SECRETS_MODE`: `vault` or `file`. A value that is not `vault` reads as `file`, and so does no value at all:
 * a home with no mode recorded is one made before the vault existed, whose credentials are in `config.env`, so it
 * must not flip on its own (that would hide every key it has). The vault is the default for a *fresh* home because
 * `agni setup` chooses the mode when it makes the home and records `AGNI_SECRETS_MODE=vault` in `config.env`
 * (`cli/s3-setup.ts`), or `file` when the machine has no usable keystore. Doctor shows what is in force.
 */
export function secretsMode(env: Record<string, string | undefined> = process.env): SecretsMode {
  return env.AGNI_SECRETS_MODE?.trim().toLowerCase() === "vault" ? "vault" : "file";
}

/** Vault entry name for an environment variable. */
export const envEntryName = (name: string): string => `env/${name}`;
