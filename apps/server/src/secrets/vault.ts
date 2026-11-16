/**
 * The unlocked vault: `AGNI_HOME/vault.bin` read into memory, the data key
 * cached, every write an atomic owner-only replace under a cross-process lock
 * that first re-reads the file (so a CLI command and the daemon never lose each
 * other's changes).
 */
import { readFileSync, statSync } from "node:fs";
import { writePrivateFileSync, PrivateFileError } from "../util/private-file";
import { registerSecretFor, releaseSecretFor } from "../util/redact";
import { decodeVault, encodeVault, parseHeader, type StoredEntry, type VaultHeader } from "./format";
import { withFileLock } from "./lock";
import { VAULT_MAX_VALUE_BYTES, VAULT_NAME_PATTERN, VaultError, type Vault, type VaultEntryInfo } from "./types";

/** How often `get` looks at the file to see whether another process changed it. */
const REFRESH_EVERY_MS = 1000;


export function lockPathOf(vaultPath: string): string {
  return `${vaultPath}.lock`;
}

function checkName(name: string): void {
  if (typeof name !== "string" || !VAULT_NAME_PATTERN.test(name)) {
    throw new VaultError("INVALID_ENTRY", "A vault name is 1 to 128 letters, digits and _ . : / @ -, not starting with a separator.");
  }
}

function checkValue(value: string): void {
  if (typeof value !== "string") throw new VaultError("INVALID_ENTRY", "A vault value must be a string.");
  if (Buffer.byteLength(value, "utf8") > VAULT_MAX_VALUE_BYTES) {
    throw new VaultError("INVALID_ENTRY", `A vault value is at most ${VAULT_MAX_VALUE_BYTES} bytes.`);
  }
}

export class FileVault implements Vault {
  private entries = new Map<string, StoredEntry>();
  /** Registers every value of an entry under the holder `vault:<file>:<name>`, so only this entry's own hold is let go of. */
  private holderOf(name: string): string {
    return `vault:${this.path}:${name}`;
  }
  /** An empty value is not a secret and would mask every empty string. */
  private register(name: string, value: string): void {
    if (value !== "") registerSecretFor(this.holderOf(name), value);
  }
  private stamp = "";
  private checkedAt = 0;

  constructor(
    readonly path: string,
    private readonly header: VaultHeader,
    private readonly key: Uint8Array,
  ) {}

  get keystoreKind(): VaultHeader["keystore"] {
    return this.header.keystore;
  }

  /** Read and decrypt the file now, replacing what is in memory. */
  load(): void {
    const bytes = readFileSync(this.path);
    const parsed = parseHeader(bytes);
    if (parsed.header.vaultId !== this.header.vaultId) {
      throw new VaultError("AUTH_FAILED", "vault.bin was replaced by a different vault while Agni was running.");
    }
    const previous = this.heldValues();
    this.entries = decodeVault(bytes, this.key, parsed);
    this.stamp = this.stampOfFile();
    this.checkedAt = Date.now();
    for (const [name, entry] of this.entries) this.register(name, entry.value);
    // Another process changed or removed a value: this one stops masking the old text too.
    this.forgetDropped(previous);
  }

  private heldValues(): Map<string, string> {
    return new Map([...this.entries].map(([name, entry]) => [name, entry.value]));
  }

  /**
   * Let go of values an entry held in `previous` and does not hold now (overwritten or deleted).
   * Without this, a token refreshed every hour adds a registered secret (and its dozens of
   * masked forms) every hour for as long as the server runs. Only this entry's hold is let
   * go of: a value something else also holds stays masked.
   */
  private forgetDropped(previous: Map<string, string>): void {
    for (const [name, value] of previous) if (this.entries.get(name)?.value !== value) releaseSecretFor(this.holderOf(name), value);
  }

  private stampOfFile(): string {
    const info = statSync(this.path);
    return `${info.mtimeMs}:${info.size}`;
  }

  refresh(options?: { force?: boolean }): void {
    this.checkedAt = Date.now();
    if (options?.force || this.stampOfFile() !== this.stamp) this.load();
  }

  private maybeRefresh(): void {
    if (Date.now() - this.checkedAt < REFRESH_EVERY_MS) return;
    try {
      this.refresh();
    } catch (error) {
      // A read that cannot see the file keeps the copy in memory; a writer reports the failure.
      if (error instanceof VaultError && error.code === "AUTH_FAILED") throw error;
    }
  }

  get(name: string): string | undefined {
    this.maybeRefresh();
    const value = this.entries.get(name)?.value;
    if (value !== undefined) this.register(name, value);
    return value;
  }

  has(name: string): boolean {
    this.maybeRefresh();
    return this.entries.has(name);
  }

  list(prefix = ""): VaultEntryInfo[] {
    this.maybeRefresh();
    return [...this.entries.entries()]
      .filter(([name]) => name.startsWith(prefix))
      .map(([name, entry]) => ({ name, updatedAt: entry.updatedAt }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  set(name: string, value: string): void {
    checkName(name);
    checkValue(value);
    this.register(name, value);
    this.mutate((entries) => {
      entries.set(name, { value, updatedAt: new Date().toISOString() });
      return true;
    });
  }

  delete(name: string): boolean {
    checkName(name);
    let existed = false;
    this.mutate((entries) => {
      existed = entries.delete(name);
      return existed;
    });
    return existed;
  }

  /** Lock, reload, change, write. `change` returns false when there is nothing to write. */
  private mutate(change: (entries: Map<string, StoredEntry>) => boolean): void {
    withFileLock(lockPathOf(this.path), () => {
      this.load();
      const previous = this.heldValues();
      if (!change(this.entries)) return;
      try {
        writePrivateFileSync(this.path, encodeVault(this.header, this.key, this.entries));
      } catch (error) {
        this.load();
        const why = error instanceof PrivateFileError ? error.message : `the vault file could not be written (${(error as Error).message})`;
        throw new VaultError("WRITE_FAILED", why, { cause: error });
      }
      this.stamp = this.stampOfFile();
      this.forgetDropped(previous);
    });
  }
}
