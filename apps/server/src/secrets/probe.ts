/**
 * Can the keystore be used on this machine, and which backend is it? For `agni doctor`, which must answer without
 * opening or making a vault. Nothing is written to the credential store or to the vault: the OS backends are asked
 * for a key that does not exist (a store that works answers "none"; one that does not throws), and the passphrase
 * backend derives a key and keeps nothing. The one write either check can cause is the repair the server makes too:
 * reading a passphrase file that is open to other accounts first closes it to them (the ACL or mode is tightened).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agniHome } from "../home";
import { decodeVault, parseHeader } from "./format";
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

export type VaultKeyCheck =
  | { ok: true; kind: KeyStoreKind; backend: string }
  | { ok: false; kind?: KeyStoreKind; code: VaultErrorCode | "UNKNOWN"; reason: string };

export interface VaultKeyOptions {
  home?: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  /** Use exactly this keystore (tests). Beats the override and platform selection. */
  keystore?: KeyStore;
}

/**
 * Can the server unlock the vault that is in `home`? The same steps `unlockVault` takes, minus everything that
 * writes: read `vault.bin`, choose the keystore its header names, ask it for the data key, and check that key
 * decrypts the file. The answer is held in this function only; no process-wide vault is set, nothing is written to
 * the vault or the credential store, and no secret value leaves it. A vault that is not there is not an error
 * here: callers ask only when `vault.bin` exists.
 */
export async function checkVaultKey(options: VaultKeyOptions = {}): Promise<VaultKeyCheck> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  let store: KeyStore | undefined = options.keystore;
  try {
    const bytes = readFileSync(join(options.home ?? agniHome(env), "vault.bin"));
    const parsed = parseHeader(bytes);
    const kind = parsed.header.keystore;
    store ??= selectKeyStore({ env, platform, headerKind: kind });
    if (store.kind !== kind) {
      throw new VaultError("KEYSTORE_MISMATCH", `This vault was made with the ${kind} keystore; ${store.kind} was selected.`);
    }
    const key = await store.open({ vaultId: parsed.header.vaultId }, parsed.header.meta);
    if (!key) {
      throw new VaultError(
        "DATA_KEY_MISSING",
        "The vault file exists but its key is not in the credential store (a different account or machine, or the entry was deleted).",
      );
    }
    try {
      decodeVault(bytes, key, parsed);
    } catch (error) {
      if (error instanceof VaultError && error.code === "AUTH_FAILED" && kind === "passphrase") {
        throw new VaultError("PASSPHRASE_REJECTED", "The vault passphrase is wrong, or vault.bin was changed.", { cause: error });
      }
      throw error;
    }
    return { ok: true, kind, backend: backendLabel(kind, platform) };
  } catch (error) {
    const code = error instanceof VaultError ? error.code : "UNKNOWN";
    return { ok: false, kind: store?.kind, code, reason: error instanceof Error ? error.message : String(error) };
  }
}
