/**
 * S3-10 (client part): cleartext ws:// is refused for any non-loopback host,
 * and the localStorage token path is switchable for the cookie-session plan.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  AgniConnection,
  TransportError,
  checkWebsocketURL,
  healthURL,
  isLoopbackHost,
  websocketURL,
  SecretStore,
  type ConnectionState,
  type FrameTransport,
  type KeyValueStorage,
} from "../src";

describe("isLoopbackHost", () => {
  test.each(["localhost", "LOCALHOST", "localhost.", "127.0.0.1", "127.255.255.254", "[::1]", "::1", "[::ffff:127.0.0.1]"])(
    "%s is loopback",
    (host) => expect(isLoopbackHost(host)).toBe(true),
  );
  test.each([
    "100.64.1.7",
    "192.168.1.5",
    "10.0.0.1",
    "0.0.0.0",
    "128.0.0.1",
    "agni.example",
    "127.0.0.1.evil.example",
    "localhost.evil.example",
    "[::2]",
    "[::ffff:10.0.0.1]",
    "",
  ])("%s is not loopback", (host) => expect(isLoopbackHost(host)).toBe(false));
});

describe("websocket address policy", () => {
  test("loopback keeps cleartext ws://", () => {
    expect(websocketURL({ url: "127.0.0.1:8787" })).toBe("ws://127.0.0.1:8787/ws");
    expect(websocketURL({ url: "localhost" })).toBe("ws://localhost:8787/ws");
    expect(websocketURL({ url: "http://127.0.0.1:8787" })).toBe("ws://127.0.0.1:8787/ws");
    expect(websocketURL({ url: "ws://[::1]:8787/ws" })).toBe("ws://[::1]:8787/ws");
    expect(websocketURL({ url: "ws://127.5.4.3:9000" })).toBe("ws://127.5.4.3:9000/ws");
  });

  test("a bare non-loopback host defaults to wss://", () => {
    expect(websocketURL({ url: "100.64.1.7" })).toBe("wss://100.64.1.7:8787/ws");
    expect(websocketURL({ url: "agni.example" })).toBe("wss://agni.example:8787/ws");
    expect(websocketURL({ url: "agni.example:443" })).toBe("wss://agni.example/ws"); // 443 is the wss default
    expect(websocketURL({ url: "agni.example:9443" })).toBe("wss://agni.example:9443/ws");
  });

  test("encrypted schemes to remote hosts are accepted", () => {
    expect(websocketURL({ url: "wss://agni.example/ws" })).toBe("wss://agni.example/ws");
    expect(websocketURL({ url: "https://agni.example" })).toBe("wss://agni.example/ws");
  });

  test("explicit cleartext to a remote host is refused with a clear error", () => {
    for (const url of ["ws://100.64.1.7:8787/ws", "http://100.64.1.7:8787", "ws://agni.example", "http://192.168.1.5"]) {
      expect(websocketURL({ url })).toBeNull();
      const checked = checkWebsocketURL({ url });
      expect(checked.ok).toBe(false);
      if (!checked.ok) {
        expect(checked.reason).toContain("cleartext");
        expect(checked.reason).toContain("wss://");
        expect(checked.reason).toContain("127.0.0.1");
      }
    }
    expect(healthURL({ url: "ws://100.64.1.7:8787/ws" })).toBeNull();
  });

  test("a hostname that merely starts like loopback is remote", () => {
    expect(websocketURL({ url: "ws://127.0.0.1.evil.example/ws" })).toBeNull();
    expect(websocketURL({ url: "ws://localhost.evil.example/ws" })).toBeNull();
    expect(websocketURL({ url: "ws://user@127.0.0.1.evil.example/ws" })).toBeNull();
  });

  test("other failures keep their own message", () => {
    const empty = checkWebsocketURL({ url: "  " });
    expect(empty.ok).toBe(false);
    const ftp = checkWebsocketURL({ url: "ftp://agni.example" });
    expect(ftp.ok).toBe(false);
    if (!ftp.ok) expect(ftp.reason).not.toContain("cleartext");
    const ok = checkWebsocketURL({ url: "127.0.0.1" });
    expect(ok).toEqual({ ok: true, url: "ws://127.0.0.1:8787/ws" });
  });

  test("health URL follows the same policy", () => {
    expect(healthURL({ url: "127.0.0.1:8787" })).toBe("http://127.0.0.1:8787/health");
    expect(healthURL({ url: "agni.example" })).toBe("https://agni.example:8787/health");
  });
});

class IdleTransport implements FrameTransport {
  opened: string[] = [];
  async open(url: string): Promise<void> {
    this.opened.push(url);
  }
  async send(): Promise<void> {}
  async receive(): Promise<string> {
    throw TransportError.closed(4003, "no");
  }
  async close(): Promise<void> {}
}

describe("connection refuses cleartext remote", () => {
  test("never opens a socket and reports why", async () => {
    const transport = new IdleTransport();
    const states: ConnectionState[] = [];
    const connection = new AgniConnection({
      settings: { url: "ws://100.64.1.7:8787/ws", deviceName: "t", lastSeq: 0 },
      token: "agni_secret_token",
      makeTransport: () => transport,
    });
    connection.onEvent = (event) => {
      if (event.type === "state") states.push(event.state);
    };
    connection.start();
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && connection.state.kind !== "refused") {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    connection.stop();
    expect(transport.opened).toEqual([]);
    const refused = states.find((state) => state.kind === "refused");
    expect(refused && refused.kind === "refused" ? refused.reason : "").toContain("cleartext");
  });
});

class FakeLocalStorage implements KeyValueStorage {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

describe("SecretStore token path", () => {
  const original = (globalThis as { localStorage?: unknown }).localStorage;
  let storage: FakeLocalStorage;

  beforeEach(() => {
    storage = new FakeLocalStorage();
    (globalThis as { localStorage?: unknown }).localStorage = storage;
    SecretStore.memoryToken = null;
    SecretStore.configure({ persistToken: true });
  });
  afterEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = original;
    SecretStore.memoryToken = null;
    SecretStore.configure({ persistToken: true });
  });

  test("default keeps today's behaviour: token persists in browser storage", () => {
    expect(SecretStore.save(" tok ")).toBe("browser");
    expect(storage.map.size).toBe(1);
    expect(SecretStore.load()).toEqual({ token: "tok", kind: "browser" });
  });

  test("cookie-session mode never writes or reads the token from storage", () => {
    SecretStore.configure({ persistToken: false });
    expect(SecretStore.persistsToken).toBe(false);
    expect(SecretStore.save("tok")).toBe("memory");
    expect(storage.map.size).toBe(0);
    expect(SecretStore.load()).toEqual({ token: "tok", kind: "memory" });
  });

  test("cookie-session mode ignores a legacy stored token but can hand it over once", () => {
    SecretStore.save("legacy");
    SecretStore.configure({ persistToken: false });
    expect(SecretStore.load()).toBeNull();
    expect(SecretStore.legacyToken()).toBe("legacy");
    SecretStore.clear();
    expect(SecretStore.legacyToken()).toBeNull();
    expect(storage.map.size).toBe(0);
  });

  test("switching to cookie-session mode does not leave a saved token behind", () => {
    SecretStore.save("legacy");
    SecretStore.configure({ persistToken: false });
    SecretStore.save("fresh");
    expect(storage.map.size).toBe(0);
  });
});
