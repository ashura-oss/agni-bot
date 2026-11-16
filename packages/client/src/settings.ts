/**
 * Where the token and the server address live in a browser.
 *
 * The Mac app used Keychain. A web app has no Keychain: the honest equivalent
 * is this browser's local storage, scoped to the app's origin. The token never
 * leaves the machine except to the daemon it was minted for, and the UI says
 * so. Settings (address, device name, replay cursor) live beside it.
 */

export interface ServerSettings {
  url: string;
  deviceName: string;
  /** Highest server frame seq this browser has seen. */
  lastSeq: number;
}

const SETTINGS_KEY = "dev.agni.web.settings";
const TOKEN_KEY = "dev.agni.web.device-token";

export type SecretStoreKind = "browser" | "memory";

export function defaultServerSettings(): ServerSettings {
  return {
    url: pageOrigin() ?? "127.0.0.1:8787",
    deviceName: browserDeviceName(),
    lastSeq: 0,
  };
}

/** The page's own origin when served over http(s): the daemon serves the web app. */
export function pageOrigin(): string | null {
  if (typeof location === "undefined" || !/^https?:$/.test(location.protocol)) return null;
  return `${location.protocol}//${location.host}`;
}

function browserDeviceName(): string {
  if (typeof navigator === "undefined") return "This Browser";
  const platform = navigator.platform || "";
  if (/Mac/i.test(platform)) return "This Mac";
  if (/Win/i.test(platform)) return "This PC";
  if (/Linux|X11/i.test(platform)) return "This Computer";
  return "This Browser";
}

/** Minimal storage facade so tests (and SSR) do not need a DOM. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

class MemoryStorage implements KeyValueStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function browserStorage(): KeyValueStorage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const probe = "__agni_probe__";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

/**
 * True for a host that can only be reached from this machine: `localhost`,
 * 127.0.0.0/8, `::1` and the IPv4-mapped form of 127.0.0.0/8. Everything else,
 * including 0.0.0.0, private ranges and Tailscale addresses, is remote.
 */
export function isLoopbackHost(host: string): boolean {
  let name = host.trim().toLowerCase();
  if (name.startsWith("[") && name.endsWith("]")) name = name.slice(1, -1);
  if (name.endsWith(".")) name = name.slice(0, -1);
  if (name === "localhost" || name === "::1") return true;
  if (isLoopbackIPv4(name)) return true;
  const mappedDotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(name);
  if (mappedDotted) return isLoopbackIPv4(mappedDotted[1]!);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(name);
  if (mappedHex) return (Number.parseInt(mappedHex[1]!, 16) >> 8) === 127;
  return false;
}

function isLoopbackIPv4(name: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) && octets[0] === 127;
}

export type WebsocketURLCheck = { ok: true; url: string } | { ok: false; reason: string };

const NOT_A_SERVER_ADDRESS = "That server address is not a websocket URL.";

function cleartextRemoteReason(host: string): string {
  return (
    `Refusing a cleartext connection to ${host}: ws:// and http:// are only allowed for this machine ` +
    "(127.0.0.1, ::1, localhost) because anyone on the network could read the token and the conversation. " +
    "Use wss:// or https:// (for example through a TLS proxy or Tailscale Serve)."
  );
}

/**
 * Accept host[:port], http(s)://…, ws(s)://… — people type all four.
 *
 * Security policy (S3-10): cleartext is allowed only for loopback hosts.
 * A bare host means the daemon's default port, over `ws://` for loopback and
 * `wss://` for anything else. A typed scheme keeps its own (so a real wss://
 * endpoint is not dragged onto 8787), but an explicit `ws://` or `http://` to a
 * remote host is refused with a reason rather than silently upgraded.
 */
