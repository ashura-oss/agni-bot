/**
 * Content-Security-Policy for the HTML this server serves, in the house style
 * of `models/chatgpt-page.ts`: everything denied by default, then only what the
 * page needs. Scripts are never inline, never `eval`, never from another origin.
 */
import { createHash } from "node:crypto";

const FRAME_LOCKDOWN = "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Headers every HTML response carries besides the policy itself. */
const HTML_HARDENING = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
} as const;

/**
 * A shared thread export: static markup with one `<style>` block and a few
 * inline `style` attributes. No script, no network, no embedding.
 */
export const SHARE_PAGE_HEADERS = {
  ...HTML_HARDENING,
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
