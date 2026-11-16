/**
 * Which keystore opens or creates a vault. Order:
 *  1. the test override (`setKeyStoreOverride`), so tests never reach the real store;
 *  2. `AGNI_KEYSTORE` = `bun-secrets` or `passphrase` (`auto` is the default);
 *  3. the keystore kind written in an existing vault's header;
 *  4. by platform: a passphrase file present on Linux (a systemd credential)
 *     means headless, so `passphrase`; everything else `bun-secrets`.
 * A choice that disagrees with an existing vault's header is refused, not
 * guessed: opening a vault with the wrong backend would look like a lost key.
 */
import { getKeyStoreOverride } from "./keystore";
import { createBunSecretsKeyStore } from "./bun-secrets";
import { createPassphraseKeyStore, passphraseFileExists, readPassphraseFile } from "./passphrase";
import { VaultError, type KeyStore, type KeyStoreKind } from "./types";

export interface SelectOptions {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  /** `header.keystore` of an existing vault. */
  headerKind?: KeyStoreKind;
}

export function selectKeyStore(options: SelectOptions = {}): KeyStore {
  const override = getKeyStoreOverride();
  if (override) return override;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const asked = (env.AGNI_KEYSTORE?.trim().toLowerCase() || "auto");
  if (asked !== "auto" && asked !== "bun-secrets" && asked !== "passphrase") {
    throw new VaultError("KEYSTORE_UNAVAILABLE", `AGNI_KEYSTORE must be auto, bun-secrets or passphrase (got "${asked}").`);
  }
  const header = options.headerKind;
  if (header === "memory") {
    throw new VaultError("KEYSTORE_MISMATCH", "This vault was made by a test keystore and cannot be opened here.");
  }
  if (asked !== "auto" && header && header !== asked) {
    throw new VaultError("KEYSTORE_MISMATCH", `AGNI_KEYSTORE=${asked}, but this vault was made with ${header}. Unset AGNI_KEYSTORE or use the keystore it was made with.`);
  }
  const kind: KeyStoreKind = asked !== "auto" ? asked : header ?? (platform === "linux" && passphraseFileExists(env) ? "passphrase" : "bun-secrets");
  return kind === "passphrase"
    ? createPassphraseKeyStore({ passphrase: () => readPassphraseFile(env) })
    : createBunSecretsKeyStore();
}
