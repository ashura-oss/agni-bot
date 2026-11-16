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
import { normaliseAddress } from "./resources";

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

/** Hosts the owner wrote: from URLs and from bare domains. Lower-cased. */
export function hostsNamedIn(texts: string[]): Set<string> {
  const hosts = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(/https?:\/\/([^\s/:?#<>"')]+)/gi)) hosts.add(match[1]!.toLowerCase().replace(/\.$/, ""));
    for (const match of text.matchAll(/(?<![\w@.-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})(?![\w-])/gi)) hosts.add(match[1]!.toLowerCase());
  }
  return hosts;
}

function hostCovered(host: string, named: Iterable<string>): boolean {
  for (const base of named) if (host === base || host.endsWith(`.${base}`)) return true;
  return false;
}

/** Is this destination one the owner named, in this conversation or in the approved list? */
export function ownerNamed(run: Pick<RunContext, "ownerText">, destination: ToolResource, approved: string[]): boolean {
  const value = destination.value.toLowerCase();
  if (destination.kind === "recipient") {
    const address = normaliseAddress(value);
    const domain = address.split("@")[1] ?? "";
    if (approved.some((entry) => entry === address || (entry.startsWith("*@") && entry.slice(2) === domain))) return true;
    return textNamesAddress(run.ownerText, address);
  }
  if (destination.kind === "host" || destination.kind === "url") {
    const host = destination.kind === "url" ? value.replace(/^https?:\/\//, "").split(/[/?#]/)[0]! : value;
    const named = hostsNamedIn(run.ownerText);
    for (const entry of approved) if (!entry.includes("@")) named.add(entry.replace(/^\*\./, ""));
    return hostCovered(host, named);
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
