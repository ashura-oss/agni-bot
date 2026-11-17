/**
 * Proxy addresses that carry credentials (`http://user:password@proxy:3128`).
 *
 * A shell child (a command the model wrote) needs the proxy to reach the network, but not the password in it: `echo $HTTPS_PROXY`
 * would print it. `childEnv("shell")` strips the userinfo with `stripProxyUserinfo`. The server itself keeps the whole address, and
 * `registerProxyPasswords` makes `redact()` mask the password wherever the server logs or stores text.
 */
import { registerSecretFor } from "./redact";

/** The variables that hold a proxy address, in either case. (`NO_PROXY` is a list of hosts, not an address.) */
export const PROXY_VARIABLE = /^(?:https?|all|ftp)_proxy$/i;

/** Scheme (if any), then the authority: everything up to the first `/`, `?` or `#`. The userinfo is before the last `@` in it. */
const ADDRESS = /^((?:[a-z][a-z0-9+.-]*:\/\/)?)([^/?#]*)/i;

/** The proxy address without its `user:password@`. An address that has none comes back unchanged. */
export function stripProxyUserinfo(value: string): string {
  const match = ADDRESS.exec(value);
  if (!match) return value;
  const [whole, scheme = "", authority = ""] = match;
  const at = authority.lastIndexOf("@");
  return at < 0 ? value : `${scheme}${authority.slice(at + 1)}${value.slice(whole.length)}`;
}

/** The password in a proxy address (as written, and percent-decoded when that is different), or none. */
function passwordsIn(value: string): string[] {
  const match = ADDRESS.exec(value);
  const authority = match?.[2] ?? "";
  const at = authority.lastIndexOf("@");
  if (at < 0) return [];
  const userinfo = authority.slice(0, at);
  const colon = userinfo.indexOf(":");
  if (colon < 0) return [];
  const written = userinfo.slice(colon + 1);
  const found = [written];
  try {
    const decoded = decodeURIComponent(written);
    if (decoded !== written) found.push(decoded);
  } catch {
    // not percent-encoded text: the written form is all there is
  }
  return found.filter((password) => password !== "");
}

/** Every proxy password in `env`, in the forms it may turn up in text. */
export function proxyPasswords(env: Record<string, string | undefined> = process.env): string[] {
  const found = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string" || !PROXY_VARIABLE.test(name)) continue;
    for (const password of passwordsIn(value)) found.add(password);
  }
  return [...found];
}

/** Mask the proxy passwords in `env` from now on. A password too short to mask safely is skipped by the registry, like any secret. */
export function registerProxyPasswords(env: Record<string, string | undefined> = process.env): void {
  for (const password of proxyPasswords(env)) registerSecretFor("proxy-credentials", password);
}
