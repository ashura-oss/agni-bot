/**
 * Content-Security-Policy for the HTML this server serves, in the house style
 * of `models/chatgpt-page.ts`: everything denied by default, then only what the
 * page needs. Scripts are never inline, never `eval`, never from another origin.
 */
import { createHash } from "node:crypto";

const FRAME_LOCKDOWN = "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * Browser features no page of this server needs. A page that is somehow
 * compromised, or one embedded by mistake, cannot switch any of them on.
 */
const PERMISSIONS_POLICY = [
  "camera=()", "microphone=()", "geolocation=()", "payment=()", "usb=()", "serial=()",
  "bluetooth=()", "accelerometer=()", "gyroscope=()", "magnetometer=()", "display-capture=()",
].join(", ");

/**
 * Headers every HTML response carries besides the policy itself. `frame-ancestors`
 * in the policy and `X-Frame-Options` say the same thing: older browsers read only the latter.
 */
const HTML_HARDENING = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "permissions-policy": PERMISSIONS_POLICY,
} as const;

/** What a file served next to the app (script, style, image) carries: it must be read as the type it declares. */
export const ASSET_HEADERS = { "x-content-type-options": "nosniff" } as const;

/**
 * A shared thread export: static markup with one `<style>` block and a few
 * inline `style` attributes. No script, no network, no embedding.
 */
export const SHARE_PAGE_HEADERS = {
  ...HTML_HARDENING,
  // A share link is a capability: keep it out of search indexes and archives, and out of other sites' reach.
  "x-robots-tag": "noindex, nofollow, noarchive",
  "cross-origin-resource-policy": "same-origin",
  "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; img-src data:; ${FRAME_LOCKDOWN}`,
} as const;

/** Policy for a page with one fixed `<style>` block and nothing else (the OAuth callback). */
export function staticPageHeaders(style: string): Record<string, string> {
  const hash = createHash("sha256").update(style).digest("base64");
  return {
    ...HTML_HARDENING,
    "content-security-policy": `default-src 'none'; style-src 'sha256-${hash}'; ${FRAME_LOCKDOWN}`,
  };
}

/**
 * The built web app. Scripts and styles come from this origin only; the page
 * may open a socket to the host it was served from and no other. `host` is the
 * request's Host header, which the Host check has already vetted.
 *
 * `style-src` keeps `'unsafe-inline'` because the app sets inline styles;
 * scripts, the dangerous half, stay strict.
 */
export function webAppHeaders(host?: string): Record<string, string> {
  return {
    ...HTML_HARDENING,
    "content-security-policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      host ? `connect-src 'self' ws://${host} wss://${host}` : "connect-src 'self'",
      "worker-src 'self'",
      "manifest-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
  };
}
