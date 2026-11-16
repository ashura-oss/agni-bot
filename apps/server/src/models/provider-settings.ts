/** Persist provider credentials on the daemon host and refresh its live router. */
import { mkdir, readFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { providerConfigPath } from "./providers";
import { homePath } from "../home";
import { entryName, rememberSecrets, vaultForWrites } from "../credentials/vault-mode";
import { baseUrlCarriesCredential, sanitizeBaseUrl } from "../credentials/provider-urls";
import { VaultError } from "../secrets/types";
import { PrivateFileError, writePrivateFile } from "../util/private-file";
import {
  checkCustomBaseUrl,
  loadCustomProviders,
  loadProviders,
  nextCustomProviderID,
  providerCredentialTarget,
  type BaseUrlRefusal,
  type CustomProviderEntry,
} from "./providers";
import type { Router } from "./router";

export type AddProviderResult =
  | { ok: true; providers: ReturnType<Router["status"]> }
  | { ok: false; code: "unknown_provider" | "invalid_key" | "provider_exists" | "provider_storage"; message: string };

/** What the app sends when it adds an endpoint of its own. */
export interface CustomProviderInput {
  baseUrl?: string;
  label?: string;
}

/**
 * The API key arrives only over the authenticated socket. It is never returned
 * to the client, and it is applied to the live router without restarting the
 * process. Where it is kept depends on the secrets mode (S3-02): in file mode
 * the daemon's .env with mode 0600; in vault mode the vault (`env/<VARIABLE>`),
 * and never a plaintext file, so a locked vault refuses the save. Either way
 * the key is registered for redaction as soon as it is accepted.
 *
 * A custom endpoint also needs somewhere to live: its URL, label and model are
 * written to the provider config file, and its key as above under a variable
 * the entry names.
 */
export async function addProviderCredential(
  router: Router,
  providerID: string,
  rawKey: string,
  model?: string,
  custom?: CustomProviderInput,
): Promise<AddProviderResult> {
  const apiKey = rawKey.trim();
  if (!apiKey || apiKey.length > 4096 || /[\u0000\r\n]/.test(apiKey)) {
    return { ok: false, code: "invalid_key", message: "Enter a valid API key." };
  }
  rememberSecrets(apiKey);
  if (providerID === "custom") {
    return addCustomProvider(router, apiKey, model, custom);
  }
  const target = providerCredentialTarget(providerID);
  if (!target) {
    return { ok: false, code: "unknown_provider", message: "Choose a supported API provider." };
  }
  if (router.status().some((provider) => provider.id === target.id)) {
    return { ok: false, code: "provider_exists", message: `${target.label} is already configured.` };
  }

  try {
    await saveProviderKey(target.envKey, apiKey);
    // Bun.env is the environment map used by the rest of this process.
    Bun.env[target.envKey] = apiKey;
    if (model?.trim()) await saveProviderModel(providerID, validateModel(model));
    router.replaceProviders(loadProviders(Bun.env));
    return { ok: true, providers: router.status() };
  } catch (error) {
    // Do not include the key or filesystem content in the response/log path.
    return { ok: false, code: "provider_storage", message: storageMessage(error, "Could not save the provider key on the daemon.") };
  }
}

/**
 * Keep one provider key where the secrets mode says (see the note above).
 * Vault mode: store it as `env/<VARIABLE>`, the entry start-up turns back into
 * an environment variable, and read it back before reporting success. File
 * mode: update config.env atomically and owner-only.
 */
async function saveProviderKey(envKey: string, apiKey: string): Promise<void> {
  const vault = vaultForWrites();
  if (vault) {
    const name = entryName.env(envKey);
    vault.set(name, apiKey);
    if (vault.get(name) !== apiKey) throw new VaultError("WRITE_FAILED", "The key could not be read back from the vault, so it was not saved.");
    return;
  }
  const envPath = homePath("config.env");
  const temporaryPath = `${envPath}.${randomUUID()}.tmp`;
  try {
    await writeEnvFile(envPath, temporaryPath, await writeEnvValues(envPath, { [envKey]: apiKey }));
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

/** Add an endpoint of the owner's own: any OpenAI-compatible chat/completions. */
async function addCustomProvider(
  router: Router,
  apiKey: string,
  model?: string,
  custom?: CustomProviderInput,
): Promise<AddProviderResult> {
  // Settings cannot say "this endpoint is on my private network"; that is an owner's edit of providers.json.
  const verdict = checkCustomBaseUrl(custom?.baseUrl ?? "");
  if (!verdict.ok) return { ok: false, code: "unknown_provider", message: endpointRefusal(verdict.reason) };
  const baseUrl = verdict.url;
  const label = (custom?.label ?? "").trim() || defaultCustomLabel(baseUrl);
  const existing = loadCustomProviders(Bun.env);
  const id = nextCustomProviderID(existing);
  const envKey = nextCustomEnvKey(existing);
  const entry: CustomProviderEntry = {
    id,
    label: label.slice(0, 64),
    baseUrl,
    model: model?.trim() ? validateModel(model) : "",
    envKey,
  };
  try {
    await saveProviderKey(envKey, apiKey);
    // An address with a credential in it is a secret too: the vault keeps it whole, the file a clean copy.
    const vault = vaultForWrites();
    if (vault && baseUrlCarriesCredential(baseUrl)) {
      rememberSecrets(baseUrl);
      vault.set(entryName.providerUrl(id), baseUrl);
      entry.baseUrl = sanitizeBaseUrl(baseUrl);
    }
    Bun.env[envKey] = apiKey;
    await saveCustomProvider(entry);
    router.replaceProviders(loadProviders(Bun.env));
    return { ok: true, providers: router.status() };
  } catch (error) {
    return { ok: false, code: "provider_storage", message: storageMessage(error, "Could not save the endpoint on the daemon.") };
  }
}

/** What to tell the owner when an endpoint URL is refused (S3-07). */
function endpointRefusal(reason: BaseUrlRefusal): string {
  if (reason === "scheme") return "Use an https:// endpoint. Plain http is accepted only for localhost.";
  if (reason === "private") {
    return 'That address is on a private network. Agni only connects to private endpoints marked "local": true in providers.json; add the entry there by hand.';
  }
  return "Enter the endpoint URL, for example https://host/v1.";
}

/** The host of the endpoint, as a name to show in the list. */
function defaultCustomLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "Custom endpoint";
  }
}

/** The next free env variable name for a custom endpoint's key. */
function nextCustomEnvKey(existing: CustomProviderEntry[]): string {
  const used = new Set(existing.map((entry) => entry.envKey));
  for (let index = 1; index < 1000; index += 1) {
    const candidate = `AGNI_CUSTOM_KEY_${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `AGNI_CUSTOM_KEY_${Date.now()}`;
}


export async function setProviderModel(router: Router, providerID: string, rawModel: string): Promise<AddProviderResult> {
  if (!router.status().some((provider) => provider.id === providerID)) {
    return { ok: false, code: "provider_exists", message: "Add this provider before changing its model." };
  }
  let model: string;
  try { model = validateModel(rawModel); } catch (error) {
    return { ok: false, code: "invalid_key", message: error instanceof Error ? error.message : "Enter a valid model ID." };
  }
  try {
    await saveProviderModel(providerID, model);
    router.replaceProviders(loadProviders(Bun.env));
    return { ok: true, providers: router.status() };
  } catch (error) {
    return { ok: false, code: "provider_storage", message: storageMessage(error, "Could not save the model setting on the daemon.") };
  }
}

/**
 * Why a save failed, in words the owner can act on. A file that could not be
 * made private, or a vault that is locked or cannot be written, is named;
 * anything else keeps the generic text so no key or filesystem detail reaches
 * the client.
 */
function storageMessage(error: unknown, generic: string): string {
  // Vault errors are written to be shown to the owner and never hold a secret.
  return error instanceof PrivateFileError || error instanceof VaultError ? error.message : generic;
}

/** Read the .env file, or an empty one when it does not exist yet. */
async function readEnvContents(envPath: string): Promise<string> {
  try {
    return await readFile(envPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  }
}

/** The .env contents with these keys set, added or replaced. */
async function writeEnvValues(envPath: string, values: Record<string, string>): Promise<string> {
  return updateEnv(await readEnvContents(envPath), values);
}

/**
 * Write the .env file atomically, owner-only, so a key is never half-written
 * or readable by anyone else. Mode 600 on POSIX; on Windows an owner-only ACL
 * is set on the empty temporary file before the key goes into it. If that
 * fails, the key is not written (fail closed).
 */
async function writeEnvFile(envPath: string, temporaryPath: string, contents: string): Promise<void> {
  await mkdir(dirname(envPath), { recursive: true, mode: 0o700 });
  await writePrivateFile(envPath, contents, temporaryPath);
}

async function saveProviderModel(providerID: string, model: string): Promise<void> {
  const path = providerConfigPath();
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  let models: Record<string, string> = {};
  let custom: CustomProviderEntry[] = [];
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as { version?: unknown; models?: unknown; custom?: unknown };
    if (value.version === 1 && value.models && typeof value.models === "object" && !Array.isArray(value.models)) {
      models = Object.fromEntries(Object.entries(value.models).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    }
    if (Array.isArray(value.custom)) {
      custom = value.custom.filter(
        (entry): entry is CustomProviderEntry =>
          !!entry && typeof entry === "object" && typeof (entry as CustomProviderEntry).id === "string",
      );
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw new Error("The provider config file is invalid or unreadable.");
    }
  }
  models[providerID] = model;
  await writeProviderConfig(path, temporaryPath, { models, custom });
}

/** Store a custom endpoint next to the chosen models. */
async function saveCustomProvider(entry: CustomProviderEntry): Promise<void> {
  const path = providerConfigPath();
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  let models: Record<string, string> = {};
  let custom: CustomProviderEntry[] = [];
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as { version?: unknown; models?: unknown; custom?: unknown };
    if (value.version === 1 && value.models && typeof value.models === "object" && !Array.isArray(value.models)) {
      models = Object.fromEntries(Object.entries(value.models).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    }
    if (Array.isArray(value.custom)) {
      custom = value.custom.filter(
        (item): item is CustomProviderEntry =>
          !!item && typeof item === "object" && typeof (item as CustomProviderEntry).id === "string",
      );
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw new Error("The provider config file is invalid or unreadable.");
    }
  }
  const existing = custom.findIndex((item) => item.id === entry.id);
  if (existing >= 0) custom[existing] = entry;
  else custom.push(entry);
  await writeProviderConfig(path, temporaryPath, { models, custom });
}

async function writeProviderConfig(
  path: string,
  temporaryPath: string,
  value: { models: Record<string, string>; custom: CustomProviderEntry[] },
): Promise<void> {
  const body = `${JSON.stringify({ version: 1, models: value.models, custom: value.custom }, null, 2)}\n`;
  try {
    // Owner-only like config.env: it can name a custom endpoint, and may sit
    // outside AGNI_HOME when AGNI_PROVIDER_CONFIG_PATH points elsewhere.
    await writePrivateFile(path, body, temporaryPath);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

function validateModel(raw: string): string {
  const model = raw.trim();
  if (!model || model.length > 200 || /[\u0000\r\n]/.test(model)) throw new Error("Enter a model ID up to 200 characters.");
  return model;
}

function updateEnv(contents: string, values: Record<string, string>): string {
  let next = contents;
  for (const [key, value] of Object.entries(values)) {
    const assignment = `${key}=${JSON.stringify(value)}`;
    const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=.*$`, "m");
    next = pattern.test(next) ? next.replace(pattern, () => assignment) : `${next}${next.length > 0 && !next.endsWith("\n") ? "\n" : ""}${assignment}\n`;
  }
  return next;
}
