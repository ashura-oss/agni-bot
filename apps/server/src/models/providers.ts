import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { homePath } from "../home";
import { resolve } from "node:path";
import "../credentials/register"; // the vault's credential migrators; see that file for why it is imported here
import { entryName, vaultForReads } from "../credentials/vault-mode";
import { log } from "../log";
import { isPrivateAddress } from "../tools/fetch-url";

/**
 * Provider catalog — every source is OpenAI-compatible `chat/completions`,
 * enabled by the presence of its API key (except LM Studio, which is local).
 * Free-first per Blueprint v3 §8: the router orders providers around health,
 * failover on 429/timeout. Ordering here is only the default.
 *
 * A custom endpoint (a token router, a proxy, a self-hosted gateway) is not in
 * this list: it is described at runtime in the provider config file and points
 * at an OpenAI-compatible `/chat/completions`.
 */

export interface ProviderConfig {
  supportsVision?: boolean;
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** A user-supplied OpenAI-compatible endpoint. The key lives in the env. */
export interface CustomProviderEntry {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  /** The env variable that carries this endpoint's key. */
  envKey: string;
  /**
   * The owner's statement that this endpoint is on a private network (a LAN
   * model server, a tunnel). Without the literal `true`, a private, link-local
   * or metadata host is refused (S3-07). Edited by hand in providers.json:
   * Settings cannot set it.
   */
  local?: boolean;
}

interface ProviderSpec {
  id: string;
  label: string;
  baseUrl: string;
  /** Environment variable that carries the API key. LM Studio has none. */
  envKey: string | null;
  /** Optional env override for the endpoint (proxies, self-hosted, tests). */
  envBaseUrl?: string;
  envModel: string;
  model: string;
}

/** The id a custom endpoint takes when it is the first one. */
export const CUSTOM_PROVIDER_PREFIX = "custom";

const SPECS: ProviderSpec[] = [
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    envKey: "GROQ_API_KEY",
    envBaseUrl: "GROQ_BASE_URL",
    envModel: "GROQ_MODEL",
    model: "llama-3.1-8b-instant",
  },
  {
    id: "cerebras",
    label: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    envKey: "CEREBRAS_API_KEY",
    envBaseUrl: "CEREBRAS_BASE_URL",
    envModel: "CEREBRAS_MODEL",
    model: "llama3.1-8b",
  },
  {
    id: "nim",
    label: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    envKey: "NVIDIA_API_KEY",
    envBaseUrl: "NVIDIA_BASE_URL",
    envModel: "NIM_MODEL",
    model: "meta/llama-3.3-70b-instruct",
  },
  {
    id: "gemini",
    label: "Gemini (free tier)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    envKey: "GEMINI_API_KEY",
    envBaseUrl: "GEMINI_BASE_URL",
    envModel: "GEMINI_MODEL",
    model: "gemini-2.0-flash",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    envKey: "OPENROUTER_API_KEY",
    envBaseUrl: "OPENROUTER_BASE_URL",
    envModel: "OPENROUTER_MODEL",
    model: "meta-llama/llama-3.3-70b-instruct:free",
  },
  {
    id: "lmstudio",
    label: "LM Studio (local)",
    baseUrl: "http://127.0.0.1:1234/v1",
    envKey: null,
    envBaseUrl: "LMSTUDIO_BASE_URL",
    envModel: "LMSTUDIO_MODEL",
    model: "",
  },
];

/**
 * Every environment variable that carries a catalog provider's API key. The
 * shell scrub reads this, so a provider added to `SPECS` is covered the day it
 * is added, whatever its variable is called.
 */
export function providerKeyEnvNames(): string[] {
  return SPECS.flatMap((spec) => (spec.envKey ? [spec.envKey] : []));
}

/** Public metadata for the providers the authenticated app can configure. */
export function providerCredentialTarget(id: string): { id: string; label: string; envKey: string; envModel: string } | null {
  const spec = SPECS.find((candidate) => candidate.id === id);
  if (!spec || !spec.envKey) return null;
  return { id: spec.id, label: spec.label, envKey: spec.envKey, envModel: spec.envModel };
}

export function providerModelTarget(id: string): { id: string; envModel: string } | null {
  const spec = SPECS.find((candidate) => candidate.id === id && candidate.envKey !== null);
  return spec ? { id: spec.id, envModel: spec.envModel } : null;
}

