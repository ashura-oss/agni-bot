/**
 * Pure helpers with no imports, so `home.ts` can use them without a cycle.
 * Which names are secrets is decided in `classify.ts`.
 */
import type { SecretsMode } from "./types";

/** `AGNI_SECRETS_MODE`: `vault` or `file`. `file` (the old plaintext `config.env`) stays the default until S3-3 flips it. */
export function secretsMode(env: Record<string, string | undefined> = process.env): SecretsMode {
  return env.AGNI_SECRETS_MODE?.trim().toLowerCase() === "vault" ? "vault" : "file";
}

/** Vault entry name for an environment variable. */
export const envEntryName = (name: string): string => `env/${name}`;
