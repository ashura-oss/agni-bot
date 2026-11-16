/**
 * Who may talk to this server from a browser.
 *
 * Two checks, both exact (no "any loopback", no wildcard):
 *
 *  - Origin: the page making the request. Only the server's own origin, the
 *    configured web origins (`AGNI_ALLOWED_ORIGINS`, e.g. the Vite dev server)
 *    and `AGNI_PUBLIC_ORIGIN` count. Another site, or another local port the
 *    owner never configured, cannot drive the socket or the HTTP routes.
 *  - Host: the name the request was addressed to. A DNS-rebinding page reaches
 *    this server under its own domain name, so the Host header gives it away:
 *    only the bind address, the loopback names, and the hosts of the origins
 *    above are accepted.
 *
 * Native clients (the CLI, the Mac app) send no Origin and are not affected by
 * the Origin check; they still address the server by its real address.
 */

export interface OriginPolicyOptions {
  /** The address the server binds (`AGNI_HOST`). */
  host: string;
  /** Read when asked, so a server bound to port 0 learns its real port. */
  port: () => number;
  /** `AGNI_PUBLIC_ORIGIN`, e.g. the https name `tailscale serve` publishes. */
  publicOrigin?: string | undefined;
  /** Extra web origins (`AGNI_ALLOWED_ORIGINS`), already parsed. */
  extraOrigins?: readonly string[] | undefined;
}

export interface OriginPolicy {
  /** Is this `Origin` header value one of the allowed pages? */
  originAllowed(origin: string): boolean;
  /** Is this `Host` header value a name this server answers to? */
  hostAllowed(host: string | null | undefined): boolean;
  /**
   * CORS headers for a response: the request's own origin echoed when it is
   * allowed, nothing otherwise. Never `*`.
   */
  cors(request: Request, methods: string, headers: string): Record<string, string>;
  /** A 403 when the request carries a foreign `Origin`; null when it may proceed. */
  rejectForeignOrigin(request: Request): Response | null;
}

const LOOPBACK_BINDS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const WILDCARD_BINDS = new Set(["0.0.0.0", "::", "[::]", "*"]);
const LOOPBACK_NAMES = ["127.0.0.1", "localhost", "[::1]"];

/** The Vite dev server (`bun run web`); its proxy forwards this Origin and Host unchanged. */
const VITE_DEV_ORIGINS = ["http://127.0.0.1:5173", "http://localhost:5173"];

const isLoopbackBind = (host: string): boolean => LOOPBACK_BINDS.has(host.toLowerCase()) || host.startsWith("127.");

/** `AGNI_ALLOWED_ORIGINS`: comma-separated; keeps http(s) origins only, drops paths and junk. */
export function parseOriginList(raw: string | undefined): string[] {
  const origins: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const value = part.trim();
    if (!value) continue;
    try {
      const url = new URL(value);
      if ((url.protocol === "http:" || url.protocol === "https:") && !origins.includes(url.origin)) origins.push(url.origin);
    } catch {
      // Not an origin; ignore it rather than guess.
    }
  }
  return origins;
}

/** The Host header values a URL can arrive as: with and without its default port. */
function hostValues(url: URL): string[] {
  const host = url.host.toLowerCase();
  if (url.port !== "") return [host];
  return [host, `${host}:${url.protocol === "https:" ? 443 : 80}`];
}

function parseURL(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function createOriginPolicy(options: OriginPolicyOptions): OriginPolicy {
  /** Origins and Host values, rebuilt per call because the port may only be known after bind. */
  const allowedSets = (): { origins: Set<string>; hosts: Set<string> } => {
    const origins = new Set<string>();
    const hosts = new Set<string>();
    const add = (value: string | undefined): void => {
      const url = value ? parseURL(value) : null;
      if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return;
      origins.add(url.origin);
      for (const host of hostValues(url)) hosts.add(host);
    };
    const port = options.port();
    const bind = options.host.toLowerCase();
    const names = new Set<string>();
    if (isLoopbackBind(bind) || WILDCARD_BINDS.has(bind)) for (const name of LOOPBACK_NAMES) names.add(name);
    // Only a loopback bind is a developer's machine: it also answers its Vite dev server.
    if (isLoopbackBind(bind)) for (const origin of VITE_DEV_ORIGINS) add(origin);
    if (!WILDCARD_BINDS.has(bind)) names.add(bind.includes(":") && !bind.startsWith("[") ? `[${bind}]` : bind);
    for (const name of names) add(`http://${name}:${port}`);
    add(options.publicOrigin);
    for (const origin of options.extraOrigins ?? []) add(origin);
    return { origins, hosts };
  };

  const originAllowed = (origin: string): boolean => {
    const url = parseURL(origin);
    if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return false;
    return allowedSets().origins.has(url.origin);
  };

  return {
    originAllowed,
    hostAllowed(host) {
      if (!host) return false;
      return allowedSets().hosts.has(host.trim().toLowerCase());
    },
    cors(request, methods, headers) {
      const origin = request.headers.get("origin");
      return {
        ...(origin !== null && originAllowed(origin) ? { "access-control-allow-origin": origin } : {}),
        "access-control-allow-methods": methods,
        "access-control-allow-headers": headers,
        vary: "Origin",
      };
    },
    rejectForeignOrigin(request) {
      const origin = request.headers.get("origin");
      if (origin === null || originAllowed(origin)) return null;
      return Response.json({ error: "forbidden origin" }, { status: 403, headers: { "cache-control": "no-store" } });
    },
  };
}

/**
 * A bind address that leaves browsers locked out is a configuration mistake the
 * owner should hear about at boot, not discover as a wall of 403s. Returns what
 * to log, or null when browsers can reach the server.
 */
export function originConfigProblem(options: {
  host: string;
  port: number;
  publicOrigin?: string | undefined;
  extraOrigins?: readonly string[] | undefined;
}): { level: "error" | "warn"; message: string } | null {
  const bind = options.host.toLowerCase();
  if (isLoopbackBind(bind) || options.publicOrigin || (options.extraOrigins?.length ?? 0) > 0) return null;
  if (WILDCARD_BINDS.has(bind)) {
    return {
      level: "error",
      message:
        `bound to ${options.host}:${options.port}, but only loopback names are accepted in the Host header, so every other client gets 403. ` +
        "Set AGNI_PUBLIC_ORIGIN (the https name a proxy serves) or AGNI_ALLOWED_ORIGINS (comma-separated origins such as http://192.168.1.9:8787) to the address clients use.",
    };
  }
  return {
    level: "warn",
    message:
      `bound to ${options.host}:${options.port}: only ${options.host}:${options.port} is accepted in the Host header. ` +
      "If clients reach this server by another name (MagicDNS, a proxy), set AGNI_PUBLIC_ORIGIN or AGNI_ALLOWED_ORIGINS.",
  };
}

/** A policy that accepts no browser origin at all: what a route gets when no policy is wired in. */
export const NO_BROWSER_ORIGINS: OriginPolicy = createOriginPolicy({ host: "127.0.0.1", port: () => -1, extraOrigins: [] });