/** The provider config file: chosen models plus the custom endpoints. */
export function providerConfigPath(env: Record<string, string | undefined> = Bun.env): string {
  return resolve(env.AGNI_PROVIDER_CONFIG_PATH?.trim() || homePath("providers.json"));
}

interface ProviderConfigFile {
  version?: unknown;
  models?: unknown;
  custom?: unknown;
}

/** Read the config file; a missing or invalid file is simply empty. */
export function readProviderConfigFile(path: string): ProviderConfigFile {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ProviderConfigFile;
  } catch {
    // Missing or invalid optional config falls back to environment defaults.
    return {};
  }
}

function customEntries(value: unknown): CustomProviderEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: CustomProviderEntry[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Partial<CustomProviderEntry>;
    if (typeof entry.id !== "string" || !entry.id) continue;
    if (typeof entry.baseUrl !== "string" || !entry.baseUrl) continue;
    if (typeof entry.envKey !== "string" || !entry.envKey) continue;
    entries.push({
      id: entry.id,
      label: typeof entry.label === "string" && entry.label ? entry.label : entry.id,
      baseUrl: entry.baseUrl,
      model: typeof entry.model === "string" ? entry.model : "",
      envKey: entry.envKey,
      ...(entry.local === true ? { local: true } : {}),
    });
  }
  return entries;
}

/** The custom endpoints the owner configured, in file order. */
export function loadCustomProviders(env: Record<string, string | undefined> = Bun.env): CustomProviderEntry[] {
  return customEntries(readProviderConfigFile(providerConfigPath(env)).custom);
}

/**
 * The next free id for a custom endpoint: `custom`, then `custom-2`, and so on.
 * Ids are stable once written, so the app can address an endpoint later.
 */
