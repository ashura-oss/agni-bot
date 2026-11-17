/**
 * Choosing the keystore. Backends sit behind the `KeyStore` interface because
 * `Bun.secrets` is experimental: swapping it for another backend must not touch
 * the vault.
 */
import type { KeyStore } from "./types";

export type { KeyStore, KeyStoreContext, KeyStoreKind, KeyStoreMeta } from "./types";

let override: KeyStore | null = null;

/**
 * Make every `selectKeyStore()` return `store` (tests: the preload installs a
 * memory keystore). `null` removes it. An explicit `VaultOptions.keystore`
 * still wins.
 */
export function setKeyStoreOverride(store: KeyStore | null): void {
  override = store;
}

export function getKeyStoreOverride(): KeyStore | null {
  return override;
}
