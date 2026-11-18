/**
 * The egress binding (S2-04). Once a run has read outside text, whatever it
 * sends out must go where the owner said, in the owner's own words in this
 * conversation or in the owner's approved-destinations list. A destination
 * chosen after the bot read a web page or an email is exactly what an attacker
 * would want, so it is never taken from the run itself.
 *
 * The approved list is edited only in Settings (never from a card). It lives
 * in `policy_settings` under `approved_destinations`, a JSON array of strings:
 * an address (`ann@example.com`), a whole domain of addresses
 * (`*@example.com`), a host (`example.com`, which also covers its subdomains).
 */
import type { Database } from "bun:sqlite";
import type { RunContext } from "./types";
import type { ToolResource } from "./tool-meta";
import { normaliseAddress, normaliseURL } from "./resources";

const APPROVED_KEY = "approved_destinations";

/** The owner's approved destinations. Empty when the settings table is not there yet or holds nothing readable. */
export function approvedDestinations(db: Database): string[] {
  try {
    const row = db.query<{ value: string }, [string]>("SELECT value FROM policy_settings WHERE key = ?").get(APPROVED_KEY);
    if (!row) return [];
    const parsed: unknown = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string").map((item) => item.trim().toLowerCase()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

const ADDRESS_CHARS = "a-z0-9._%+'-";

/** Does the owner's text contain this address as a whole address (not as the tail of a longer one)? */
function textNamesAddress(texts: string[], address: string): boolean {
  const pattern = new RegExp(`(?<![${ADDRESS_CHARS}@])${escapeRegex(address)}(?![${ADDRESS_CHARS}])`, "i");
  return texts.some((text) => pattern.test(text));
}

/** A domain written without a scheme. Not after a letter, `@`, `.`, `/` or `:`, so it is never the host of a URL with a scheme or the tail of an address. */
const BARE_DOMAIN = /(?<![\w@./:-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})(?![\w-])/gi;
/** The same, followed by a path: `docs.example.net/guide`. */
const BARE_WITH_PATH = /(?<![\w@./:-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\/[^\s<>"')]*/gi;
const SCHEME_URL = /https?:\/\/[^\s<>"')]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/**
 * Hosts the owner wrote: from URLs with a scheme, and from bare domains that look like one (`www.` in front or a path
 * after). A bare word like `install.sh` or `readme.md` is a file name, not a host (F3). Lower-cased.
 */
export function hostsNamedIn(texts: string[]): Set<string> {
  const hosts = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(SCHEME_URL)) {
      const url = normaliseURL(match[0].replace(TRAILING_PUNCTUATION, ""));
      if (url) hosts.add(new URL(url).hostname.replace(/\.$/, ""));
    }
    for (const match of text.matchAll(BARE_DOMAIN)) {
      const host = match[1]!.toLowerCase();
      const next = text.charAt((match.index ?? 0) + match[0].length);
      if (host.startsWith("www.") || next === "/") hosts.add(host);
    }
  }
  return hosts;
}

/** The whole URLs the owner wrote, normalised. A bare `host/path` counts in both schemes. */
export function urlsNamedIn(texts: string[]): Set<string> {
  const urls = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(SCHEME_URL)) {
      const url = normaliseURL(match[0].replace(TRAILING_PUNCTUATION, ""));
      if (url) urls.add(url);
    }
    for (const match of text.matchAll(BARE_WITH_PATH)) {
      for (const scheme of ["https://", "http://"]) {
        const url = normaliseURL(scheme + match[0].replace(TRAILING_PUNCTUATION, ""));
        if (url) urls.add(url);
      }
    }
  }
  return urls;
}

/** The origins the owner wrote: a URL's own origin; a bare host on the default port, in both schemes. */
export function originsNamedIn(texts: string[]): Set<string> {
  const origins = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(SCHEME_URL)) {
      const url = normaliseURL(match[0].replace(TRAILING_PUNCTUATION, ""));
      if (url) origins.add(new URL(url).origin);
    }
  }
  for (const host of hostsNamedIn(texts)) {
    // A host from a URL with a scheme is already in as that URL's origin; this adds the bare ones.
    if (texts.some((text) => text.toLowerCase().includes(`://${host}`))) continue;
    origins.add(`https://${host}`);
    origins.add(`http://${host}`);
  }
  return origins;
}

/** The host or any subdomain of an entry: only for the owner's approved list, which names whole hosts on purpose. */
function hostCovered(host: string, named: Iterable<string>): boolean {
  for (const base of named) if (host === base || host.endsWith(`.${base}`)) return true;
  return false;
}

/** Is this destination one the owner named, in this conversation or in the approved list? */
export function ownerNamed(run: Pick<RunContext, "ownerText">, destination: ToolResource, approved: string[]): boolean {
  if (destination.kind === "recipient") {
    const address = normaliseAddress(destination.value.toLowerCase());
    const domain = address.split("@")[1] ?? "";
    if (approved.some((entry) => entry === address || (entry.startsWith("*@") && entry.slice(2) === domain))) return true;
    return textNamesAddress(run.ownerText, address);
  }
  if (destination.kind === "host" || destination.kind === "url") {
    const url = destination.kind === "url" ? normaliseURL(destination.value) : null;
    if (destination.kind === "url" && url === null) return false;
    const host = url !== null ? new URL(url).hostname.replace(/\.$/, "") : destination.value.toLowerCase().replace(/\.$/, "");
    // The approved list (Settings) names whole hosts, subdomains included.
    const approvedHosts = approved.filter((entry) => !entry.includes("@")).map((entry) => entry.replace(/^\*\./, ""));
    if (hostCovered(host, approvedHosts)) return true;
    // The owner's words name places to read, not places to send (F3): the exact URL they wrote, or the front page of a host
    // they wrote. Another path, a query or a subdomain of that host could carry what the run read, so it is not named.
    const hosts = hostsNamedIn(run.ownerText);
    if (url === null) return hosts.has(host);
    if (urlsNamedIn(run.ownerText).has(url)) return true;
    // The front page of an origin the owner wrote: same scheme, host and port, no userinfo, no path, no query.
    const parsed = new URL(url);
    return originsNamedIn(run.ownerText).has(parsed.origin) && parsed.username === "" && parsed.password === "" && parsed.pathname === "/" && parsed.search === "";
  }
  return false;
}

/** The destinations of a call that the owner did not name. */
export function unnamedDestinations(run: RunContext, destinations: ToolResource[]): ToolResource[] {
  if (destinations.length === 0) return [];
  const approved = approvedDestinations(run.services.db);
  return destinations.filter((destination) => !ownerNamed(run, destination, approved));
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