export function checkWebsocketURL(settings: Pick<ServerSettings, "url">): WebsocketURLCheck {
  const trimmed = settings.url.trim();
  if (trimmed.length === 0) return { ok: false, reason: NOT_A_SERVER_ADDRESS };

  const typedScheme = trimmed.includes("://");
  let text = trimmed;
  if (!typedScheme) text = `ws://${text}`;
  if (text.startsWith("http://")) text = `ws://${text.slice("http://".length)}`;
  if (text.startsWith("https://")) text = `wss://${text.slice("https://".length)}`;

  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return { ok: false, reason: NOT_A_SERVER_ADDRESS };
  }
  if (parsed.hostname.length === 0) return { ok: false, reason: NOT_A_SERVER_ADDRESS };
  if (parsed.protocol !== "wss:" && parsed.protocol !== "ws:") return { ok: false, reason: NOT_A_SERVER_ADDRESS };

  const loopback = isLoopbackHost(parsed.hostname);
  if (!loopback) {
    if (!typedScheme) parsed.protocol = "wss:";
    else if (parsed.protocol === "ws:") return { ok: false, reason: cleartextRemoteReason(parsed.hostname) };
  }

  // `new URL` drops a port equal to the scheme default, so read the typed one from the text.
  const authority = (text.split("://")[1] ?? "").split(/[/?#]/)[0]!.split("@").pop()!;
  const typedPort = /:\d+$/.test(authority);
  if (parsed.pathname === "" || parsed.pathname === "/") parsed.pathname = "/ws";
  if (!typedScheme && !typedPort) parsed.port = "8787";
  return { ok: true, url: parsed.toString() };
}

/** `checkWebsocketURL` for callers that only need the address (null when refused). */
export function websocketURL(settings: Pick<ServerSettings, "url">): string | null {
  const checked = checkWebsocketURL(settings);
  return checked.ok ? checked.url : null;
}

export function healthURL(settings: Pick<ServerSettings, "url">): string | null {
  const ws = websocketURL(settings);
  if (!ws) return null;
  const parsed = new URL(ws);
  parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
  parsed.pathname = "/health";
  parsed.search = "";
  return parsed.toString();
}

export class SettingsStore {
  constructor(private readonly storage: KeyValueStorage = browserStorage() ?? new MemoryStorage()) {}

  load(): ServerSettings {
    const raw = this.storage.getItem(SETTINGS_KEY);
    if (!raw) return defaultServerSettings();
    try {
      const value = JSON.parse(raw) as Partial<ServerSettings>;
      if (typeof value.url !== "string" || typeof value.deviceName !== "string") {
        return defaultServerSettings();
      }
      return {
        url: value.url,
        deviceName: value.deviceName,
        lastSeq: typeof value.lastSeq === "number" && Number.isFinite(value.lastSeq) ? value.lastSeq : 0,
      };
    } catch {
      return defaultServerSettings();
    }
  }

  save(settings: ServerSettings): void {
    try {
      this.storage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // Private mode / quota: settings just do not survive a reload.
    }
  }
}

/**
 * Device token storage.
 *
 * Plan (S3-10): the web app will authenticate with the cookie session the
 * daemon sets at pairing, and keep no token in `localStorage` (any script on
 * the page can read it). The `localStorage` token stays for non-browser
 * clients and as the one-time hand-over for browsers paired before the switch.
 * `persistToken` is the switch: it defaults to true, which is today's web
 * behaviour, and the web app calls `SecretStore.configure({ persistToken:
 * false })` in the later web-side task. With it off, nothing is read from or
 * written to browser storage; a token held for this page load lives in memory
 * only. `legacyToken()` still reads the old value so the web app can exchange
 * it for a cookie session once, then `clear()` removes it.
 *
 * When storage is unavailable the token also stays in memory (`memory`).
 */
export const SecretStore = {
  memoryToken: null as string | null,
  memoryKind: "memory" as SecretStoreKind,
  persistsToken: true,

  configure(options: { persistToken: boolean }): void {
    this.persistsToken = options.persistToken;
  },

  /** The token an earlier version left in browser storage, whatever the mode. */
  legacyToken(): string | null {
    const token = browserStorage()?.getItem(TOKEN_KEY)?.trim();
    return token ? token : null;
  },

  load(): { token: string; kind: SecretStoreKind } | null {
    if (this.persistsToken) {
      const token = this.legacyToken();
      if (token) return { token, kind: "browser" };
    }
    if (this.memoryToken) return { token: this.memoryToken, kind: "memory" };
    return null;
  },

  save(token: string): SecretStoreKind {
    const trimmed = token.trim();
    const storage = browserStorage();
    if (!this.persistsToken) {
      // Cookie-session mode: never keep a token in browser storage, and drop an old one.
      try {
        storage?.removeItem(TOKEN_KEY);
      } catch {
        // Nothing to remove if storage is unusable.
      }
    } else if (storage) {
      try {
        storage.setItem(TOKEN_KEY, trimmed);
        return "browser";
      } catch {
        // fall through to memory
      }
    }
    this.memoryToken = trimmed;
    return "memory";
  },

  clear(): void {
    const storage = browserStorage();
    storage?.removeItem(TOKEN_KEY);
    this.memoryToken = null;
  },
};
