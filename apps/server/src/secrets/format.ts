/**
 * The bytes of `vault.bin`.
 *
 *   "AGVT"  4 bytes   magic
 *   version 1 byte    format version (this file: 1)
 *   length  4 bytes   big-endian size of the header
 *   header  JSON      { vaultId, keystore, meta, cipher, createdAt }, in the clear
 *   nonce   12 bytes  fresh random value on every write
 *   body    n bytes   AES-256-GCM ciphertext of {"entries": {...}}
 *   tag     16 bytes  GCM tag
 *
 * Everything before the nonce is the GCM additional data, so a changed header
 * (a swapped keystore kind, another salt) fails the tag. The header holds no
 * secret and no secret name; names are inside the ciphertext.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { VaultError, type KeyStoreKind, type KeyStoreMeta } from "./types";

export const FORMAT_VERSION = 1;
const MAGIC = Buffer.from("AGVT", "latin1");
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_HEADER_BYTES = 16 * 1024;
const FIXED_PREFIX = MAGIC.length + 1 + 4;

export interface VaultHeader {
  vaultId: string;
  keystore: KeyStoreKind;
  meta: KeyStoreMeta | null;
  cipher: "aes-256-gcm";
  createdAt: string;
}

export interface StoredEntry {
  value: string;
  updatedAt: string;
}

export interface ParsedHeader {
  version: number;
  header: VaultHeader;
  /** Offset where the nonce starts; bytes before it are authenticated. */
  bodyStart: number;
}

const corrupt = (why: string): VaultError => new VaultError("VAULT_CORRUPT", `vault.bin is not a valid vault (${why}).`);

const KINDS: readonly string[] = ["bun-secrets", "passphrase", "memory"];

/** Read and check the header without any key. */
export function parseHeader(bytes: Uint8Array): ParsedHeader {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length < FIXED_PREFIX || !buffer.subarray(0, MAGIC.length).equals(MAGIC)) throw corrupt("wrong signature");
  const version = buffer[MAGIC.length]!;
  if (version > FORMAT_VERSION) {
    throw new VaultError("VAULT_VERSION_UNSUPPORTED", `vault.bin is format ${version}; this Agni build reads format ${FORMAT_VERSION}. Update Agni.`);
  }
  if (version < 1) throw corrupt("unknown version");
  const length = buffer.readUInt32BE(MAGIC.length + 1);
  const bodyStart = FIXED_PREFIX + length;
  if (length === 0 || length > MAX_HEADER_BYTES || buffer.length < bodyStart + NONCE_BYTES + TAG_BYTES) throw corrupt("cut short");
  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.subarray(FIXED_PREFIX, bodyStart).toString("utf8"));
  } catch {
    throw corrupt("damaged header");
  }
  const h = parsed as Partial<VaultHeader> | null;
  if (
    !h || typeof h !== "object" || typeof h.vaultId !== "string" || h.vaultId.length < 8 || h.vaultId.length > 64 ||
    typeof h.keystore !== "string" || !KINDS.includes(h.keystore) || h.cipher !== "aes-256-gcm" || typeof h.createdAt !== "string" ||
    (h.meta !== null && (typeof h.meta !== "object" || Array.isArray(h.meta)))
  ) throw corrupt("damaged header");
  return { version, header: h as VaultHeader, bodyStart };
}

/** Encrypt `entries` under `key`. A new nonce every call. */
export function encodeVault(header: VaultHeader, key: Uint8Array, entries: ReadonlyMap<string, StoredEntry>): Buffer {
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const prefix = Buffer.alloc(FIXED_PREFIX);
  MAGIC.copy(prefix, 0);
  prefix[MAGIC.length] = FORMAT_VERSION;
  prefix.writeUInt32BE(headerBytes.length, MAGIC.length + 1);
  const aad = Buffer.concat([prefix, headerBytes]);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const plain = Buffer.from(JSON.stringify({ entries: Object.fromEntries(entries) }), "utf8");
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  plain.fill(0);
  return Buffer.concat([aad, nonce, body, cipher.getAuthTag()]);
}

/** Decrypt and parse. Throws `AUTH_FAILED` for a wrong key or a changed file. */
export function decodeVault(bytes: Uint8Array, key: Uint8Array, parsed: ParsedHeader = parseHeader(bytes)): Map<string, StoredEntry> {
  if (key.length !== 32) throw new VaultError("AUTH_FAILED", "The vault key has the wrong size.");
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nonce = buffer.subarray(parsed.bodyStart, parsed.bodyStart + NONCE_BYTES);
  const body = buffer.subarray(parsed.bodyStart + NONCE_BYTES, buffer.length - TAG_BYTES);
  const tag = buffer.subarray(buffer.length - TAG_BYTES);
  let plain: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(buffer.subarray(0, parsed.bodyStart));
    decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new VaultError("AUTH_FAILED", "vault.bin could not be decrypted: the key is wrong or the file was changed.");
  }
  try {
    const data = JSON.parse(plain.toString("utf8")) as { entries?: Record<string, Partial<StoredEntry>> };
    const out = new Map<string, StoredEntry>();
    for (const [name, entry] of Object.entries(data.entries ?? {})) {
      if (typeof entry?.value !== "string") throw new Error("bad entry");
      out.set(name, { value: entry.value, updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : "" });
    }
    return out;
  } catch {
    throw corrupt("damaged contents");
  } finally {
    plain.fill(0);
  }
}