export function nextCustomProviderID(existing: CustomProviderEntry[]): string {
  const taken = new Set(existing.map((entry) => entry.id));
  if (!taken.has(CUSTOM_PROVIDER_PREFIX)) return CUSTOM_PROVIDER_PREFIX;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${CUSTOM_PROVIDER_PREFIX}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${CUSTOM_PROVIDER_PREFIX}-${Date.now()}`;
}

/** Why an endpoint URL is not acceptable. */
export type BaseUrlRefusal = "invalid" | "scheme" | "private";
export type BaseUrlVerdict = { ok: true; url: string } | { ok: false; reason: BaseUrlRefusal };

/** Hostnames that name a metadata service or a private network, not the internet. Lower case, no trailing dot. */
const PRIVATE_HOSTNAMES: ReadonlySet<string> = new Set(["metadata", "metadata.google.internal", "instance-data", "instance-data.ec2.internal"]);
const PRIVATE_SUFFIXES = [".local", ".internal", ".lan", ".home.arpa", ".localdomain", ".intranet", ".corp", ".private"];

/** The host of `url` without brackets, a trailing dot or capitals. */
function bareHost(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

/** This machine: `localhost`, `*.localhost`, `::1`, and 127.0.0.0/8 (URL parsing has already turned `127.1` and `2130706433` into dotted form). */
function isLoopbackHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
  return isIP(host) === 4 && host.startsWith("127.");
}

/**
 * A private network, link-local or metadata host (or an unqualified name, which can only mean the
 * local network). Loopback is checked before this. The check reads the host as written: a name
 * that resolves to a private address later is not seen here.
 */
function isPrivateHost(host: string): boolean {
  if (isIP(host) !== 0) return isPrivateAddress(host);
  if (PRIVATE_HOSTNAMES.has(host)) return true;
  if (PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  return !host.includes(".");
}

/**
 * The rule for a custom endpoint (S3-07), with the reason when it fails.
 *  - Only http and https URLs with a host are endpoints.
 *  - This machine may use either scheme.
 *  - A private-network, link-local or metadata host is refused unless the
 *    owner marked the entry `"local": true`; then either scheme works, because
 *    a model server on the LAN is usually plain http.
 *  - Any other host must be https: a key must not cross the internet in the clear.
 * The path is kept as given: gateways differ (`/v1`, `/openai/v1`, nothing at all).
 */
export function checkCustomBaseUrl(raw: string, options: { local?: boolean } = {}): BaseUrlVerdict {
  const value = raw.trim().replace(/\/+$/, "");
  if (!value || value.length > 500 || /[\s\u0000-\u001f]/.test(value)) return { ok: false, reason: "invalid" };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "invalid" };
  const host = bareHost(url);
  if (!host) return { ok: false, reason: "invalid" };
  if (isLoopbackHost(host)) return { ok: true, url: value };
  if (isPrivateHost(host)) return options.local === true ? { ok: true, url: value } : { ok: false, reason: "private" };
  if (url.protocol !== "https:") return { ok: false, reason: "scheme" };
  return { ok: true, url: value };
}

/** `checkCustomBaseUrl` for callers that only need the URL or nothing. */
export function validateCustomBaseUrl(raw: string, options: { local?: boolean } = {}): string | null {
  const verdict = checkCustomBaseUrl(raw, options);
  return verdict.ok ? verdict.url : null;
}

/** The name shown for a provider: OpenRouter says "(:free)" only while its configured model is one of the free ones. */
function labelFor(spec: ProviderSpec, model: string): string {
  return spec.id === "openrouter" && model.endsWith(":free") ? `${spec.label} (:free)` : spec.label;
}

/**
 * A custom endpoint's full address from the vault, when it was kept there (vault mode, vault open).
 * The file holds the same address with its credential taken out; if the owner has since pointed the
 * file at another host or path, that edit is newer and the vault's copy of the old address is not used.
 */
function vaultBaseUrl(providerID: string, fileUrl: string): string | undefined {
  try {
    const full = vaultForReads()?.get(entryName.providerUrl(providerID));
    if (full === undefined) return undefined;
    const kept = new URL(full);
    const edited = new URL(fileUrl);
    const path = (url: URL): string => url.pathname.replace(/\/+$/, "");
    return kept.origin === edited.origin && path(kept) === path(edited) ? full : undefined;
  } catch {
    // An id the vault will not name, or an address that does not parse (a hand edit): there is no usable vault copy.
    return undefined;
  }
}

export function loadProviders(env: Record<string, string | undefined>): ProviderConfig[] {
  const modelConfigPath = providerConfigPath(env);
  const config = readProviderConfigFile(modelConfigPath);
  let configuredModels: Record<string, string> = {};
  if (config.version === 1 && config.models && typeof config.models === "object" && !Array.isArray(config.models)) {
    configuredModels = Object.fromEntries(
      Object.entries(config.models).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  }
  const providers: ProviderConfig[] = [];
  for (const spec of SPECS) {
    if (spec.envKey === null) {
      // Local provider: enabled by explicitly naming a model to serve.
      const model = (configuredModels[spec.id] || env[spec.envModel])?.trim();
      if (!model) continue;
      providers.push({
        id: spec.id,
        label: spec.label,
        baseUrl: (spec.envBaseUrl && env[spec.envBaseUrl]?.trim()) || spec.baseUrl,
        apiKey: "lm-studio", // LM Studio ignores auth but the header must exist.
        model,
      });
      continue;
    }
    const apiKey = env[spec.envKey]?.trim();
    if (!apiKey) continue;
    const model = (configuredModels[spec.id] || env[spec.envModel])?.trim() || spec.model;
    providers.push({
      id: spec.id,
      label: labelFor(spec, model),
      baseUrl: (spec.envBaseUrl && env[spec.envBaseUrl]?.trim()) || spec.baseUrl,
      apiKey,
      model,
    });
  }
  // Custom endpoints last: the free lanes come first, the owner's gateway is
  // the fallback that always answers.
  for (const entry of customEntries(config.custom)) {
    const apiKey = env[entry.envKey]?.trim();
    if (!apiKey) continue;
    const model = (configuredModels[entry.id] || entry.model).trim();
    if (!model) continue;
    // In vault mode an address that carries a credential is kept whole in the vault and the file holds
    // a clean copy. The file can also be edited by hand, so the endpoint rule holds here too (S3-07):
    // a refused endpoint never becomes a provider, and its key is never sent there.
    const baseUrl = vaultBaseUrl(entry.id, entry.baseUrl) ?? entry.baseUrl;
    const verdict = checkCustomBaseUrl(baseUrl, { local: entry.local });
    if (!verdict.ok) {
      log.warn(`provider ${entry.id}: endpoint not used (${verdict.reason === "private" ? 'a private-network host needs "local": true on its entry in providers.json' : verdict.reason === "scheme" ? "it must use https" : "it is not a valid http(s) URL"})`);
      continue;
    }
    providers.push({
      id: entry.id,
      label: entry.label,
      baseUrl,
      apiKey,
      model,
    });
  }
  const visionModels = new Set((env.AGNI_VISION_MODELS ?? "").split(",").map((model) => model.trim()).filter(Boolean));
  return providers.map((provider) => ({ ...provider, supportsVision: visionModels.has(provider.model) }));
}
