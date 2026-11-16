/**
 * The one place the vault decides "is this `config.env` setting a secret?".
 * It builds on the shared classifier in `util/secret-names.ts` (unknown names
 * are secret) and adds what only the vault knows:
 *
 *  - the providers' own variables: the catalog's (`providerKeyEnvNames()`) and
 *    the ones the owner's custom endpoints name in `providers.json`;
 *  - the VALUE: a URL carrying a user name or password, or a credential in its
 *    query string, is a secret even when its name is a plain setting;
 *  - the few settings the vault needs in order to OPEN, which must stay in
 *    plaintext (a vault cannot hold the path of the file that unlocks it).
 */
import { join } from "node:path";
import { agniHome } from "../home";
import { loadCustomProviders, providerKeyEnvNames } from "../models/providers";
import { isSecretSettingName, type SecretNameExtras } from "../util/secret-names";

type Env = Record<string, string | undefined>;

/**
 * Read before the vault opens, so they can never live in it. `AGNI_VAULT_PASSPHRASE_FILE`
 * has PASSPHRASE in its name but is only a path.
 */
const NEEDED_TO_OPEN_THE_VAULT: ReadonlySet<string> = new Set(["AGNI_HOME", "AGNI_SECRETS_MODE", "AGNI_KEYSTORE", "AGNI_VAULT_PASSPHRASE_FILE"]);

/** A query parameter name that carries a credential. Broad on purpose: a false positive only moves a value into the vault. */
const CREDENTIAL_PARAMETER = /key|token|secret|passw|pwd|sig|auth|credential/i;

/** True for a URL with `user:pass@` (or `user@`) in front of the host, or a credential-like query parameter. */
export function valueCarriesCredential(value: string): boolean {
  const text = value.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return false;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "") return true;
  for (const key of url.searchParams.keys()) if (CREDENTIAL_PARAMETER.test(key)) return true;
  return false;
}

/** Decides, for one `config.env` line, whether it belongs in the vault. `value` may be omitted when only the name is known. */
export type SecretClassifier = (name: string, value?: string) => boolean;

export interface SecretClassifierOptions {
  env?: Env;
  /** AGNI_HOME; where `providers.json` is read from. Default: from `env`. */
  home?: string;
}

/** The variables the owner's custom endpoints name for their keys. A missing or broken `providers.json` gives none. */
function customEnvKeys(env: Env, home: string): string[] {
  try {
    const path = env.AGNI_PROVIDER_CONFIG_PATH?.trim() || join(home, "providers.json");
    return loadCustomProviders({ ...env, AGNI_PROVIDER_CONFIG_PATH: path }).map((entry) => entry.envKey);
  } catch {
    return [];
  }
}

/**
 * Build the classifier for one home. Reads `providers.json` once, so build it
 * where it is used (start-up, a migration), not per variable.
 */
export function secretClassifier(options: SecretClassifierOptions = {}): SecretClassifier {
  const env = options.env ?? process.env;
  const home = options.home ?? agniHome(env);
  const extras: SecretNameExtras = { providerEnvNames: providerKeyEnvNames(), customEnvKeys: customEnvKeys(env, home) };
  return (name, value) => {
    if (NEEDED_TO_OPEN_THE_VAULT.has(name.trim().toUpperCase())) return false;
    if (value !== undefined && valueCarriesCredential(value)) return true;
    return isSecretSettingName(name, extras);
  };
}

/**
 * Classify one name with the default environment. For callers that have no
 * home to hand; prefer `secretClassifier()` when classifying several.
 */
export function isSecretEnvName(name: string, value?: string): boolean {
  return secretClassifier()(name, value);
}
