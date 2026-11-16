/**
 * The shared secret-name classifier. Rule: when unsure, a name is a secret.
 * Only names on the known-non-secret list (and PUBLIC_KEY) are plaintext-safe.
 */
import { describe, expect, test } from "bun:test";
import { providerKeyEnvNames } from "../src/models/providers";
import {
  isSecretEnvForChild,
  isSecretSettingName,
  KNOWN_NON_SECRET_SETTINGS,
  SECRET_NAME_PATTERN,
} from "../src/util/secret-names";

describe("secret names: secrets", () => {
  test("every catalog provider key variable is a secret", () => {
    const names = providerKeyEnvNames();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(isSecretSettingName(name)).toBe(true);
  });

  test("AGNI_CUSTOM_KEY_<n> is a secret", () => {
    expect(isSecretSettingName("AGNI_CUSTOM_KEY_3")).toBe(true);
    expect(isSecretSettingName("AGNI_CUSTOM_KEY_")).toBe(true);
  });

  test("a custom provider's own variable is a secret when passed in customEnvKeys", () => {
    expect(isSecretSettingName("MY_WEIRD_THING", { customEnvKeys: ["MY_WEIRD_THING"] })).toBe(true);
    expect(isSecretSettingName("my_weird_thing", { customEnvKeys: new Set(["MY_WEIRD_THING"]) })).toBe(true);
  });

  test("a name in providerEnvNames is a secret", () => {
    expect(isSecretSettingName("ODD_PROVIDER_VAR", { providerEnvNames: ["ODD_PROVIDER_VAR"] })).toBe(true);
  });

  test("an unknown name is a secret", () => {
    expect(isSecretSettingName("MY_WEIRD_THING")).toBe(true);
    expect(isSecretSettingName("SOMETHING_ELSE")).toBe(true);
    expect(isSecretSettingName("")).toBe(true);
  });

  test.each([
    "OPENAI_API_KEY",
    "GITHUB_TOKEN",
    "AGNI_TOKEN",
    "CLIENT_SECRET",
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "AWS_SECRET_ACCESS_KEY",
    "DB_PASSWORD",
    "GMAIL_APP_PASSWORD",
    "SSH_PASSPHRASE",
    "TLS_PRIVATE_KEY",
    "SERVICE_CREDENTIALS",
    "SERVICE_CREDENTIAL",
    "BASIC_AUTH",
    "AUTH_HEADER",
    "AGNI_FIRECRAWL_API_KEY",
  ])("%s matches the pattern", (name) => {
    expect(SECRET_NAME_PATTERN.test(name)).toBe(true);
    expect(isSecretSettingName(name)).toBe(true);
    expect(isSecretEnvForChild(name)).toBe(true);
  });

  test("AUTH is a word part, not a substring", () => {
    expect(SECRET_NAME_PATTERN.test("AUTHOR_NAME")).toBe(false);
  });

  test("names match in any case", () => {
    expect(isSecretSettingName("openrouter_api_key")).toBe(true);
    expect(isSecretSettingName("Agni_Custom_Key_1")).toBe(true);
    expect(isSecretSettingName("agni_port")).toBe(false);
    expect(isSecretSettingName("Agni_Tz")).toBe(false);
  });
});

describe("secret names: plaintext-safe settings", () => {
  test("the known list is non-empty and upper case", () => {
    expect(KNOWN_NON_SECRET_SETTINGS.size).toBeGreaterThan(20);
    for (const name of KNOWN_NON_SECRET_SETTINGS) expect(name).toBe(name.toUpperCase());
  });

  test("each known setting is not a secret", () => {
    for (const name of KNOWN_NON_SECRET_SETTINGS) {
      expect(isSecretSettingName(name)).toBe(false);
      expect(isSecretEnvForChild(name)).toBe(false);
    }
  });

  test("no known setting matches the secret pattern", () => {
    for (const name of KNOWN_NON_SECRET_SETTINGS) expect(SECRET_NAME_PATTERN.test(name)).toBe(false);
  });

  test("the named examples are on the list", () => {
    for (const name of [
      "AGNI_PORT",
      "AGNI_HOST",
      "AGNI_HOME",
      "AGNI_TZ",
      "AGNI_DEV",
      "AGNI_ALLOWED_ORIGINS",
      "AGNI_PUBLIC_ORIGIN",
      "AGNI_SECRETS_MODE",
      "AGNI_SHELL_EXTRA_PATH",
      "AGNI_LOG_LEVEL",
      "AGNI_TURN_TIMEOUT_MS",
      "AGNI_FIRST_TOKEN_TIMEOUT_MS",
      "AGNI_MAX_OUTPUT_TOKENS",
      "AGNI_JOB_CONCURRENCY",
      "GROQ_MODEL",
      "GROQ_BASE_URL",
      "NIM_MODEL",
      "NVIDIA_BASE_URL",
      "LMSTUDIO_MODEL",
      "LMSTUDIO_BASE_URL",
    ]) {
      expect(KNOWN_NON_SECRET_SETTINGS.has(name)).toBe(true);
    }
  });

  test("every catalog provider has its model and base-URL names listed", () => {
    for (const keyName of providerKeyEnvNames()) {
      expect(KNOWN_NON_SECRET_SETTINGS.has(keyName)).toBe(false);
    }
    const base = ["GROQ", "CEREBRAS", "NVIDIA", "GEMINI", "OPENROUTER", "LMSTUDIO"];
    for (const prefix of base) expect(KNOWN_NON_SECRET_SETTINGS.has(`${prefix}_BASE_URL`)).toBe(true);
    for (const prefix of ["GROQ", "CEREBRAS", "NIM", "GEMINI", "OPENROUTER", "LMSTUDIO"]) {
      expect(KNOWN_NON_SECRET_SETTINGS.has(`${prefix}_MODEL`)).toBe(true);
    }
  });

  test("PUBLIC_KEY is not a secret", () => {
    expect(isSecretSettingName("PUBLIC_KEY")).toBe(false);
    expect(isSecretSettingName("SSH_PUBLIC_KEY")).toBe(false);
    expect(isSecretSettingName("public_key")).toBe(false);
    expect(SECRET_NAME_PATTERN.test("PUBLIC_KEY")).toBe(false);
  });

  test("a public-key name that also carries a secret word is still a secret", () => {
    expect(isSecretSettingName("PUBLIC_KEY_PASSWORD")).toBe(true);
    expect(isSecretSettingName("PUBLIC_API_KEY")).toBe(true);
  });

  test("an extra list wins over the known list", () => {
    expect(isSecretSettingName("AGNI_PORT", { customEnvKeys: ["AGNI_PORT"] })).toBe(true);
  });
});
