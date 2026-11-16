/**
 * Keystore backed by `Bun.secrets`: Windows Credential Manager, macOS
 * Keychain, or Linux libsecret (a desktop Secret Service).
 *
 * Only the vault's 32-byte data key goes here (as 44 base64 characters,
 * far under the 2,560-byte value limit measured on Windows), one entry per
 * vault, named by the vault's random id. `Bun.secrets` is experimental, so it
 * is reached only through this file.
 */
import { randomBytes } from "node:crypto";
import { VaultError, type KeyStore, type KeyStoreContext } from "./types";

export const DEFAULT_KEYSTORE_SERVICE = "agni-bot";

interface BunSecrets {
  get(options: { service: string; name: string }): Promise<string | null>;
  set(options: { service: string; name: string; value: string; persist?: "local" | "enterprise" }): Promise<void>;
  delete(options: { service: string; name: string }): Promise<boolean>;
}

function backend(): BunSecrets {
  const secrets = (globalThis as { Bun?: { secrets?: BunSecrets } }).Bun?.secrets;
  if (!secrets) {
    throw new VaultError("KEYSTORE_UNAVAILABLE", "This Bun build has no Bun.secrets, so the operating system's credential store cannot be used. Update Bun, or on a headless server use a passphrase (AGNI_KEYSTORE=passphrase).");
  }
  return secrets;
}

function unavailable(error: unknown, platform = process.platform): VaultError {
  const why = error instanceof Error ? error.message : String(error);
  const hint = platform === "linux"
    ? " On Linux this needs libsecret and a running Secret Service (a desktop session). On a headless server give the vault a passphrase through a systemd credential: LoadCredential=agni-vault-passphrase:<file> in the service unit."
    : platform === "darwin" ? " Unlock the login keychain and allow Agni to use it." : " Check that Windows Credential Manager is available to this account.";
  return new VaultError("KEYSTORE_UNAVAILABLE", `The operating system's credential store could not be used (${why}).${hint}`, { cause: error });
}

export function createBunSecretsKeyStore(options: { service?: string } = {}): KeyStore {
  const service = options.service ?? DEFAULT_KEYSTORE_SERVICE;
  const nameOf = (context: KeyStoreContext): string => `vault-key:${context.vaultId}`;
  return {
    kind: "bun-secrets",
    async open(context) {
      let stored: string | null;
      try {
        stored = await backend().get({ service, name: nameOf(context) });
      } catch (error) {
        if (error instanceof VaultError) throw error;
        throw unavailable(error);
      }
      if (stored === null) return null;
      const key = Buffer.from(stored, "base64");
      if (key.length !== 32) throw new VaultError("DATA_KEY_MISSING", "The vault key in the credential store is damaged (wrong size).");
      return new Uint8Array(key);
    },
    async create(context) {
      const key = new Uint8Array(randomBytes(32));
      try {
        // "local": the default ("enterprise") roams with a domain profile.
        await backend().set({ service, name: nameOf(context), value: Buffer.from(key).toString("base64"), persist: "local" });
        const back = await backend().get({ service, name: nameOf(context) });
        if (back !== Buffer.from(key).toString("base64")) throw new Error("the credential store did not keep the key");
      } catch (error) {
        if (error instanceof VaultError) throw error;
        throw unavailable(error);
      }
      return { key, meta: null };
    },
    async remove(context) {
      try {
        await backend().delete({ service, name: nameOf(context) });
      } catch (error) {
        if (error instanceof VaultError) throw error;
        throw unavailable(error);
      }
    },
  };
}
