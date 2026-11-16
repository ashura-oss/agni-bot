/**
 * An in-process keystore for tests. Nothing is written anywhere: the keys live
 * in a Map owned by the instance. The test preload installs one of these as the
 * process-wide override (`setKeyStoreOverride`), so no test can reach the real
 * credential store by accident.
 */
import { randomBytes } from "node:crypto";
import type { KeyStore, KeyStoreContext } from "./types";

export interface MemoryKeyStore extends KeyStore {
  readonly kind: "memory";
  /** Number of keys held. */
  size(): number;
  /** Drop every key, as if the credential store had been wiped. */
  clear(): void;
}

export function createMemoryKeyStore(): MemoryKeyStore {
  const keys = new Map<string, Uint8Array>();
  return {
    kind: "memory",
    async open(context: KeyStoreContext) {
      const key = keys.get(context.vaultId);
      return key ? new Uint8Array(key) : null;
    },
    async create(context: KeyStoreContext) {
      const key = new Uint8Array(randomBytes(32));
      keys.set(context.vaultId, new Uint8Array(key));
      return { key, meta: null };
    },
    async remove(context: KeyStoreContext) {
      keys.delete(context.vaultId);
    },
    size: () => keys.size,
    clear: () => keys.clear(),
  };
}
