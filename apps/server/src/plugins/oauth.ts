/**
 * Google OAuth core for plugin connections.
 *
 * Credentials (client ID/secret) come from plugins.json (oauthClients.google),
 * not .env. The daemon host is the trust boundary; tokens are stored
 * server-side only (plugins.json + the connection row's status).
 */
import { createHash, randomBytes } from "node:crypto";
import type { Config } from "../config";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";

export interface OAuthDeps {
  config: Config;
  clientID: string;
  clientSecret: string;
  /** JSON fetcher injected for tests; production uses global fetch. */
  fetch?: typeof fetch;
}

/** How long a refreshed access token is assumed to work when the provider's answer does not say (Google's are an hour). */
export const DEFAULT_ACCESS_TOKEN_LIFETIME_MS = 3_600_000;

export interface TokenSet {
  refresh_token?: string;
  access_token?: string;
  expires_at?: number;
}

/**
 * Every call that sends a secret to a Google endpoint (token, refresh, revoke) goes through here. Redirects are not followed and
 * not accepted: these endpoints never redirect, and a followed one would carry the
 * client secret, the code verifier, a refresh token or a bearer token to a host the
 * owner never chose. The Location is not repeated in the error.
 */
async function send(deps: Pick<OAuthDeps, "fetch">, url: string, init: RequestInit): Promise<Response> {
  const response = await (deps.fetch ?? fetch)(url, { ...init, redirect: "manual" });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Google answered with a redirect (HTTP ${response.status}); redirects are refused`);
  }
  return response;
}

export function isConfigured(deps: Pick<OAuthDeps, "clientID" | "clientSecret">): boolean {
  return Boolean(deps.clientID && deps.clientSecret);
}

/** The redirect URI Google must have registered as `http://127.0.0.1:<port>/oauth/callback`. */
export function redirectURI(config: Config, port = config.port): string {
  return `http://127.0.0.1:${port}/oauth/callback`;
}

/**
 * A PKCE pair (RFC 7636). The verifier is 43 URL-safe characters from 32 random
 * bytes; the challenge is its S256 hash. Only the challenge goes to the browser.
 */
export function newPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function authorizeURL(deps: OAuthDeps, config: Config, scopes: string[], state: string, codeChallenge: string): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", deps.clientID);
  url.searchParams.set("redirect_uri", redirectURI(config));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "false");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function exchangeCode(deps: OAuthDeps, config: Config, code: string, codeVerifier: string): Promise<TokenSet> {
  const response = await send(deps, TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: deps.clientID,
      client_secret: deps.clientSecret,
      redirect_uri: redirectURI(config),
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
    }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error_description?: string };
    throw new Error(body.error_description ?? `token exchange failed (${response.status})`);
  }
  const data = (await response.json()) as { access_token?: string; expires_in?: number; refresh_token?: string };
  return {
    ...(data.refresh_token ? { refresh_token: data.refresh_token } : {}),
    ...(data.access_token ? { access_token: data.access_token } : {}),
    ...(data.expires_in ? { expires_at: Date.now() + data.expires_in * 1000 } : {}),
  };
}

export async function refresh(
  deps: OAuthDeps,
  refreshToken: string,
): Promise<TokenSet> {
  const response = await send(deps, TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: deps.clientID,
      client_secret: deps.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error_description?: string };
    throw new Error(body.error_description ?? `token refresh failed (${response.status})`);
  }
  const data = (await response.json()) as { access_token?: string; expires_in?: number; refresh_token?: string };
  if (!data.access_token) throw new Error("token refresh returned no access token");
  return {
    access_token: data.access_token,
    // An answer that does not say how long the token lives gets a conservative lifetime. With none stored, every
    // call would see an unknown expiry and refresh again.
    expires_at: Date.now() + (data.expires_in ? data.expires_in * 1000 : DEFAULT_ACCESS_TOKEN_LIFETIME_MS),
    // A provider that rotates refresh tokens names the new one; the caller must store it.
    ...(data.refresh_token ? { refresh_token: data.refresh_token } : {}),
  };
}

export async function revoke(deps: OAuthDeps, token: string): Promise<boolean> {
  const response = await send(deps, REVOKE_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  });
  return response.ok;
}

export async function whoami(
  deps: OAuthDeps,
  accessToken: string,
): Promise<{ email?: string }> {
  // The email is only a label: a redirect (never followed, it would carry the bearer token) just means no label.
  const response = await (deps.fetch ?? fetch)(USERINFO_ENDPOINT, {
    headers: { authorization: `Bearer ${accessToken}` },
    redirect: "manual",
  });
  if (!response.ok) return {};
  const data = (await response.json().catch(() => ({}))) as { email?: string };
  return { email: data.email };
}

/**
 * A usable access token and the time (epoch ms) it stops working, when known. A stored token that is still good is
 * returned with the expiry it was stored with; a refreshed one comes with its own, which the caller must store
 * beside it (the old expiry belongs to the token it replaced), and with the new refresh token when the provider
 * rotated it.
 */
export async function ensureAccessToken(
  deps: OAuthDeps,
  tokens: { access_token?: string; refresh_token?: string; expires_at?: number },
): Promise<{ access_token: string; expires_at?: number; refresh_token?: string }> {
  if (tokens.access_token && tokens.expires_at && tokens.expires_at - 60_000 > Date.now()) {
    return { access_token: tokens.access_token, expires_at: tokens.expires_at };
  }
  if (!tokens.refresh_token) throw new Error("no refresh token stored — reconnect the plugin");
  const fresh = await refresh(deps, tokens.refresh_token);
  return {
    access_token: fresh.access_token!,
    ...(fresh.expires_at === undefined ? {} : { expires_at: fresh.expires_at }),
    ...(fresh.refresh_token ? { refresh_token: fresh.refresh_token } : {}),
  };
}