import { loadCustomProviders, loadProviders, providerKeyEnvNames } from "../models/providers";

/**
 * Names of environment variables that hold a secret. The server's environment
 * carries the provider keys (loaded from config.env), and a command the model
 * writes, such as `env` or `echo $OPENROUTER_API_KEY`, would read them.
 *
 * The catalog's own key variables come from `providerKeyEnvNames()`, so a new
 * provider is covered whatever its variable is called; the suffixes below stay
 * as the net for everything else (a key the owner exported by hand). Custom
 * endpoints name their own variable (default `AGNI_CUSTOM_KEY_<n>`): the
 * prefix is matched here and any other name comes from the provider config.
 */
const SECRET_NAME_PATTERNS: RegExp[] = [
  /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD)$/i,
  /(?:^|_)(?:SECRET_ACCESS_KEY|PRIVATE_KEY)$/i,
  /^AGNI_CUSTOM_KEY_/i,
];
/** A key shorter than this is not worth matching by value (a stray "1" or "abc"). */
const MIN_SECRET_VALUE_LENGTH = 8;

/**
 * The environment a shell child gets: the parent's, minus secrets.
 *
 * Removed: any variable whose name matches `SECRET_NAME_PATTERNS`, the
 * variable each custom endpoint names in the provider config, and any variable
 * holding the same value as a configured provider key (a copy under another
 * name). PATH, HOME/USERPROFILE, SystemRoot, TEMP and everything else stay.
 *
 * If the provider config cannot be read the name patterns still apply, so a
 * broken file never makes the scrub weaker than its default.
 */
export function scrubbedShellEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const secretNames = new Set<string>(providerKeyEnvNames().map((name) => name.toUpperCase()));
  const secretValues = new Set<string>();
  try {
    for (const entry of loadCustomProviders(env)) secretNames.add(entry.envKey.toUpperCase());
    for (const provider of loadProviders(env)) {
      if (provider.apiKey.length >= MIN_SECRET_VALUE_LENGTH) secretValues.add(provider.apiKey);
    }
  } catch {
    // Fall back to the name patterns alone.
  }
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (SECRET_NAME_PATTERNS.some((pattern) => pattern.test(name))) continue;
    if (secretNames.has(name.toUpperCase())) continue;
    if (value.trim().length >= MIN_SECRET_VALUE_LENGTH && secretValues.has(value.trim())) continue;
    kept[name] = value;
  }
  return kept;
}
