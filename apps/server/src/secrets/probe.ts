/**
 * Can the keystore be used on this machine, and which backend is it? For `agni doctor`, which must answer without
 * opening or making a vault. Nothing is written to the credential store: the OS backends are asked for a key that
 * does not exist (a store that works answers "none"; one that does not throws), and the passphrase backend derives a
 * key and keeps nothing.
 */
import { randomUUID } from "node:crypto";
import { selectKeyStore } from "./select";
import { VaultError, type KeyStore, type KeyStoreKind, type VaultErrorCode } from "./types";

export type KeyStoreProbe =
  | { available: true; kind: KeyStoreKind; backend: string }
  | { available: false; kind?: KeyStoreKind; reason: string; code: VaultErrorCode | "UNKNOWN" };

export interface ProbeOptions {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  /** `header.keystore` of an existing vault: the probe checks the backend that vault needs. */
  headerKind?: KeyStoreKind;
  /** Probe exactly this keystore (tests). Beats the override and platform selection. */
  keystore?: KeyStore;
}

/** Plain-words name of a backend, for the screen. */
export function backendLabel(kind: KeyStoreKind, platform: NodeJS.Platform = process.platform): string {
  if (kind === "passphrase") return "passphrase file (a systemd credential or AGNI_VAULT_PASSPHRASE_FILE)";
  if (kind === "memory") return "in-memory test keystore";
  if (platform === "win32") return "Windows Credential Manager";
  if (platform === "darwin") return "macOS Keychain";
  return "Linux Secret Service (libsecret)";
}

export async function probeKeyStore(options: ProbeOptions = {}): Promise<KeyStoreProbe> {
  const platform = options.platform ?? process.platform;
  let store: KeyStore | undefined = options.keystore;
  try {
    store ??= selectKeyStore({ env: options.env, platform, headerKind: options.headerKind });
    const context = { vaultId: randomUUID() };
    if (store.kind === "bun-secrets") await store.open(context, null);
    else if (store.kind === "passphrase") await store.create(context);
    return { available: true, kind: store.kind, backend: backendLabel(store.kind, platform) };
  } catch (error) {
    const code = error instanceof VaultError ? error.code : "UNKNOWN";
    return { available: false, kind: store?.kind, reason: error instanceof Error ? error.message : String(error), code };
  }
}
