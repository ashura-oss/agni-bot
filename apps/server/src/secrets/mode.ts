/**
 * Pure helpers with no imports, so `home.ts` can use them without a cycle.
 */
import type { SecretsMode } from "./types";

/** `AGNI_SECRETS_MODE`: `vault` or `file`. `file` (the old plaintext `config.env`) stays the default until S3-3 flips it. */
export function secretsMode(env: Record<string, string | undefined> = process.env): SecretsMode {
  return env.AGNI_SECRETS_MODE?.trim().toLowerCase() === "vault" ? "vault" : "file";
}

const SECRET_NAME = /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|PRIVATE_KEY)$/i;

/**
 * True for a `config.env` variable that holds a credential: `GROQ_API_KEY`,
 * `GOOGLE_OAUTH_CLIENT_SECRET`, `GMAIL_APP_PASSWORD`, `AGNI_TOKEN`. Names with
 * PUBLIC in them (a public key) and the passphrase *file* path are not secrets.
 * A provider with an unusual name is added by the caller (`providerKeyEnvNames()`).
 */
export function isSecretEnvName(name: string): boolean {
  return !/PUBLIC/i.test(name) && SECRET_NAME.test(name);
}

/** Vault entry name for an environment variable. */
export const envEntryName = (name: string): string => `env/${name}`;
