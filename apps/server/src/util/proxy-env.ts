/**
 * Proxy addresses that carry credentials (`http://user:password@proxy:3128`).
 *
 * A shell child (a command the model wrote) needs the proxy to reach the network, but not the password in it: `echo $HTTPS_PROXY`
 * would print it. `childEnv("shell")` strips the userinfo with `stripProxyUserinfo`, and leaves the variable out when it cannot be sure
 * it did (fail closed). The server itself keeps the whole address, and
 * `registerProxyPasswords` makes `redact()` mask the password wherever the server logs or stores text.
 */
import { registerSecretFor } from "./redact";

/** The variables that hold a proxy address, in either case. (`NO_PROXY` is a list of hosts, not an address.) */
export const PROXY_VARIABLE = /^(?:https?|all|ftp)_proxy$/i;

/** A scheme written out (`http://`), or nothing. An address with none (`host:3128`) is read as `http://host:3128`. */
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
/** Where the authority of an address ends. A WHATWG parser ends it at `\` too (for the schemes it knows). */
const AUTHORITY_END = /[/?#\\]/;

interface Parts {
  scheme: string;
  /** What follows the scheme, up to the first `/`, `?`, `#` or `\`: `user:password@host:port`. */
  authority: string;
  /** From that delimiter on. */
  rest: string;
}

function split(value: string): Parts {
  const scheme = SCHEME.exec(value)?.[0] ?? "";
  const after = value.slice(scheme.length);
  const end = after.search(AUTHORITY_END);
  return end < 0 ? { scheme, authority: after, rest: "" } : { scheme, authority: after.slice(0, end), rest: after.slice(end) };
}

function parseAddress(value: string, scheme: string): URL | null {
  try {
    return new URL(scheme ? value : `http://${value}`);
  } catch {
    return null;
  }
}

/** The text in both of its forms: as written, and percent-decoded when that is different. */
function forms(written: string): string[] {
  const found = [written];
  try {
    const decoded = decodeURIComponent(written);
    if (decoded !== written) found.push(decoded);
  } catch {
    // not percent-encoded text: the written form is all there is
  }
  return found;
}

/**
 * The passwords an address may hold, in the forms they may turn up in text (as written, percent-decoded, and as a URL parser
 * writes them). Where the `user:password` ends is read two ways when an `@` follows the authority (the last `@` of the authority, and
 * the last `@` of the whole address), because a password may hold a `/`, `?` or `#`, and the two readings are then not the same.
 * Masking an extra form costs nothing; missing one leaks.
 */
function passwordsIn(value: string): string[] {
  if (!value.includes("@")) return [];
  const { scheme, authority } = split(value);
  const text = value.slice(scheme.length);
  const found = new Set<string>();
  const addFrom = (userinfo: string): void => {
    const colon = userinfo.indexOf(":");
    if (colon >= 0) for (const form of forms(userinfo.slice(colon + 1))) found.add(form);
  };
  const inAuthority = authority.lastIndexOf("@");
  if (inAuthority >= 0) addFrom(authority.slice(0, inAuthority));
  addFrom(text.slice(0, text.lastIndexOf("@")));
  const parsed = parseAddress(value, scheme);
  if (parsed?.password) for (const form of forms(parsed.password)) found.add(form);
  return [...found].filter((password) => password !== "");
}

/**
 * The proxy address without its `user:password@`, or `null` when that cannot be done with certainty: the variable then has
 * to be left out of the child's environment altogether. An address with no `@` comes back unchanged.
 *
 * The address is parsed as a URL, and a result is only given when the parse and the rebuilt address agree:
 *  - an `@` after the authority (`http://user:pa/ss@host`, `...?x=@...`) cannot be told from a password that holds a `/`, `?` or `#`;
 *  - an address the parser rejects, but that holds an `@`, may hold anything;
 *  - the rebuilt address must parse, name the same host, carry no userinfo, and not contain any password found in the original.
 */
export function stripProxyUserinfo(value: string): string | null {
  if (!value.includes("@")) return value;
  const { scheme, authority, rest } = split(value);
  if (rest.includes("@")) return null;
  const parsed = parseAddress(value, scheme);
  if (!parsed) return null;
  const stripped = `${scheme}${authority.slice(authority.lastIndexOf("@") + 1)}${rest}`;
  const reparsed = parseAddress(stripped, scheme);
  if (!reparsed || reparsed.username || reparsed.password || reparsed.host !== parsed.host) return null;
  if (passwordsIn(value).some((password) => stripped.includes(password))) return null;
  return stripped;
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
