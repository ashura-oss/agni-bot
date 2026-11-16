/**
 * One answer to "is this setting name a secret?". Shared by the shell scrub
 * (Sprint 2) and by vault import, `loadHomeEnv`, plaintext checks and
 * redaction (Sprint 3).
 *
 * The rule is: when unsure, treat it as a secret. A name is plaintext-safe
 * only if it is on `KNOWN_NON_SECRET_SETTINGS` (each one read from the code)
 * or is a public key. Anything else, including a name nobody has heard of, is
 * a secret. Adding a setting to the list is the only way to let one stay in
 * plaintext, and each entry should be checked against the code that reads it.
 */

/**
 * Settings that are safe in plaintext: paths, ports, origins, timeouts,
 * budgets, switches, model names and endpoint URLs. None holds a credential.
 * Names are upper case; lookups upper-case the input.
 *
 * Sources: `config.ts`, `home.ts`, `log.ts`, `models/providers.ts` (the
 * `envModel` / `envBaseUrl` names), `agent/embeddings.ts`, `tools/web.ts`,
 * `tools/write-file.ts`, `share/document.ts`, `ws/web-app.ts`,
 * `models/chatgpt-auth.ts`, `jobs/turn.ts`, the CLI (`AGNI_URL`) and
 * `infra/env.example`. `AGNI_SECRETS_MODE` and `AGNI_SHELL_EXTRA_PATH` are
 * named by the Sprint 2 and 3 specs; their readers land in those sprints.
 */
export const KNOWN_NON_SECRET_SETTINGS: ReadonlySet<string> = new Set([
  // Server and network.
  "AGNI_HOME",
  "AGNI_HOST",
  "AGNI_PORT",
  "AGNI_DEV",
  "AGNI_TZ",
  "AGNI_ALLOWED_ORIGINS",
  "AGNI_PUBLIC_ORIGIN",
  "AGNI_URL",
  "AGNI_LOG_LEVEL",
  "AGNI_CHATGPT",
  "AGNI_USER_FIRST_NAME",
  // Paths.
  "AGNI_DB_PATH",
  "AGNI_PID_PATH",
  "AGNI_LOG_PATH",
  "AGNI_PLUGINS_PATH",
  "AGNI_PROVIDER_CONFIG_PATH",
  "AGNI_SCRATCH_DIR",
  "AGNI_SHARE_DIR",
  "AGNI_WEB_DIR",
  "AGNI_BACKUP_DIR",
  "AGNI_SHELL_EXTRA_PATH",
  // Backups, timeouts, concurrency, budgets.
  "AGNI_BACKUP_KEEP",
  "AGNI_HELLO_TIMEOUT_MS",
  "AGNI_FIRST_TOKEN_TIMEOUT_MS",
  "AGNI_TURN_TIMEOUT_MS",
  "AGNI_FRAME_LOG_CAPACITY",
  "AGNI_JOB_POLL_MS",
  "AGNI_JOB_CONCURRENCY",
  "AGNI_MAX_CONCURRENT_TURNS",
  "AGNI_MAX_BG_TURNS_PER_DAY",
  "AGNI_MAX_OUTPUT_TOKENS",
  // Context and memory tuning.
  "AGNI_MIN_RECALL_SCORE",
  "AGNI_SLOT_PINNED_CORE",
  "AGNI_SLOT_ANCHOR",
  "AGNI_SLOT_LEDGER",
  "AGNI_SLOT_SUMMARIES",
  "AGNI_SLOT_RECALL",
  "AGNI_SLOT_PREVIOUS_TAIL",
  // Embeddings, vision and search endpoints.
  "AGNI_EMBEDDING_BASE_URL",
  "AGNI_EMBEDDING_MODEL",
  "AGNI_OLLAMA_BASE_URL",
  "AGNI_OLLAMA_EMBED_MODEL",
  "AGNI_VISION_MODELS",
  "AGNI_SEARXNG_URL",
  "AGNI_FIRECRAWL_URL",
  // How secrets are stored (the mode, never a secret itself).
  "AGNI_SECRETS_MODE",
  // Catalog provider model names and endpoint overrides (`models/providers.ts`).
  "GROQ_MODEL",
  "GROQ_BASE_URL",
  "CEREBRAS_MODEL",
  "CEREBRAS_BASE_URL",
  "NIM_MODEL",
  "NVIDIA_BASE_URL",
  "GEMINI_MODEL",
  "GEMINI_BASE_URL",
  "OPENROUTER_MODEL",
  "OPENROUTER_BASE_URL",
  "LMSTUDIO_MODEL",
  "LMSTUDIO_BASE_URL",
]);

/**
 * Names that carry a secret by shape. Case-insensitive. `API_KEY`, `SECRET`
 * (so `SECRET_ACCESS_KEY` too), `PRIVATE_KEY`, `PASSWORD`, `PASSPHRASE`,
 * `CREDENTIAL(S)` and `AUTH` match as whole word parts anywhere in the name.
 * `TOKEN` matches only at the end (optionally followed by digits), so
 * `AGNI_FIRST_TOKEN_TIMEOUT_MS` stays a timeout. `AGNI_CUSTOM_KEY_<n>` is the
 * default variable of a custom endpoint. `PUBLIC_KEY` does not match.
 */
export const SECRET_NAME_PATTERN =
  /(?:^|_)(?:API_KEY|SECRET|PRIVATE_KEY|PASSWORD|PASSPHRASE|CREDENTIALS?|AUTH)(?:_|$)|(?:^|_)TOKEN\d*$|^AGNI_CUSTOM_KEY_/i;

/** A public key is public by definition; this is the one shape exempt from "unknown is secret". */
const PUBLIC_KEY_NAME = /(?:^|_)PUBLIC_KEY$/i;

export interface SecretNameExtras {
  /** Variables that carry a catalog provider's key, such as `providerKeyEnvNames()`. */
  providerEnvNames?: Iterable<string>;
  /** Variables the owner's custom endpoints name for their keys (`providers.json`). */
  customEnvKeys?: Iterable<string>;
}

function inList(upper: string, list: Iterable<string> | undefined): boolean {
  if (!list) return false;
  for (const entry of list) if (entry.toUpperCase() === upper) return true;
  return false;
}

/**
 * True when `name` must be treated as a secret: it is in one of the extra
 * lists, matches `SECRET_NAME_PATTERN`, or is not a known plaintext-safe
 * setting (unknown means secret). False only for a known setting or a public
 * key that carries no secret word.
 */
export function isSecretSettingName(name: string, extra?: SecretNameExtras): boolean {
  const upper = name.trim().toUpperCase();
  if (inList(upper, extra?.providerEnvNames) || inList(upper, extra?.customEnvKeys)) return true;
  if (SECRET_NAME_PATTERN.test(upper)) return true;
  if (PUBLIC_KEY_NAME.test(upper)) return false;
  return !KNOWN_NON_SECRET_SETTINGS.has(upper);
}

/**
 * Whether a variable must be kept out of a child process. Same predicate as
 * `isSecretSettingName`: children only get allowlisted names, so this is for
 * scrub checks that confirm nothing secret slipped through.
 */
export function isSecretEnvForChild(name: string, extra?: SecretNameExtras): boolean {
  return isSecretSettingName(name, extra);
}
